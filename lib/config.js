/**
 * Configuration: shape, defaults, and validation.
 *
 * This module is the only place that knows what a configuration means. It runs
 * at mount, on every request, and in a test — there is no second code path that
 * could disagree.
 *
 * The single most important job here is {@link normalizeBaseURL}: the gateway
 * address must be reduced to a **prefix** that endpoints are appended to. A
 * pasted full endpoint (`…/v1/chat/completions`) is the exact mistake that makes
 * the sibling pi-ai route 404, because the OpenAI SDK appends `/chat/completions`
 * unconditionally and would produce `…/chat/completions/chat/completions`.
 *
 * @module dsh-opencode-live/config
 */

/** A configuration the plugin refuses to act on. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * The prefix this route talks to unless the deployment says otherwise.
 *
 * Note the absence of a trailing endpoint: this is a base, not a URL to POST to.
 * `/zen/go` is kept (rather than the newer `/inference/go`) because the listing
 * endpoint and all three chat dialects answer there today; a deployment that
 * must use the other spelling can say so.
 */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'

/** The route id registered by default. Must not collide with `opencode-go`. */
export const DEFAULT_ROUTE = 'opencode-live'

/** The display name shown in the model picker. */
export const DEFAULT_DISPLAY_NAME = 'OpenCode Go · 实时目录'

/** Credential references consulted, in order, when `apiKey` is empty. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** OpenCode Zen 免费模型车道的默认路由 ID。 */
export const DEFAULT_ZEN_ROUTE = 'opencode-zen-free'

/** OpenCode Zen 免费模型车道在模型选择器中展示的名称。 */
export const DEFAULT_ZEN_DISPLAY_NAME = 'OpenCode Zen · 免费模型'

/** OpenCode Zen 免费模型的默认接入端点（注意 /zen/v1 对免费模型返回 403，必须使用 /inference/v1）。 */
export const DEFAULT_ZEN_BASE_URL = 'https://opencode.ai/inference/v1'

/** OpenCode Zen 免费模型的默认配置。 */
export const DEFAULT_ZEN_CONFIG = Object.freeze({
  enabled: true,
  route: DEFAULT_ZEN_ROUTE,
  displayName: DEFAULT_ZEN_DISPLAY_NAME,
  baseURL: DEFAULT_ZEN_BASE_URL,
  apiKey: 'public',
  visibleModels: undefined,
  modelProtocols: Object.freeze({}),
  modelSettings: Object.freeze({}),
})

/** The listing path, appended to the normalized prefix. */
const MODELS_PATH = '/models'

/**
 * Endpoint suffixes a full URL may already carry, longest first so
 * `/chat/completions` is stripped before `/completions` could be considered.
 */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/responses', '/messages', '/models']

/**
 * Reduce a pasted gateway address to the prefix endpoints are appended to.
 *
 * Four things happen here, each one a mistake a person pasting a URL makes:
 *
 * - surrounding whitespace is trimmed (a YAML value like `" https://…"` keeps
 *   its leading space, and the OpenAI SDK does not trim it);
 * - a trailing slash is dropped, so `…/v1/` and `…/v1` address one endpoint
 *   rather than producing `//chat/completions`;
 * - a query string or fragment is dropped, because neither belongs on a
 *   streaming POST;
 * - a full endpoint (`…/v1/chat/completions`) is reduced to its prefix, so a URL
 *   copied from a provider's docs works instead of producing a doubled path.
 *
 * The scheme is checked rather than assumed: a typo like `htps://` must not
 * become a request to a host nobody named.
 *
 * @param {unknown} value
 * @returns {string} the normalized prefix, with no trailing slash.
 * @throws {ConfigError} when the value is not an http(s) address.
 */
export function normalizeBaseURL(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new ConfigError('baseURL 不能为空')

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`baseURL 不是合法地址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`baseURL 必须以 http:// 或 https:// 开头，收到的是 ${url.protocol}//`)
  }

  url.search = ''
  url.hash = ''
  let prefix = url.toString().replace(/\/+$/, '')

  // Strip an endpoint a deployment pasted in full. Repeated so a doubled
  // suffix (`…/chat/completions/chat/completions`) also reduces to its base.
  for (let changed = true; changed;) {
    changed = false
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (prefix.toLowerCase().endsWith(suffix)) {
        prefix = prefix.slice(0, -suffix.length).replace(/\/+$/, '')
        changed = true
        break
      }
    }
  }
  return prefix
}

/**
 * The listing endpoint for a prefix.
 *
 * Goes through {@link endpointOf} rather than appending by hand, so a prefix that
 * already carries `/v1` does not produce `/v1/v1/models` — the mistake that made
 * the first live run 404.
 *
 * @param {string} prefix - a normalized prefix.
 * @returns {string}
 */
export function modelsEndpoint(prefix) {
  return endpointOf(prefix, MODELS_PATH)
}

/**
 * True when the prefix already carries the `/v1` segment the endpoint suffixes
 * assume, so callers can join without doubling it.
 *
 * @param {string} prefix
 * @returns {boolean}
 */
export function hasVersionSegment(prefix) {
  return /\/v\d+$/i.test(String(prefix).replace(/\/+$/, ''))
}

/**
 * Join a prefix with an endpoint path, tolerating a prefix that already ends in
 * `/v1` and one that does not.
 *
 * @param {string} prefix - a normalized prefix.
 * @param {string} path - an endpoint path such as `/chat/completions`.
 * @returns {string}
 */
export function endpointOf(prefix, path) {
  const base = String(prefix).replace(/\/+$/, '')
  const suffix = String(path).startsWith('/') ? path : `/${path}`
  if (hasVersionSegment(base) || suffix.startsWith('/v1/')) return `${base}${suffix}`
  return `${base}/v1${suffix}`
}

/** The fields a `models` entry may carry. */
const MODEL_FIELDS = ['id', 'name', 'description', 'contextWindow', 'maxTokens', 'vision', 'protocol']

/** The wire protocols this route can speak, in preference order. */
export const PROTOCOLS = Object.freeze(['chat-completions', 'responses', 'anthropic-messages'])
/** Every spelling of a protocol this configuration accepts. */
export const PROTOCOL_ALIASES = Object.freeze({
  'chat-completions': 'chat-completions',
  'openai-completions': 'chat-completions',
  'openai-chat-completions': 'chat-completions',
  'chat': 'chat-completions',
  'completions': 'chat-completions',
  'responses': 'responses',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic-messages',
  'messages': 'anthropic-messages',
  'anthropic': 'anthropic-messages',
})

/**
 * Resolve any accepted spelling to a canonical protocol name.
 *
 * @param {unknown} value
 * @returns {string|null} the canonical name, or null when nothing matches.
 */
export function canonicalProtocol(value) {
  if (typeof value !== 'string') return null
  return PROTOCOL_ALIASES[value.trim().toLowerCase()] ?? null
}

/** A positive integer, or undefined. */
function positiveInt(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** A trimmed non-empty string, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A de-duplicated list of trimmed non-empty strings. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const item = text(raw)
    if (item === undefined || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Normalize one `models` entry.
 *
 * `protocol` is optional: a model with no declared protocol is dialled on
 * `chat-completions`, the dialect almost every gateway model accepts. An
 * unrecognized value is refused rather than silently defaulted, because a model
 * sent to the wrong endpoint fails with an opaque 400 from the gateway.
 *
 * @param {unknown} raw
 * @param {number} index - position, for the error message.
 * @returns {object}
 * @throws {ConfigError}
 */
function normalizeModel(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`models[${index}] 不是对象`)
  }
  const entry = /** @type {Record<string, unknown>} */ (raw)
  const id = text(entry.id)
  if (id === undefined) throw new ConfigError(`models[${index}].id 不能为空`)

  const protocol = entry.protocol === undefined ? undefined : canonicalProtocol(entry.protocol)
  if (entry.protocol !== undefined && protocol === null) {
    throw new ConfigError(
      `models[${index}].protocol 只能是 ${PROTOCOLS.join(' / ')}，收到的是 ${String(entry.protocol)}`,
    )
  }

  return {
    id,
    name: text(entry.name) ?? id,
    description: text(entry.description) ?? '',
    contextWindow: positiveInt(entry.contextWindow),
    maxTokens: positiveInt(entry.maxTokens),
    vision: entry.vision === true,
    protocol,
  }
}

/**
 * The fallback roster: empty.
 *
 * This route deliberately ships no models. Its whole premise is that the
 * gateway's listing decides what it serves; a built-in roster would be exactly
 * the stale snapshot this plugin exists to avoid. A deployment that wants the
 * route usable before its first refresh can declare `models` by hand.
 */
export const DEFAULT_MODELS = Object.freeze([])

/** Every field of a normalized configuration, and its default. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  route: DEFAULT_ROUTE,
  displayName: DEFAULT_DISPLAY_NAME,
  baseURL: DEFAULT_BASE_URL,
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  credentialRefs: Object.freeze([]),
  apiKeyHeader: 'authorization',
  apiKeyPrefix: 'Bearer ',
  client: 'desktop',
  project: 'global',
  fingerprint: false,
  headers: Object.freeze({}),
  overridesPath: '',
  defaultContextWindow: 204800,
  defaultMaxTokens: 131072,
  discoveryTimeoutMs: 15000,
  /**
   * How long the official capacity catalogue stays trusted before a refresh
   * re-fetches it.
   *
   * The catalogue is a few megabytes of JSON describing every provider at
   * models.dev, and the numbers in it change when a provider ships a model — not
   * minute to minute. A day keeps start-up latency off the common path while
   * still letting a newly published model pick up its real limits within a day
   * (or immediately, via the explicit refresh button, which bypasses the TTL).
   */
  catalogueTtlMs: 24 * 60 * 60 * 1000,
  autoRefreshMinutes: 0,
  modelProtocols: Object.freeze({}),
  /**
   * Which models this route exposes, chosen on the settings page.
   *
   * `undefined` is not the same as empty: absent means "no choice made yet, show
   * everything the gateway lists", while an empty array means "the user hid every
   * model". Collapsing those two would make the first refresh look like a
   * deliberate blackout.
   */
  visibleModels: undefined,
  /**
   * Per-model "accepts images", chosen on the settings page.
   *
   * Needed because the gateway's listing carries no modality field at all
   * (measured 2026-10-22: only `id`, `object`, `created`, `owned_by`), so image
   * support cannot be discovered — only declared. A missing key means "no choice
   * made", which falls back to the catalog's claim; a present `false` hides the
   * capability even if the catalog claims it.
   */
  modelVision: Object.freeze({}),
  /**
   * Per-model capacity and thinking declarations, keyed by model id.
   *
   * This is the settings page's "advanced" panel, mirroring the official Models
   * page: `contextWindow`, `maxTokens`, `inputModalities` and `reasoningEfforts`.
   * Only what a user actually set is stored, so a missing field keeps meaning
   * "derive it" (measured table, vendor docs, or the configured defaults).
   *
   * `reasoningEfforts` is `Record<levelId, wireValue>` — the same shape the
   * official editor writes — where `null` means "this level sends no thinking
   * control at all".
   */
  modelSettings: Object.freeze({}),
  models: DEFAULT_MODELS,
  zen: DEFAULT_ZEN_CONFIG,
})

/**
 * Normalize a raw configuration block.
 *
 * @param {unknown} input - the fiber's configuration.
 * @returns {object} the normalized configuration.
 * @throws {ConfigError} when a field cannot be used.
 */
export function normalize(input) {
  const source = input !== null && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {}

  const baseURL = normalizeBaseURL(source.baseURL ?? DEFAULT_CONFIG.baseURL)

  const route = text(source.route) ?? DEFAULT_CONFIG.route
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(route)) {
    throw new ConfigError(`route "${route}" 不是合法的路由 ID（只允许字母、数字、点、下划线、连字符）`)
  }

  const rawModels = Array.isArray(source.models) ? source.models : DEFAULT_CONFIG.models
  const models = rawModels.map(normalizeModel)
  const seenIds = new Set()
  for (const model of models) {
    if (seenIds.has(model.id)) throw new ConfigError(`models 中 "${model.id}" 出现了多次`)
    seenIds.add(model.id)
  }

  const headers = {}
  if (source.headers !== null && typeof source.headers === 'object' && !Array.isArray(source.headers)) {
    for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (source.headers))) {
      const field = text(name)
      const headerValue = typeof value === 'string' ? value : undefined
      // A configured x-opencode-session would flatten every conversation onto one
      // id, which is the one thing this route must not do; it is dropped rather
      // than honoured, and the derived value is what ships.
      if (field === undefined || headerValue === undefined) continue
      if (field.toLowerCase() === 'x-opencode-session') continue
      headers[field.toLowerCase()] = headerValue
    }
  }

  const apiKeyPrefix = typeof source.apiKeyPrefix === 'string' ? source.apiKeyPrefix : DEFAULT_CONFIG.apiKeyPrefix
  const fingerprint = source.fingerprint === true

  return {
    enabled: source.enabled !== false,
    route,
    displayName: text(source.displayName) ?? DEFAULT_CONFIG.displayName,
    baseURL,
    apiKey: text(source.apiKey) ?? '',
    apiKeyEnv: text(source.apiKeyEnv) ?? DEFAULT_CONFIG.apiKeyEnv,
    credentialRefs: stringList(source.credentialRefs),
    apiKeyHeader: text(source.apiKeyHeader) ?? DEFAULT_CONFIG.apiKeyHeader,
    // The prefix may legitimately be empty ("send the key bare"), so an explicit
    // empty string is preserved rather than defaulted.
    apiKeyPrefix,
    client: text(source.client) ?? DEFAULT_CONFIG.client,
    project: text(source.project) ?? DEFAULT_CONFIG.project,
    fingerprint,
    headers,
    overridesPath: text(source.overridesPath) ?? '',
    defaultContextWindow: positiveInt(source.defaultContextWindow) ?? DEFAULT_CONFIG.defaultContextWindow,
    defaultMaxTokens: positiveInt(source.defaultMaxTokens) ?? DEFAULT_CONFIG.defaultMaxTokens,
    discoveryTimeoutMs: positiveInt(source.discoveryTimeoutMs) ?? DEFAULT_CONFIG.discoveryTimeoutMs,
    catalogueTtlMs: positiveInt(source.catalogueTtlMs) ?? DEFAULT_CONFIG.catalogueTtlMs,
    autoRefreshMinutes: Number.isFinite(Number(source.autoRefreshMinutes)) && Number(source.autoRefreshMinutes) > 0
      ? Number(source.autoRefreshMinutes)
      : 0,
    modelProtocols: normalizeModelProtocols(source.modelProtocols),
    visibleModels: Array.isArray(source.visibleModels) ? stringList(source.visibleModels) : undefined,
    modelVision: normalizeModelVision(source.modelVision),
    modelSettings: normalizeModelSettings(source.modelSettings),
    models,
    zen: normalizeZenConfig(source.zen),
  }
}

/**
 * 归一化 OpenCode Zen 免费模型车道的配置。
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeZenConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_ZEN_CONFIG }
  }
  const source = /** @type {Record<string, unknown>} */ (raw)
  const route = text(source.route) ?? DEFAULT_ZEN_CONFIG.route
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(route)) {
    throw new ConfigError(`zen.route "${route}" 不是合法的路由 ID（只允许字母、数字、点、下划线、连字符）`)
  }
  const baseURL = normalizeBaseURL(source.baseURL ?? DEFAULT_ZEN_CONFIG.baseURL)
  return {
    enabled: source.enabled !== false,
    route,
    displayName: text(source.displayName) ?? DEFAULT_ZEN_CONFIG.displayName,
    baseURL,
    apiKey: text(source.apiKey) ?? DEFAULT_ZEN_CONFIG.apiKey,
    visibleModels: Array.isArray(source.visibleModels) ? stringList(source.visibleModels) : undefined,
    modelProtocols: normalizeModelProtocols(source.modelProtocols),
    modelSettings: normalizeModelSettings(source.modelSettings),
  }
}

/**
 * One model's advanced overrides, as the settings page writes them.
 *
 * Every field is optional and independent: a user who only wanted to say "this
 * model takes 1M context" must not thereby overwrite its thinking ladder or its
 * image capability. Unknown keys are dropped rather than stored, so a typo in a
 * hand-edited override file cannot change behaviour quietly.
 *
 * `inputModalities` is validated against the two values the harness understands.
 * `reasoningEfforts` is kept as `Record<level, string|null>`; an empty string is
 * refused because pi-ai (and our own request builder) read it as "no value",
 * which would make the rung silently disappear.
 *
 * @param {unknown} raw
 * @returns {Record<string, object>}
 */
export function normalizeModelSettings(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const key = text(id)
    if (key === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = /** @type {Record<string, unknown>} */ (value)
    const settings = {}
    const contextWindow = positiveInt(entry.contextWindow)
    if (contextWindow !== undefined) settings.contextWindow = contextWindow
    const maxTokens = positiveInt(entry.maxTokens)
    if (maxTokens !== undefined) settings.maxTokens = maxTokens
    if (Array.isArray(entry.inputModalities)) {
      const modalities = ['text', 'image'].filter((name) => entry.inputModalities.includes(name))
      // An empty list is not a modality set: every model reads text.
      if (modalities.length > 0) settings.inputModalities = modalities
    }
    if (entry.reasoningEfforts !== null && typeof entry.reasoningEfforts === 'object' && !Array.isArray(entry.reasoningEfforts)) {
      const efforts = {}
      for (const [level, wire] of Object.entries(/** @type {Record<string, unknown>} */ (entry.reasoningEfforts))) {
        const name = text(level)
        if (name === undefined) continue
        if (wire === null) efforts[name] = null
        else if (typeof wire === 'string' && wire.trim() !== '') efforts[name] = wire.trim()
      }
      // An empty table is a real instruction ("this model gets no thinking control"),
      // but only when it was declared empty. A table that *had* entries and none of
      // them survived was garbage, and honouring it would silently switch the
      // control off — so that one is dropped rather than stored as zero rungs.
      const declared = Object.keys(entry.reasoningEfforts).length
      if (declared === 0 || Object.keys(efforts).length > 0) settings.reasoningEfforts = efforts
    }
    if (Object.keys(settings).length > 0) out[key] = settings
  }
  return out
}

/**
 * Normalize the per-model dialect table.
 *
 * The user picks a dialect per model on the settings page; this is the record of
 * those picks. An unrecognized dialect is dropped rather than stored, because a
 * model sent to an endpoint it does not speak answers an opaque 400.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeModelProtocols(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const key = text(id)
    const protocol = canonicalProtocol(value)
    if (key === undefined || protocol === null) continue
    out[key] = protocol
  }
  return out
}

/**
 * One boolean per model id, for the "accepts images" choice.
 *
 * Only `true`/`false` are kept: an entry has to be a real decision. `null` is the
 * documented way a caller clears an override, and it is dropped here so that
 * clearing means "fall back to the catalog" rather than "explicitly no images".
 *
 * @param {unknown} raw
 * @returns {Record<string, boolean>}
 */
function normalizeModelVision(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const key = text(id)
    if (key === undefined) continue
    if (value === true || value === false) out[key] = value
  }
  return out
}

/**
 * The credential references a request consults, in order.
 *
 * @param {object} cfg - a normalized configuration.
 * @returns {string[]}
 */
export function lookupRefsOf(cfg) {
  const refs = [...(cfg?.credentialRefs ?? []), cfg?.apiKeyEnv ?? DEFAULT_CONFIG.apiKeyEnv]
  const unique = []
  for (const ref of refs) {
    const item = text(ref)
    if (item !== undefined && !unique.includes(item)) unique.push(item)
  }
  return unique.length > 0 ? unique : [DEFAULT_CONFIG.apiKeyEnv]
}

/** Re-exported so callers can check a field name without duplicating it. */
export { MODEL_FIELDS }
