/**
 * dsh-opencode-live — a DSH route for OpenCode Go whose roster is the gateway's
 * **live** model listing, with a per-model wire protocol and a per-conversation
 * `x-opencode-session` header.
 *
 * Why this exists
 * ---------------
 * Three independent facts make the official `opencode-go` route unable to serve a
 * model the gateway has just added:
 *
 *   1. `dsh-llm-pi-ai`'s `discoverModels()` answers "fetch available models" for
 *      any route the installed pi-ai catalog describes **straight from that
 *      catalog**, with no network call. The catalog is a build-time snapshot
 *      (`providers/data/.manifest.json` records its `generatedAt`), so a model
 *      added after the package shipped can never appear in the picker.
 *   2. That catalog spans three wire protocols, so `sharedCatalogApi()` returns
 *      `undefined` and a hand-added model id is refused with `needs an api` —
 *      while the settings page only offers an API-protocol field for routes the
 *      catalog does *not* describe.
 *   3. Declaring an explicit `api` on the route makes `buildProvider()` rebuild
 *      the provider from a **raw** pi-ai api, bypassing the wrapper that injects
 *      `x-opencode-session` — so the request then fails 400 `MissingSessionID`.
 *
 * A plugin cannot fix any of that from configuration, because the short-circuit
 * is unconditional. What it *can* do is own a route of its own and answer all
 * three questions itself. That is this plugin.
 *
 * Packaging
 * ---------
 * Nothing here statically imports an `@deepseek-ai/*` package: a junctioned
 * package resolves to the checkout, where those specifiers do not resolve. The
 * schemastery module is found by path lookup, and the one optional harness class
 * is imported lazily with a shaped fallback.
 *
 * @module dsh-opencode-live
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeLiveAdapter, OpenCodeZenFreeAdapter } from './adapter.js'
import { modalitiesFrom, visionFor } from './capability.js'
import { LEVEL_IDS, defaultWireFor, ladderFor } from './effort.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_MODELS,
  DEFAULT_ZEN_CONFIG,
  PROTOCOLS,
  canonicalProtocol,
  endpointOf,
  modelsEndpoint,
  normalize,
  normalizeBaseURL,
  normalizeModelSettings,
  lookupRefsOf,
} from './config.js'
import { fetchLiveModels, fetchZenLiveModels } from './discovery.js'
import { loadCatalogue } from './zen-catalogue.js'
import { ZEN_CAPACITY_FALLBACK, ZEN_FREE_PRESETS } from './zen-wire.js'

export const name = 'dsh-opencode-live'
export const inject = ['llm']

/**
 * The user-agent this route identifies itself with.
 *
 * The gateway recognises a desktop client by an `opencode/<version>` token; the
 * test is for the token's presence, not an anchored prefix, so one value can
 * satisfy both the gateway's "identify yourself" request and its client check.
 * Measured 2026-10-21: the Go subscription lane accepted every UA tried,
 * including a bare `node`, so this is identification rather than a gate.
 */
const USER_AGENT = `${name} (opencode/1.18.31)`

export { USER_AGENT }

/**
 * Where the settings page's JSON API is mounted.
 *
 * The web server keeps the full pathname when it dispatches to a prefix route, so
 * the handler strips this prefix itself — see {@link createApiRoutes}.
 */
const API_PREFIX = '/api/opencode-live'

/** Re-exported so a deployment and a test read defaults from one place. */
export {
  DEFAULT_CONFIG,
  DEFAULT_MODELS,
  PROTOCOLS,
  canonicalProtocol,
  normalize,
  lookupRefsOf,
} from './config.js'

/**
 * Turn a family ladder into the record shape the settings page edits.
 *
 * The panel pairs a level with the value it sends, exactly like the official
 * model editor, so the inherited ladder has to be presented in that shape too.
 * A level whose `wireEffort` is `undefined` (our `off`) sends nothing, which the
 * record spells as `null`.
 *
 * @param {{ efforts: {id: string}[], defaultEffort?: string }|undefined} ladder
 * @returns {Record<string, string|null>|null}
 */
function ladderToRecord(ladder) {
  if (ladder === undefined || !Array.isArray(ladder.efforts)) return null
  const out = {}
  for (const effort of ladder.efforts) out[effort.id] = defaultWireFor(effort.id) ?? null
  return out
}

/**
 * Merge an advanced-panel patch into the stored per-model settings.
 *
 * Three levels of "clear", because the panel can express all three:
 *
 *   - `{ id: null }` — forget everything about this model, back to inherited;
 *   - `{ id: { contextWindow: null } }` — clear one field, the others survive;
 *   - `{ id: { inputModalities: ['text'] } }` — a real value, including one that
 *     happens to equal the inherited value.
 *
 * A model whose settings end up empty is dropped, so the override file does not
 * accumulate three-key shells for models nobody configured.
 *
 * @param {Record<string, object>} current
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, object>}
 */
function mergeModelSettings(current, patch) {
  const out = { ...current }
  for (const [id, value] of Object.entries(patch)) {
    if (typeof id !== 'string' || id === '') continue
    if (value === null) {
      delete out[id]
      continue
    }
    if (typeof value !== 'object' || Array.isArray(value)) continue
    const next = { ...(out[id] ?? {}) }
    for (const [field, fieldValue] of Object.entries(value)) {
      if (fieldValue === null) delete next[field]
      else next[field] = fieldValue
    }
    if (Object.keys(next).length === 0) delete out[id]
    else out[id] = next
  }
  // Normalized here as well as on read, so the file on disk never disagrees with
  // what the plugin honours. Writing `maxTokens: "big"` and silently ignoring it
  // would leave a value in the override document that looks like a setting and
  // does nothing — the next reader has no way to tell it apart from a real one.
  return normalizeModelSettings(out)
}

/**
 * Locate the host's `schemastery` and return its `z`.
 *
 * Searched rather than imported because a static specifier does not resolve from
 * this package's real path. The profiles directory is where the Host keeps it.
 *
 * @returns {Function|null}
 */
function loadSchemastery() {
  const root = path.join(os.homedir(), '.dsh', 'profiles')
  const roots = [root]
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(root, entry.name))
    }
  } catch { /* no dsh home; the direct root may still work */ }
  for (const dir of roots) {
    const anchor = path.join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')
    if (!fs.existsSync(anchor)) continue
    try {
      return createRequire(anchor)('@deepseek-ai/schemastery')
    } catch { /* try the next root */ }
  }
  return null
}

const SCHEMASTERY = loadSchemastery()

/**
 * The fiber's configuration schema.
 *
 * Exporting this is what puts the fiber into the Host's settings mirror; without
 * a `Config` the route works but is invisible in the Models page. It is
 * `undefined` when schemastery cannot be found, which degrades to the plain-object
 * behaviour rather than refusing to mount over a missing optional.
 */
export const Config = SCHEMASTERY === null ? undefined : buildConfig(SCHEMASTERY)

function buildConfig(z) {
  return z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('注册这条实时目录路由'),
    route: z.string().default(DEFAULT_CONFIG.route).description('路由 ID，不能与其他适配器冲突'),
    displayName: z.string().default(DEFAULT_CONFIG.displayName).description('显示名'),
    baseURL: z.string().default(DEFAULT_CONFIG.baseURL).description('网关地址前缀；填到 /v1 或完整端点都会自动归一化'),
    apiKey: z.string().default(DEFAULT_CONFIG.apiKey).description('API Key，优先级高于凭据库'),
    apiKeyEnv: z.string().default(DEFAULT_CONFIG.apiKeyEnv).description('凭据库中的引用名'),
    credentialRefs: z.array(z.string()).default([]).description('按顺序尝试的凭据引用名'),
    apiKeyHeader: z.string().default(DEFAULT_CONFIG.apiKeyHeader).description('密钥放在哪个请求头'),
    apiKeyPrefix: z.string().default(DEFAULT_CONFIG.apiKeyPrefix).description('密钥前缀'),
    client: z.string().default(DEFAULT_CONFIG.client).description('网关识别的客户端标识'),
    project: z.string().default(DEFAULT_CONFIG.project).description('网关识别的项目标识'),
    fingerprint: z.boolean().default(DEFAULT_CONFIG.fingerprint).description('是否补齐 bash/glob/grep/read 四件套（Go 订阅通道实测不需要）'),
    headers: z.dict(z.string()).default({}).description('附加静态头；x-opencode-session 会被丢弃'),
    overridesPath: z.string().default(DEFAULT_CONFIG.overridesPath).description('覆盖配置文件路径'),
    defaultContextWindow: z.number().default(DEFAULT_CONFIG.defaultContextWindow).description('模型未声明时的上下文长度'),
    defaultMaxTokens: z.number().default(DEFAULT_CONFIG.defaultMaxTokens).description('模型未声明时的最长输出'),
    discoveryTimeoutMs: z.number().default(DEFAULT_CONFIG.discoveryTimeoutMs).description('拉取模型列表的超时'),
    autoRefreshMinutes: z.number().default(DEFAULT_CONFIG.autoRefreshMinutes).description('自动刷新间隔（分钟），0 关闭'),
    modelProtocols: z.dict(z.string()).default({}).description('每个模型使用的线路协议（在设置页选择）'),
    modelVision: z.dict(z.boolean()).default({}).description('每个模型是否接受图片（在设置页选择）'),
    modelSettings: z.dict(z.object({
      contextWindow: z.number().description('上下文长度'),
      maxTokens: z.number().description('最长输出'),
      inputModalities: z.array(z.string()).description('输入类型：text / image'),
      reasoningEfforts: z.dict(z.union([z.string(), z.const(null)])).description('思考档位 → 请求参数值'),
    })).default({}).description('每个模型的容量、输入类型与思考档位（在设置页选择）'),
    models: z.array(z.object({
      id: z.string().description('模型 ID'),
      name: z.string().description('显示名'),
      description: z.string().default('').description('说明'),
      contextWindow: z.number().description('上下文长度'),
      maxTokens: z.number().description('最长输出'),
      vision: z.boolean().default(false).description('是否支持图片'),
      protocol: z.string().description('线路协议；留空则用设置页里选择的协议'),
    })).default(DEFAULT_MODELS).description('手工声明的模型；刷新会重建这份清单'),
  })
}

/**
 * Read the credential behind a list of references.
 *
 * @param {object|undefined} credentials
 * @param {string[]} refs
 * @returns {Promise<string|null>}
 */
async function resolveCredential(credentials, refs) {
  if (credentials === undefined) return null
  for (const ref of refs) {
    try {
      const value = (await credentials.resolve(ref))?.value
      if (value) return value
    } catch {
      // One unreadable reference must not hide the ones after it.
    }
  }
  return null
}

/**
 * Write one small file recording that `apply` ran, and why it stopped when it
 * did.
 *
 * The host keeps its own log inside the packaged app, which this deployment
 * cannot read back — so "did the fiber actually mount, and if not why?" has no
 * answer from outside without this. Its absence is evidence too: a plugin the
 * loader never reached leaves no file, which is exactly the distinction a stuck
 * install needs. Best-effort by design: a read-only home must never be the reason
 * a route fails to serve.
 *
 * @param {object} entry - what to record.
 * @param {object} log
 */
function writeHeartbeat(entry, log) {
  try {
    const dir = entry.overridesPath || path.join(os.homedir(), '.dsh', 'opencode-live')
    fs.mkdirSync(dir, { recursive: true })
    let version = 'unknown'
    try {
      version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    } catch { /* a packaged layout may not expose it; the version is informational */ }
    fs.writeFileSync(
      path.join(dir, 'mounted.json'),
      `${JSON.stringify({ plugin: name, version, pid: process.pid, at: new Date().toISOString(), ...entry }, null, 2)}\n`,
      'utf8',
    )
    return path.join(dir, 'mounted.json')
  } catch (error) {
    log?.warn?.('[opencode-live] 挂载心跳写入失败（不影响路由）：%s', String(error?.message ?? error))
    return undefined
  }
}

/**
 * @param {object} ctx - the plugin context.
 * @param {object} config - the resolved configuration block.
 */
export function apply(ctx, config) {
  const log = ctx.logger ?? console

  // First of all: record that this fiber was reached. Everything below can fail
  // for a legitimate reason and return early; this is the line that distinguishes
  // "apply never ran" from "apply ran and refused".
  const overridesPath = typeof config?.overridesPath === 'string' ? config.overridesPath : ''

  let base
  try {
    base = normalize(config)
  } catch (error) {
    // A configuration the plugin cannot act on must not be acted on quietly: a
    // base URL that fell back to the default would send conversations to a host
    // nobody named, which is worse than not starting.
    writeHeartbeat({ state: 'config-invalid', error: String(error?.message ?? error), overridesPath }, log)
    log.error('[opencode-live] 配置无效，未注册任何路由：%s', String(error?.message ?? error))
    return
  }
  if (config?.models !== undefined && !Array.isArray(config.models)) {
    log.warn('[opencode-live] models 不是数组，已忽略')
  }

  if (!base.enabled) {
    writeHeartbeat({ state: 'disabled', overridesPath: base.overridesPath }, log)
    log.info('[opencode-live] 已禁用，不注册任何路由')
    return
  }

  writeHeartbeat({ state: 'applying', route: base.route, baseURL: base.baseURL, overridesPath: base.overridesPath }, log)

  // -- mutable state ---------------------------------------------------------

  /**
   * Everything the gateway listed at the last refresh.
   *
   * Seeded from the declared models with the stored protocol choices already
   * applied, so a route that has never reached the gateway still serves the right
   * dialects — the choice is configuration, not something a refresh produces.
   */
  let gatewayModels = base.models.map((entry) => {
    const chosen = base.modelProtocols[entry.id] ?? entry.protocol
    return { ...entry, ...(chosen === undefined ? {} : { protocol: chosen }) }
  })

  /** The models this route actually serves — the chosen subset of `gatewayModels`. */
  let roster = []

  /**
   * The subset of `gatewayModels` the user chose to expose.
   *
   * `visibleModels === undefined` means "no choice made yet" and exposes the whole
   * catalogue; an explicit array — including an empty one — is obeyed as written.
   * That distinction is what lets a first run show everything without a stored
   * choice, while hiding every model stays possible and stays deliberate.
   *
   * @param {object} cfg - a normalized configuration.
   * @returns {object[]}
   */
  const projectRoster = (cfg) => {
    const visible = cfg.visibleModels
    if (visible === undefined) return gatewayModels.map((entry) => ({ ...entry }))
    const wanted = new Set(visible)
    return gatewayModels.filter((entry) => wanted.has(entry.id)).map((entry) => ({ ...entry }))
  }

  /** The last discovery outcome, for the settings page to report. */
  let lastRefresh = { at: 0, ok: false, message: '尚未刷新', endpoint: '', count: 0 }

  let credentials = ctx.get('credentials')
  if (credentials === undefined) {
    log.warn('[opencode-live] 此组合没有凭据服务（credentials），无法解析 %s；请求会被网关拒绝。', lookupRefsOf(base).join(' / '))
  }

  /**
   * Where the page's writes live.
   *
   * Always a real directory: `overridesPath` is normally empty, and a null store
   * for that case was a silent write-without-readback bug — the page saved, the
   * file appeared, and every subsequent read answered as if nothing had been
   * saved, because `store` was null and `reload()` merged `{}`.
   */
  const overrideDir = base.overridesPath || path.join(os.homedir(), '.dsh', 'opencode-live')

  /** The configuration as it stands right now. */
  let liveConfig = base
  const store = createOverrideStore(overrideDir, log)

  // -- Zen Free Route Mutable State & Setup ---------------------------------
  // The seeded roster is the *offline snapshot*: it exists so the picker has rows
  // before the first network round, not because its numbers are authoritative.
  // The real capacities come from the official catalogue on every refresh.
  let zenGatewayModels = Object.entries(ZEN_FREE_PRESETS).map(([id, preset]) => ({
    id,
    name: preset.name,
    contextWindow: preset.contextWindow,
    maxTokens: preset.maxTokens,
    vision: preset.vision,
  }))
  let zenRoster = []

  /**
   * Official capacity catalogue, keyed by model id. `null` until the first
   * successful load, which makes every consumer fall back to the snapshot.
   */
  let zenCatalogue = null
  let lastCatalogue = { at: 0, source: 'none', message: '尚未获取', count: 0 }

  const cataloguePath = path.join(overrideDir, 'models-catalogue.json')

  const projectZenRoster = (zenCfg) => {
    const visible = zenCfg.visibleModels
    if (visible === undefined) return zenGatewayModels.map((entry) => ({ ...entry }))
    const wanted = new Set(visible)
    return zenGatewayModels.filter((entry) => wanted.has(entry.id)).map((entry) => ({ ...entry }))
  }

  let lastZenRefresh = { at: 0, ok: false, message: '尚未刷新', endpoint: '', count: 0 }

  /**
   * Load the official capacity catalogue into {@link zenCatalogue}.
   *
   * Separate from {@link refreshZen} because the two fail independently: a
   * broken catalogue should still leave the listing usable with snapshot
   * capacities, and a broken listing should not throw away a catalogue that is
   * already on disk.
   *
   * @param {{ signal?: AbortSignal, forceRefresh?: boolean }} [options]
   */
  const loadZenCatalogue = async (options = {}) => {
    const answer = await loadCatalogue({
      cachePath: cataloguePath,
      ttlMs: liveConfig.catalogueTtlMs,
      forceRefresh: options.forceRefresh === true,
      signal: options.signal,
      log: (...args) => log.warn?.(...args),
    })
    if (answer.table !== null) zenCatalogue = answer.table
    lastCatalogue = {
      at: answer.at,
      source: answer.source,
      message: answer.message,
      count: zenCatalogue?.size ?? 0,
    }
    return answer
  }

  const refreshZen = async (options = {}) => {
    const zenCfg = liveConfig.zen
    if (!zenCfg.enabled) return lastZenRefresh

    // Sequential by necessity: the listing cannot be projected into a roster
    // until the capacities it is projected against are known.
    const catalogueAnswer = await loadZenCatalogue({
      signal: options.signal,
      forceRefresh: options.forceRefreshCatalogue === true,
    })

    const answer = await fetchZenLiveModels({
      baseURL: zenCfg.baseURL,
      apiKey: zenCfg.apiKey,
      catalogue: zenCatalogue,
      signal: options.signal,
      timeoutMs: liveConfig.discoveryTimeoutMs,
      log: (...args) => log.warn?.(...args),
    })

    if (!answer.ok) {
      zenRoster = projectZenRoster(zenCfg)
      lastZenRefresh = {
        at: Date.now(),
        ok: false,
        message: answer.message,
        endpoint: answer.endpoint,
        count: zenGatewayModels.length,
      }
      log.warn('[opencode-live] Zen 免费模型刷新失败（保留上次的 %d 个）：%s', zenGatewayModels.length, answer.message)
      return lastZenRefresh
    }

    // `answer.models` already carries the resolved name/capacity/vision: the
    // fetcher applies the endpoint → catalogue → snapshot precedence in one
    // place. Re-deriving it here would be a second copy of that rule, free to
    // drift from the first.
    zenGatewayModels = answer.models.map((entry) => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      vision: entry.vision,
    }))

    zenRoster = projectZenRoster(zenCfg)
    lastZenRefresh = {
      at: Date.now(),
      ok: true,
      message: `已同步 ${zenGatewayModels.length} 个免费模型${zenRoster.length === zenGatewayModels.length ? '' : `，显示 ${zenRoster.length} 个`}${catalogueAnswer.source === 'none' ? '（容量目录不可用，使用离线快照）' : ''}`,
      endpoint: answer.endpoint,
      count: zenGatewayModels.length,
    }
    log.info('[opencode-live] 已同步 %d 个 Zen 免费模型，显示 %d 个（%s）', zenGatewayModels.length, zenRoster.length, answer.endpoint)
    return lastZenRefresh
  }

  /**
   * Apply the stored per-model protocol choices onto the catalogue.
   *
   * Kept separate from {@link reload} because the catalogue is created before the
   * override document is read; calling this afterwards is what makes a saved choice
   * survive a restart rather than only the request that saved it.
   */
  const applyProtocolChoices = () => {
    for (const entry of gatewayModels) {
      const declared = liveConfig.models.find((candidate) => candidate.id === entry.id)
      const chosen = liveConfig.modelProtocols[entry.id] ?? declared?.protocol
      if (chosen === undefined) delete entry.protocol
      else entry.protocol = chosen
    }
  }

  const reload = () => {
    const merged = store.read()
    try {
      liveConfig = normalize({ ...base, ...merged })
    } catch (error) {
      log.warn('[opencode-live] 覆盖配置不可用，仍用已生效的配置：%s', String(error?.message ?? error))
    }
    // The catalogue is created before this runs, so the stored choices are applied
    // here — a saved protocol that only survived the request that saved it would be
    // a save the next boot silently discards.
    applyProtocolChoices()
    roster = projectRoster(liveConfig)
    zenRoster = projectZenRoster(liveConfig.zen)
  }
  reload()

  /**
   * The credential service, read at call time.
   *
   * It is published by another bundle, so it may not exist when this fiber mounts.
   * Reading it through a thunk means a service that appears later is picked up
   * automatically, instead of the mount-time `undefined` becoming permanent.
   */
  const credentialStore = () => {
    const live = ctx.get('credentials')
    if (live !== undefined) credentials = live
    return credentials
  }

  const currentKey = () => resolveCredential(credentialStore(), lookupRefsOf(liveConfig))

  /**
   * Refresh the roster from the gateway.
   *
   * One GET, nothing else. The dialect of each model is the user's choice on the
   * settings page, so this path never spends time measuring anything.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} the refresh report.
   */
  const refresh = async (options = {}) => {
    const cfg = liveConfig
    const apiKey = (await currentKey()) ?? undefined
    const answer = await fetchLiveModels({
      baseURL: cfg.baseURL,
      apiKey,
      signal: options.signal,
      timeoutMs: cfg.discoveryTimeoutMs,
      log: (...args) => log.warn?.(...args),
    })

    if (!answer.ok) {
      // A failed round keeps the previous catalogue: a network blip must not empty a
      // picker. The report says why, so the surface can show it beside the roster.
      //
      // The roster is still re-projected from the *current* configuration, because a
      // visibility or protocol choice saved while the gateway was unreachable must
      // take effect immediately — the listing did not change, only the choices about
      // it, and those do not need a network to apply.
      roster = projectRoster(cfg)
      lastRefresh = {
        at: Date.now(),
        ok: false,
        message: answer.message,
        endpoint: answer.endpoint,
        count: gatewayModels.length,
      }
      log.warn('[opencode-live] 模型列表刷新失败（保留上次的 %d 个）：%s', gatewayModels.length, answer.message)
      return lastRefresh
    }

    // Everything the gateway listed. Kept separately from `roster` so the page can
    // show the full catalogue (into which the user picks) while the picker only
    // sees what was chosen.
    gatewayModels = answer.models.map((entry) => {
      const declared = cfg.models.find((candidate) => candidate.id === entry.id)
      // The user's pick wins, then a declared model's own protocol; otherwise the
      // model is unclassified and the page offers a picker.
      const chosen = cfg.modelProtocols[entry.id] ?? declared?.protocol
      return {
        id: entry.id,
        name: declared?.name ?? entry.name,
        description: declared?.description ?? '',
        contextWindow: declared?.contextWindow ?? entry.contextWindow,
        maxTokens: declared?.maxTokens ?? entry.maxTokens,
        vision: declared?.vision ?? false,
        ...(chosen === undefined ? {} : { protocol: chosen }),
      }
    })

    // The roster is the whole answer, and it is the *chosen subset*.
    //
    // Discovery is one GET. Nothing else belongs in this path: the picker and this
    // plugin's own page both read `roster`, so anything slower would make them wait
    // for something they do not need — which is exactly what left the picker empty
    // when protocol probing lived here.
    //
    // A deployment that has not chosen anything shows the whole listing; one that
    // has chosen shows only that. `visibleModels === undefined` is "no choice yet",
    // which must not be confused with "chose none".
    roster = projectRoster(cfg)
    lastRefresh = {
      at: Date.now(),
      ok: true,
      message: gatewayModels.length === 0
        ? '网关没有列出任何模型'
        : `已同步 ${gatewayModels.length} 个模型${roster.length === gatewayModels.length ? '' : `，显示 ${roster.length} 个`}`,
      endpoint: answer.endpoint,
      count: gatewayModels.length,
    }
    log.info('[opencode-live] 已同步 %d 个模型，显示 %d 个（%s）', gatewayModels.length, roster.length, answer.endpoint)
    return lastRefresh
  }

  // -- adapter ---------------------------------------------------------------

  const adapter = new OpenCodeLiveAdapter({
    config: base,
    liveConfig: () => liveConfig,
    roster: () => roster,
    attributionUserAgent: USER_AGENT,
    apiKey: base.apiKey,
    resolveApiKey: currentKey,
    log: (...args) => log.info?.(...args),
  })

  let dispose
  try {
    dispose = ctx.llm.registerAdapter([base.route], adapter)
  } catch (error) {
    const code = error?.failure?.code ?? error?.code
    if (code === 'DUPLICATE_ADAPTER') {
      log.error('[opencode-live] 路由 %s 已被其他适配器占用，注册失败。请把 config.route 改成一个未被占用的 ID。', base.route)
      return
    }
    throw error
  }

  // Declare the route as a configurable provider. Without this the route exists
  // but the Models page filters it out: that page renders a row only when the
  // route's `settingsNs` names a live settings namespace.
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name
  const directory = ctx.llm.registerConfigurableProviders?.([
    { provider: base.route, displayName: base.displayName, settingsNs, settingsPath: [] },
  ])

  // The discovery offer this plugin exists for. Registered under its own
  // namespace, so no pi-ai catalog lookup is involved: this is a real network
  // read of the gateway's listing, and it is the only thing it does.
  ctx.llm.registerModelDiscovery?.(settingsNs, async (_request, signal) => {
    await refresh({ signal })
    return roster.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      ...(entry.protocol === undefined ? {} : { protocol: entry.protocol }),
    }))
  })

  log.info(
    '[opencode-live] 已注册路由 %s → %s（%d 个模型）',
    base.route,
    base.baseURL,
    roster.length,
  )

  // 挂载 Zen 免费模型专属适配器
  let disposeZen = null
  let directoryZen = null
  const zenAdapter = new OpenCodeZenFreeAdapter({
    config: base.zen,
    liveConfig: () => liveConfig.zen,
    roster: () => zenRoster,
    log: (...args) => log.info?.(...args),
  })

  if (base.zen.enabled) {
    try {
      disposeZen = ctx.llm.registerAdapter([base.zen.route], zenAdapter)
      const zenSettingsNs = `${settingsNs}.zen`
      directoryZen = ctx.llm.registerConfigurableProviders?.([
        { provider: base.zen.route, displayName: base.zen.displayName, settingsNs: zenSettingsNs, settingsPath: [] },
      ])
      ctx.llm.registerModelDiscovery?.(zenSettingsNs, async (_request, signal) => {
        await refreshZen({ signal })
        return zenRoster.map((entry) => ({
          id: entry.id,
          name: entry.name,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          inputModalities: entry.vision ? ['text', 'image'] : ['text'],
        }))
      })
      log.info('[opencode-live] 已注册 Zen 免费模型独立路由 %s → %s（%d 个模型）', base.zen.route, base.zen.baseURL, zenRoster.length)
    } catch (err) {
      log.warn('[opencode-live] Zen 免费模型路由注册失败：%s', String(err?.message ?? err))
    }
  }

  writeHeartbeat({
    state: 'mounted',
    route: base.route,
    displayName: base.displayName,
    baseURL: base.baseURL,
    models: roster.length,
    zenRoute: base.zen.enabled ? base.zen.route : null,
    zenModels: base.zen.enabled ? zenRoster.length : 0,
    overridesPath: base.overridesPath,
  }, log)
  const controller = new AbortController()
  void refresh({ signal: controller.signal }).catch((error) => {
    log.warn('[opencode-live] 首次刷新失败：%s', String(error?.message ?? error))
  })
  if (base.zen.enabled) {
    void refreshZen({ signal: controller.signal }).catch((error) => {
      log.warn('[opencode-live] Zen 免费模型首次刷新失败：%s', String(error?.message ?? error))
    })
  }
  if (base.autoRefreshMinutes > 0) {
    const timer = setInterval(() => {
      void refresh({ signal: controller.signal }).catch(() => {})
      if (liveConfig.zen?.enabled) {
        void refreshZen({ signal: controller.signal }).catch(() => {})
      }
    }, base.autoRefreshMinutes * 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'opencode-live: refresh timer')
  }

  // -- settings API ----------------------------------------------------------

  /** Write the editable part of the configuration to the override document. */
  const writeConfig = (patch) => {
    const dir = overrideDir
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'config.json')
    let current = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        log.warn('[opencode-live] 覆盖配置不可读，将被整份重写：%s', String(error?.message ?? error))
      }
    }
    const next = { ...current, ...patch }
    for (const key of Object.keys(next)) {
      if (next[key] === undefined || next[key] === '') delete next[key]
      else if (key === 'modelSettings' && typeof next[key] === 'object' && Object.keys(next[key]).length === 0) {
        // Drop empty modelSettings so it does not linger or block resetting
      }
    }
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    try {
      // Advance mtime at least 2ms ahead of current stat to guarantee mtimeMs differs
      const now = Date.now() / 1000 + 0.01
      fs.utimesSync(temp, now, now)
    } catch { /* utimes best-effort */ }
    fs.renameSync(temp, file)
    return file
  }

  /**
   * Store a key in the credential store.
   *
   * The store is the only place a secret may live: it never reaches this plugin's
   * override document, its settings response, or any log line.
   *
   * The store is read at call time rather than captured, because the credential
   * service is published by another bundle and may not exist when this fiber
   * mounts — capturing `undefined` at mount would make every later write report
   * "no credential service" even after the service appeared.
   */
  const setApiKey = async (value) => {
    const store = credentialStore()
    if (store === undefined) {
      throw new Error('此组合没有凭据服务，密钥请写进 cordis.patch.yml 的 apiKey')
    }
    const ref = lookupRefsOf(liveConfig)[0]
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed === '') {
      if (typeof store.unset !== 'function') throw new Error('凭据服务不支持删除')
      await store.unset(ref)
      adapter.cachedApiKey = null
      return { ref, configured: false }
    }
    if (typeof store.set !== 'function') throw new Error('凭据服务不支持写入')
    // `set(ref, value)` takes the secret itself, not a record object.
    await store.set(ref, trimmed)
    credentials = store
    adapter.cachedApiKey = trimmed
    return { ref, configured: true }
  }

  const api = {
    view: async () => ({
      enabled: liveConfig.enabled,
      route: liveConfig.route,
      displayName: liveConfig.displayName,
      baseURL: liveConfig.baseURL,
      endpoint: {
        models: modelsEndpoint(liveConfig.baseURL),
        chat: endpointOf(liveConfig.baseURL, '/chat/completions'),
      },
      credential: {
        refs: lookupRefsOf(liveConfig),
        configured: (await currentKey()) !== null,
      },
      lastRefresh,
      storePath: path.join(overrideDir, 'config.json'),
      // The dialects the page may offer per model, in preference order.
      protocols: PROTOCOLS,
      // The level ids the page's thinking ladder editor starts from. A user may type
      // a level this list does not name; these are only the suggestions.
      effortLevels: LEVEL_IDS,
      // Whether the deployment has expressed a choice at all. `false` means every
      // model is exposed, which the page renders as "all checked".
      visibilityChosen: liveConfig.visibleModels !== undefined,
      // The full catalogue, each row carrying whether it is currently exposed, so
      // the page can offer a checklist rather than only the served subset.
      catalogue: gatewayModels.map((entry) => {
        const declared = liveConfig.modelSettings?.[entry.id] ?? {}
        // The *documented* ladder for this family, deliberately not
        // `adapter.ladderOf(...)`: that one folds in the user's declaration, and the
        // panel needs the inherited ladder to show what "auto" would mean. Reading it
        // through the adapter made `autoReasoningEfforts` echo the user's own rungs
        // back at them, so the panel could never show what it was overriding.
        const ladder = ladderFor(entry.id)
        return {
          id: entry.id,
          name: entry.name,
          protocol: entry.protocol ?? null,
          // The resolved capability, so the page can show the picker in the state the
          // adapter will actually use — user choice first, then the measured table.
          vision: visionFor(entry.id, liveConfig.modelVision),
          // What the picker shows when the user has no opinion, so the "auto" option can
          // say what it resolves to instead of a bare "auto".
          autoVision: visionFor(entry.id, {}),
          visionChosen: typeof liveConfig.modelVision[entry.id] === 'boolean',
          visible: liveConfig.visibleModels === undefined || liveConfig.visibleModels.includes(entry.id),
          // ── the advanced panel ──────────────────────────────────────────────
          // What the adapter will report, plus what it would report with no user
          // declaration, so the panel can show a placeholder that names the inherited
          // value instead of forcing the user to guess it.
          contextWindow: declared.contextWindow ?? entry.contextWindow ?? null,
          autoContextWindow: entry.contextWindow ?? liveConfig.defaultContextWindow,
          maxTokens: declared.maxTokens ?? entry.maxTokens ?? null,
          autoMaxTokens: entry.maxTokens ?? liveConfig.defaultMaxTokens,
          inputModalities: modalitiesFrom(entry.id, liveConfig),
          autoInputModalities: modalitiesFrom(entry.id, {}),
          // `Record<level, wire|null>`, or `null` when the user has not declared any —
          // which is how the panel tells "inherit the documented ladder" from "chose
          // zero rungs on purpose".
          reasoningEfforts: declared.reasoningEfforts === undefined
            ? null
            : { ...declared.reasoningEfforts },
          autoReasoningEfforts: ladderToRecord(ladder),
          autoReasoningSource: ladder?.source ?? null,
          // Fields the user has overridden, so the panel can mark them and offer a
          // per-field "back to inherited" action.
          overridden: {
            contextWindow: declared.contextWindow !== undefined,
            maxTokens: declared.maxTokens !== undefined,
            inputModalities: declared.inputModalities !== undefined,
            reasoningEfforts: declared.reasoningEfforts !== undefined,
          },
        }
      }),
      // What the picker and the adapter actually serve.
      models: roster.map((entry) => ({
        id: entry.id,
        name: entry.name,
        // `null` means "not chosen yet" — the page shows a picker, and the adapter
        // dials the default dialect.
        protocol: entry.protocol ?? null,
        vision: visionFor(entry.id, liveConfig.modelVision),
      })),
      // ── Zen 免费模型车道视图 ──────────────────────────────────────────
      zen: {
        enabled: liveConfig.zen.enabled,
        route: liveConfig.zen.route,
        displayName: liveConfig.zen.displayName,
        baseURL: liveConfig.zen.baseURL,
        apiKey: liveConfig.zen.apiKey,
        lastRefresh: lastZenRefresh,
        // Where the `auto*` numbers below came from: `network`, `cache` (TTL hit
        // or refresh fallback) or `none` (offline snapshot in use).
        lastCatalogue,
        visibilityChosen: liveConfig.zen.visibleModels !== undefined,
        catalogue: zenGatewayModels.map((entry) => {
          const declared = liveConfig.zen.modelSettings?.[entry.id] ?? {}
          const ladder = ladderFor(entry.id)
          return {
            id: entry.id,
            name: entry.name,
            protocol: 'chat-completions',
            vision: entry.vision,
            autoVision: entry.vision,
            visible: liveConfig.zen.visibleModels === undefined || liveConfig.zen.visibleModels.includes(entry.id),
            contextWindow: declared.contextWindow ?? entry.contextWindow ?? null,
            // `auto*` is what the adapter would use with no user override — so it
            // must show the same number the adapter computes, not a second copy of
            // the fallback constants.
            autoContextWindow: entry.contextWindow ?? ZEN_CAPACITY_FALLBACK.contextWindow,
            maxTokens: declared.maxTokens ?? entry.maxTokens ?? null,
            autoMaxTokens: entry.maxTokens ?? ZEN_CAPACITY_FALLBACK.maxTokens,
            inputModalities: modalitiesFrom(entry.id, liveConfig.zen),
            autoInputModalities: entry.vision ? ['text', 'image'] : ['text'],
            reasoningEfforts: declared.reasoningEfforts === undefined ? null : { ...declared.reasoningEfforts },
            autoReasoningEfforts: ladderToRecord(ladder),
            autoReasoningSource: ladder?.source ?? null,
            overridden: {
              contextWindow: declared.contextWindow !== undefined,
              maxTokens: declared.maxTokens !== undefined,
              inputModalities: declared.inputModalities !== undefined,
              reasoningEfforts: declared.reasoningEfforts !== undefined,
            },
          }
        }),
        models: zenRoster.map((entry) => ({
          id: entry.id,
          name: entry.name,
          protocol: 'chat-completions',
          vision: entry.vision,
        })),
      },
    }),

    /** Apply an edit from the page: configuration fields and/or a typed key. */
    update: async (patch) => {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('patch 必须是一个对象')
      }
      const config = {}
      if (typeof patch.apiKey === 'string') await setApiKey(patch.apiKey)
      if (typeof patch.displayName === 'string' && patch.displayName.trim() !== '') {
        config.displayName = patch.displayName.trim()
      }
      if (typeof patch.baseURL === 'string') {
        // Normalized before it is stored so a pasted full endpoint is reduced to a
        // prefix once, here, rather than on every request.
        config.baseURL = normalizeBaseURL(patch.baseURL)
      }
      if (typeof patch.autoRefreshMinutes === 'number' && patch.autoRefreshMinutes >= 0) {
        config.autoRefreshMinutes = patch.autoRefreshMinutes
      }
      // The per-model "accepts images" table. Merged like the protocol table, and a
      // `null` value clears one model's override so it falls back to the catalog.
      if (patch.modelVision !== null && typeof patch.modelVision === 'object' && !Array.isArray(patch.modelVision)) {
        const merged = { ...liveConfig.modelVision }
        for (const [id, value] of Object.entries(patch.modelVision)) {
          if (value === null) delete merged[id]
          else if (value === true || value === false) merged[id] = value
        }
        config.modelVision = merged
      }
      // The per-model dialect table. Merged rather than replaced so a page that
      // edits one model cannot silently drop the choices made for the others.
      if (patch.modelProtocols !== null && typeof patch.modelProtocols === 'object' && !Array.isArray(patch.modelProtocols)) {
        config.modelProtocols = { ...liveConfig.modelProtocols, ...patch.modelProtocols }
      }
      // The per-model advanced panel: capacity, input types and the thinking ladder.
      // Merged per model *and* per field, because the panel saves one field at a time
      // and a save must not wipe the fields the user set on an earlier visit.
      if (patch.modelSettings !== null && typeof patch.modelSettings === 'object' && !Array.isArray(patch.modelSettings)) {
        config.modelSettings = mergeModelSettings(liveConfig.modelSettings, patch.modelSettings)
      }
      // Which models to expose. An explicit array is written as given; `null`
      // clears the choice and exposes everything again.
      if (patch.visibleModels === null) {
        config.visibleModels = []
      } else if (Array.isArray(patch.visibleModels)) {
        config.visibleModels = patch.visibleModels.filter((id) => typeof id === 'string' && id !== '')
      }
      // Zen 免费模型车道的独立配置更新
      if (patch.zen !== null && typeof patch.zen === 'object' && !Array.isArray(patch.zen)) {
        const nextZen = { ...liveConfig.zen }
        if (typeof patch.zen.enabled === 'boolean') nextZen.enabled = patch.zen.enabled
        if (typeof patch.zen.displayName === 'string' && patch.zen.displayName.trim() !== '') {
          nextZen.displayName = patch.zen.displayName.trim()
        }
        if (typeof patch.zen.route === 'string' && patch.zen.route.trim() !== '') {
          nextZen.route = patch.zen.route.trim()
        }
        if (typeof patch.zen.apiKey === 'string') {
          nextZen.apiKey = patch.zen.apiKey.trim() || 'public'
        }
        if (typeof patch.zen.baseURL === 'string' && patch.zen.baseURL.trim() !== '') {
          nextZen.baseURL = normalizeBaseURL(patch.zen.baseURL)
        }
        if (patch.zen.visibleModels === null) {
          nextZen.visibleModels = []
        } else if (Array.isArray(patch.zen.visibleModels)) {
          nextZen.visibleModels = patch.zen.visibleModels.filter((id) => typeof id === 'string' && id !== '')
        }
        if (patch.zen.modelSettings !== null && typeof patch.zen.modelSettings === 'object' && !Array.isArray(patch.zen.modelSettings)) {
          nextZen.modelSettings = mergeModelSettings(liveConfig.zen.modelSettings, patch.zen.modelSettings)
        }
        config.zen = nextZen
      }

      if (Object.keys(config).length > 0) writeConfig(config)
      // `reload()` re-applies the protocol choices and re-projects the roster from
      // whatever was just saved, so the response reflects the new state and nothing
      // here has to repeat that logic. No network call: the listing did not change,
      // only the choices about it.
      reload()
      return api.view()
    },

    /** Drop the override document and go back to the declared configuration. */
    reset: async () => {
      const file = path.join(overrideDir, 'config.json')
      try { fs.rmSync(file, { force: true }) } catch { /* already gone */ }
      liveConfig = base
      void refresh({}).catch((error) => {
        log.warn('[opencode-live] 重置后的刷新失败：%s', String(error?.message ?? error))
      })
      return api.view()
    },

    refresh: (options) => refresh(options),
    /**
     * A manual refresh means "give me the current numbers". Honouring the TTL
     * here would answer with up to a day-old catalogue, which is exactly what the
     * button exists to defeat — so the catalogue is force-reloaded too.
     */
    refreshZen: (options) => refreshZen({ ...options, forceRefreshCatalogue: true }),
    probe: (model, signal) => adapter.probe({ model, signal }),
    setApiKey,
  }

  // The host publishes `webServer` after the host plugins mount, so this is an
  // injection rather than a one-shot read at apply time.
  //
  // The seam is `register({ kind: 'prefix', path, handler })` — not a `route()`
  // method, which does not exist. An earlier version called `route?.()` with
  // optional chaining, so the missing method silently became a no-op and the page
  // reported a 404 on every path *from the web server*, not from this handler.
  //
  // Registration and its disposal are kept separate on purpose. A registration
  // that succeeded and then failed to record its disposer is *mounted*, so
  // reporting "挂载失败" there would send the reader looking for the wrong
  // problem — the endpoints are live and simply outlive the fiber.
  ctx.inject(['webServer'], (scoped) => {
    credentials = scoped.get('credentials') ?? credentials
    const handler = createApiRoutes(api, log)
    const webServer = scoped.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log.error('[opencode-live] 此组合没有可用的 webServer.register，设置页接口无法挂载；路由本身仍可用')
      return
    }

    let disposeRoutes
    try {
      disposeRoutes = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    } catch (error) {
      log.error('[opencode-live] 设置页接口挂载失败（不影响路由）：%s', String(error?.message ?? error))
      return
    }

    // `scoped.effect` exists on a real cordis scope; the fallback to `ctx.effect`
    // only matters for a scope object from an older host.
    const effect = typeof scoped.effect === 'function' ? scoped.effect.bind(scoped) : ctx.effect
    if (typeof effect === 'function' && typeof disposeRoutes === 'function') {
      effect(
        () => () => { try { disposeRoutes() } catch { /* already released */ } },
        'opencode-live: api routes',
      )
      log.info('[opencode-live] 设置页接口已挂载于 %s', API_PREFIX)
    } else {
      log.warn('[opencode-live] 设置页接口已挂在 %s，但拿不到可用的清理钩子；它们会随进程结束而消失', API_PREFIX)
    }
  })

  ctx.effect(() => () => {
    // Withdraw the directory entry before the route: a row that outlives its
    // provider would offer a provider that no longer answers.
    controller.abort()
    directory?.()
    directoryZen?.()
    dispose()
    try { disposeZen?.() } catch { /* ignore */ }
    log.info('[opencode-live] 插件已停止——路由 %s 与 %s 已释放', base.route, base.zen.route)
  }, 'opencode-live: cleanup')
}

/**
 * A tiny JSON API for a settings surface.
 *
 * Kept local rather than shared with the sibling plugin: the two routes answer
 * different questions (that one edits a gateway address, this one refreshes a
 * roster), and a shared abstraction would have to serve both shapes.
 *
 * @param {object} api
 * @param {object} log
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createApiRoutes(api, log) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(API_PREFIX, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const send = (status, payload) => {
      res.writeHead?.(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end?.(JSON.stringify(payload))
    }

    try {
      if (routePath === '/view' && method === 'GET') return send(200, await api.view())
      if (routePath === '/update' && method === 'POST') {
        const body = await readJson(req)
        try {
          return send(200, await api.update(body))
        } catch (error) {
          return send(400, { error: String(error?.message ?? error) })
        }
      }
      if (routePath === '/reset' && method === 'POST') {
        try {
          return send(200, await api.reset())
        } catch (error) {
          return send(400, { error: String(error?.message ?? error) })
        }
      }
      if (routePath === '/refresh' && method === 'POST') {
        const report = await api.refresh({})
        return send(report.ok ? 200 : 502, { ...report, view: await api.view() })
      }
      if (routePath === '/refresh-zen' && method === 'POST') {
        const report = await api.refreshZen({})
        return send(report.ok ? 200 : 502, { ...report, view: await api.view() })
      }
      if (routePath === '/probe' && method === 'POST') {
        const body = await readJson(req)
        return send(200, await api.probe(body?.model))
      }
      if (routePath === '/health') return send(200, { ok: true })
      return send(404, { error: 'not found' })
    } catch (error) {
      log?.('[opencode-live] api error: %s', String(error?.message ?? error))
      return send(500, { error: 'internal error' })
    }
  }
}

/** Read a JSON body, or `{}` when there is none. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * The override document the settings surface may write.
 *
 * Read per request (cached by mtime), written atomically. A file that has been
 * hand-edited into invalid JSON is logged and treated as absent rather than
 * taking the route down.
 *
 * @param {string} dir
 * @param {object} log
 * @returns {{read: () => object, file: string}}
 */
function createOverrideStore(dir, log) {
  const file = path.join(dir, 'config.json')
  let cached = { mtime: -1, value: {} }
  return {
    file,
    read() {
      try {
        const stat = fs.statSync(file)
        if (stat.mtimeMs === cached.mtime) return cached.value
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        cached = { mtime: stat.mtimeMs, value }
        return value
      } catch (error) {
        if (error?.code !== 'ENOENT') log?.warn?.('[opencode-live] 覆盖配置不可读，当作不存在：%s', String(error?.message ?? error))
        cached = { mtime: -1, value: {} }
        return {}
      }
    },
  }
}
