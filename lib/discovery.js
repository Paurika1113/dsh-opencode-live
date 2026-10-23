/**
 * Live model discovery.
 *
 * The installed pi-ai catalog is a **build-time snapshot** (`providers/data/
 * .manifest.json` records its `generatedAt`), and `dsh-llm-pi-ai` answers
 * "fetch available models" for any route that catalog describes straight from
 * that snapshot — no network call at all. So the official route's candidate list
 * is frozen at whatever shipped in the package, and a model the gateway added
 * afterwards can never appear there.
 *
 * This module is the missing half: it asks the gateway what it actually serves,
 * right now, and answers with that. It is registered under this plugin's own
 * settings namespace, so no catalog lookup is involved.
 *
 * Two disciplines are inherited from the surrounding codebase because they are
 * the right ones:
 *
 *   - an **authoritative empty listing** clears the roster, while a **failed
 *     round** keeps the previous one — a network blip must not empty a picker;
 *   - the reply is read under a byte ceiling, because the endpoint is a URL the
 *     deployment typed.
 *
 * @module dsh-opencode-live/discovery
 */

import { modelsEndpoint } from './config.js'
import {
  ZEN_CAPACITY_FALLBACK,
  isZenFreeModel,
  mintZenSessionId,
  zenGatewayHeaders,
  ZEN_FREE_PRESETS,
} from './zen-wire.js'

/** Endpoint replies larger than this are refused. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Why a discovery round produced no answer. */
export class DiscoveryError extends Error {
  constructor(message, code = 'DISCOVERY_FAILED', extra = {}) {
    super(message)
    this.name = 'DiscoveryError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Read a response body as text, refusing one that outgrows the ceiling.
 *
 * A declared length is checked first so an honest server is turned away before
 * anything is transferred; the accumulated total is what actually enforces the
 * bound, because a server that under-declares tells us nothing up front.
 *
 * @param {Response} response
 * @param {string} url
 * @returns {Promise<string>}
 */
async function readBounded(response, url) {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new DiscoveryError(`${url} 的响应超过 ${MAX_RESPONSE_BYTES} 字节`, 'DISCOVERY_TOO_LARGE')
  }
  if (response.body === null || response.body === undefined) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw new DiscoveryError(`${url} 的响应超过 ${MAX_RESPONSE_BYTES} 字节`, 'DISCOVERY_TOO_LARGE')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock?.()
  }
  return text
}

/**
 * Read one model listing.
 *
 * The parser accepts the standard `data` array and the enriched `models` map some
 * compatible gateways expose. Only object-valued map entries are models —
 * primitive properties are directory metadata, not records. Entries without a
 * usable id are skipped rather than failing the whole round: one malformed row
 * must not deny the user the rest of a working endpoint's catalog.
 *
 * @param {unknown} body - the parsed reply.
 * @returns {object[]} `{ id, name, contextWindow?, maxTokens? }`.
 * @throws {DiscoveryError} when the shape is neither.
 */
export function readListing(body) {
  const source = /** @type {Record<string, unknown>} */ (body ?? {})
  const data = source.data
  let listed
  if (Array.isArray(data)) {
    listed = data.map((raw) => ({ raw }))
  } else {
    const models = source.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new DiscoveryError(
        '端点返回的内容既不是 data 数组也不是 models 对象，请手工填写模型',
        'DISCOVERY_SHAPE',
      )
    }
    listed = Object.entries(models)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }

  const models = []
  const seen = new Set()
  for (const { key, raw } of listed) {
    const entry = /** @type {Record<string, unknown>} */ (raw ?? {})
    const id = typeof key === 'string' && key !== '' ? key : (typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = [entry.name, entry.display_name, entry.displayName]
      .find((value) => typeof value === 'string' && value !== '') ?? id
    models.push({
      id,
      name: /** @type {string} */ (name),
      ...capacityOf(entry),
    })
  }
  return models
}

/** Pick the first usable capacity field a listing entry discloses. */
function capacityOf(entry) {
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
    }
    return undefined
  }
  const contextWindow = pick(entry.contextWindow, entry.context_window, entry.context_length, entry.max_input_tokens)
  const maxTokens = pick(entry.maxOutputTokens, entry.max_output_tokens, entry.maxTokens, entry.max_completion_tokens)
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/**
 * Ask the gateway what it serves.
 *
 * Never throws for a transport or protocol failure: the caller is a settings
 * action, and a probe that throws is a probe the page has to guard. The failure
 * is reported rather than thrown so the page can keep showing the last good
 * roster beside the reason it could not refresh.
 *
 * @param {object} params
 * @param {string} params.baseURL - a normalized prefix.
 * @param {string} [params.apiKey] - bearer token, when one was resolved.
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.timeoutMs]
 * @param {(msg: string, ...rest: unknown[]) => void} [params.log]
 * @returns {Promise<{ok: true, models: object[], endpoint: string} | {ok: false, endpoint: string, message: string, status: number}>}
 */
export async function fetchLiveModels({ baseURL, apiKey, signal, timeoutMs = 15000, log, fetchImpl = fetch }) {
  const endpoint = modelsEndpoint(baseURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  const headers = { accept: 'application/json' }
  if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`

  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await readBounded(response, endpoint)

    if (!response.ok) {
      return {
        ok: false,
        endpoint,
        status: response.status,
        message: `模型列表返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? '（检查 API Key）' : ''}`,
      }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, endpoint, status: response.status, message: '模型列表不是合法 JSON' }
    }
    const models = readListing(body)
    return { ok: true, endpoint, models }
  } catch (error) {
    if (signal?.aborted === true) {
      return { ok: false, endpoint, status: 0, message: '刷新已取消' }
    }
    if (error?.name === 'AbortError') {
      return { ok: false, endpoint, status: 0, message: `网关在 ${timeoutMs}ms 内没有响应` }
    }
    if (error instanceof DiscoveryError) {
      return { ok: false, endpoint, status: 0, message: error.message }
    }
    log?.('[opencode-live] 模型列表请求失败：%s', String(error?.message ?? error))
    return {
      ok: false,
      endpoint,
      status: 0,
      message: `无法连接网关：${String(error?.message ?? error)}`,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 从 OpenCode Zen 免费端点同步模型列表。
 *
 * @param {object} params
 * @param {string} params.baseURL - 归一化的端点前缀（默认 https://opencode.ai/inference/v1）
 * @param {string} [params.apiKey] - 可选的 API Key（留空则使用免密 public）
 * @param {boolean} [params.onlyFree=true] - 是否仅保留免费模型
 * @param {Map<string, object> | null} [params.catalogue] - 官方容量目录
 *   （`zen-catalogue.js` 的产物），用于补齐 Zen 列表**不提供**的上下文/输出上限。
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.timeoutMs=15000]
 * @param {(msg: string, ...rest: unknown[]) => void} [params.log]
 * @returns {Promise<{ok: true, models: object[], endpoint: string} | {ok: false, endpoint: string, message: string, status: number}>}
 */
export async function fetchZenLiveModels({
  baseURL,
  apiKey,
  onlyFree = true,
  catalogue = null,
  signal,
  timeoutMs = 15000,
  log,
  fetchImpl = fetch,
}) {
  const endpoint = modelsEndpoint(baseURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  const headers = zenGatewayHeaders({
    session: mintZenSessionId(),
    apiKey,
    stream: false,
    accept: 'application/json',
  })

  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await readBounded(response, endpoint)

    if (!response.ok) {
      return {
        ok: false,
        endpoint,
        status: response.status,
        message: `Zen 免费模型列表返回 HTTP ${response.status}`,
      }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, endpoint, status: response.status, message: '模型列表不是合法 JSON' }
    }
    const all = readListing(body)
    const filtered = onlyFree ? all.filter((m) => isZenFreeModel(m.id)) : all
    const models = filtered.map((m) => {
      const known = catalogue?.get(m.id)
      const preset = ZEN_FREE_PRESETS[m.id]
      // Precedence: what the endpoint itself declared → the official catalogue →
      // the offline snapshot → a deliberately stingy fallback. The endpoint's own
      // answer wins because it is about *this* deployment; the catalogue covers the
      // common case where the endpoint says nothing (Zen's listing carries no
      // capacity field at all); the snapshot only exists so a machine with no
      // network still shows plausible numbers.
      return {
        ...m,
        name: known?.name ?? preset?.name ?? m.name,
        contextWindow:
          m.contextWindow ?? known?.contextWindow ?? preset?.contextWindow ?? ZEN_CAPACITY_FALLBACK.contextWindow,
        maxTokens: m.maxTokens ?? known?.maxTokens ?? preset?.maxTokens ?? ZEN_CAPACITY_FALLBACK.maxTokens,
        vision: m.vision ?? known?.vision ?? preset?.vision ?? false,
      }
    })
    return { ok: true, endpoint, models }
  } catch (error) {
    if (signal?.aborted === true) {
      return { ok: false, endpoint, status: 0, message: '刷新已取消' }
    }
    if (error?.name === 'AbortError') {
      return { ok: false, endpoint, status: 0, message: `Zen 网关在 ${timeoutMs}ms 内没有响应` }
    }
    if (error instanceof DiscoveryError) {
      return { ok: false, endpoint, status: 0, message: error.message }
    }
    log?.('[opencode-live] Zen 免费模型列表请求失败：%s', String(error?.message ?? error))
    return {
      ok: false,
      endpoint,
      status: 0,
      message: `无法连接 Zen 网关：${String(error?.message ?? error)}`,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
