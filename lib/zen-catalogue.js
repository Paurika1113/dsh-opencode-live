/**
 * OpenCode Zen 模型容量目录（上下文长度与输出上限）。
 *
 * 为什么需要这个模块：Zen 的 `/models` 端点只回答
 * `{ id, object, created, owned_by }` —— **不含任何容量字段**。所以上下文长度
 * 和输出上限只能从别处取，而硬编码一份「看起来合理」的数字正是上一版的错误
 * 来源：它把 Go 车道的容量（1M 上下文 / 384k 输出）张冠李戴给了免费模型，
 * 而免费模型的真实上限是 200k / 32k。
 *
 * 权威来源是 OpenCode 官方的模型目录 `https://models.dev/api.json`：这正是
 * opencode CLI 自己在运行时拉取并缓存的同一份数据（CLI 二进制里带有
 * `Failed to fetch models.dev` / `Failed to cache models.dev catalog` 两条
 * 错误字符串，而其 `Model.Info` 默认值就是 `{ context: 200000, output: 32000 }`）。
 * 该文件里 provider `opencode` 的每个模型带 `limit: { context, input?, output }`，
 * 与 opencode 自己的配置 schema（`https://opencode.ai/config.json` 中
 * `Config.ModelEncoded.limit` 的 `{ context, input, output }`）同构。
 *
 * 关于体积：`api.json` 是全量目录（约 5.6 MB 解压后），远超「顺手拉一下」的
 * 尺度。因此本模块**只做纯解析**，网络与缓存策略留在调用方——它拿到文本，
 * 这里负责把它裁成「本插件关心的那几十个 id → 容量」的小表。
 *
 * @module dsh-opencode-live/zen-catalogue
 */

/** 官方模型目录。opencode CLI 用的是同一个 URL。 */
export const CATALOGUE_URL = 'https://models.dev/api.json'

/** 目录里承载 OpenCode Zen 模型的那个 provider id。 */
export const CATALOGUE_PROVIDER = 'opencode'

/**
 * 把 `limit` 记录读成 `{ contextWindow, maxTokens }`。
 *
 * `input` 比 `context` 更紧时用它 —— 少数条目（如 `big-pickle`、
 * `nemotron-3.5-super-vl-free`）声明了 `input` 限制，模型的可用提示长度以
 * 两者中更小的那个为准，报大了会让调用方一头撞进上游 400。
 *
 * @param {unknown} limit
 * @returns {{ contextWindow?: number, maxTokens?: number }}
 */
export function capacityFromLimit(limit) {
  const positive = (value) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
  if (limit === null || typeof limit !== 'object') return {}
  const source = /** @type {Record<string, unknown>} */ (limit)
  const context = positive(source.context)
  const input = positive(source.input)
  const output = positive(source.output)
  const contextWindow =
    context === undefined ? input : input === undefined ? context : Math.min(context, input)
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(output === undefined ? {} : { maxTokens: output }),
  }
}

/**
 * 从一个已解析的目录里取出 OpenCode Zen 的容量表。
 *
 * 返回值只包含真的带了容量的条目：目录条目缺 `limit` 时**留空**，
 * 让调用方去回退（默认可视作未知），而不是编一个数字出来。
 *
 * @param {unknown} catalogue - `models.dev/api.json` 的解析结果。
 * @returns {Map<string, { contextWindow?: number, maxTokens?: number, name?: string, vision?: boolean, reasoning?: boolean }>}
 */
export function readCatalogue(catalogue) {
  const table = new Map()
  const providers = /** @type {Record<string, unknown>} */ (catalogue ?? {})
  const provider = /** @type {Record<string, unknown> | undefined} */ (providers[CATALOGUE_PROVIDER])
  const models = provider?.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return table

  for (const [id, raw] of Object.entries(/** @type {Record<string, unknown>} */ (models))) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = /** @type {Record<string, unknown>} */ (raw)
    const capacity = capacityFromLimit(entry.limit)
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : undefined
    // 目录用 `modalities.input` 是否含 `image` 表达图片输入能力；插件侧的字段叫
    // `vision`，这里顺手翻译好，免得每个调用点各写一遍。
    const modalities = /** @type {Record<string, unknown> | undefined} */ (entry.modalities)
    const inputs = Array.isArray(modalities?.input) ? modalities.input : []
    const vision = inputs.includes('image')
    const reasoning = entry.reasoning === true
    table.set(id, {
      ...capacity,
      ...(name === undefined ? {} : { name }),
      vision,
      reasoning,
    })
  }
  return table
}

/**
 * 从目录文本里只抽出 `opencode` 这一个 provider 的记录。
 *
 * 缓存不该保存整份 5.6 MB 的全量目录：里面 99% 是别的 provider 的模型，
 * 而这个插件只关心 Zen 那几十条。裁完通常只有几十 KB。
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null} 只含一个 provider 的精简目录。
 */
export function extractProvider(text) {
  const full = JSON.parse(text)
  const provider = /** @type {Record<string, unknown> | undefined} */ (
    /** @type {Record<string, unknown>} */ (full ?? {})[CATALOGUE_PROVIDER]
  )
  if (provider === null || provider === undefined || typeof provider !== 'object') return null
  // 只留下解析器真的读的字段，别的连体积一起丢掉。
  const models = /** @type {Record<string, unknown>} */ (provider.models ?? {})
  const kept = {}
  for (const [id, raw] of Object.entries(models)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = /** @type {Record<string, unknown>} */ (raw)
    const modalities = /** @type {Record<string, unknown> | undefined} */ (entry.modalities)
    kept[id] = {
      name: entry.name,
      limit: entry.limit,
      reasoning: entry.reasoning,
      modalities: modalities === undefined ? undefined : { input: modalities.input },
    }
  }
  return { [CATALOGUE_PROVIDER]: { id: CATALOGUE_PROVIDER, models: kept } }
}

/**
 * 解析目录文本并取出容量表。
 *
 * @param {string} text
 * @returns {Map<string, { contextWindow?: number, maxTokens?: number, name?: string, vision?: boolean, reasoning?: boolean }>}
 * @throws {Error} 文本不是合法 JSON 时。
 */
export function parseCatalogue(text) {
  return readCatalogue(JSON.parse(text))
}

/** 目录端点回复超过这个大小就拒绝——它是外部 URL，不能无界读取。 */
const MAX_CATALOGUE_BYTES = 32 * 1024 * 1024

/** 缓存有效期。目录一天更新几次，一小时足够新，又不至于每次刷新都重下 5 MB。 */
export const CATALOGUE_TTL_MS = 60 * 60 * 1000

/**
 * 读取一个可能超大的响应体，超过上限即中止。
 *
 * @param {Response} response
 * @param {string} url
 * @returns {Promise<string>}
 */
async function readBounded(response, url) {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_CATALOGUE_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`${url} 的响应超过 ${MAX_CATALOGUE_BYTES} 字节`)
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
      if (total > MAX_CATALOGUE_BYTES) throw new Error(`${url} 的响应超过 ${MAX_CATALOGUE_BYTES} 字节`)
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
 * 拉取并解析官方目录，带磁盘缓存。
 *
 * 失败是**软**的：拿不到就返回上一份缓存（哪怕过期），再不行返回 `null`，
 * 由调用方回退到离线快照。一个网络抖动不该让设置页变成空白。
 *
 * @param {object} [options]
 * @param {string} [options.url=CATALOGUE_URL]
 * @param {string} [options.cachePath] - 缓存文件路径；缺省则不落盘（纯内存）。
 * @param {number} [options.ttlMs=CATALOGUE_TTL_MS]
 * @param {number} [options.timeoutMs=20000]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.forceRefresh=false]
 * @param {(msg: string, ...rest: unknown[]) => void} [options.log]
 * @returns {Promise<{ table: Map<string, object> | null, source: 'network' | 'cache' | 'none', at: number, message: string, url: string }>}
 */
export async function loadCatalogue({
  url = CATALOGUE_URL,
  cachePath,
  ttlMs = CATALOGUE_TTL_MS,
  timeoutMs = 20000,
  signal,
  forceRefresh = false,
  log,
  fetchImpl = fetch,
} = {}) {
  let cached = null
  if (typeof cachePath === 'string' && cachePath !== '') {
    try {
      const fs = await import('node:fs')
      const raw = fs.readFileSync(cachePath, 'utf8')
      const parsed = JSON.parse(raw)
      // `catalogue` is the trimmed provider blob written above; an older cache
      // written by a previous revision carries `text` instead. Accept both so an
      // upgrade does not have to invalidate the file.
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.at === 'number') {
        if (parsed.catalogue !== null && typeof parsed.catalogue === 'object') {
          cached = { at: parsed.at, catalogue: parsed.catalogue }
        } else if (typeof parsed.text === 'string') {
          cached = { at: parsed.at, text: parsed.text }
        }
      }
    } catch {
      // No cache yet, or a truncated write from a previous crash. Both are
      // "no usable cache", not an error worth surfacing.
    }
  }

  /** @param {{ at: number, catalogue?: object, text?: string }} entry */
  const tableOf = (entry) =>
    entry.catalogue === undefined ? parseCatalogue(entry.text) : readCatalogue(entry.catalogue)

  const now = Date.now()
  if (!forceRefresh && cached !== null && now - cached.at < ttlMs) {
    try {
      return { table: tableOf(cached), source: 'cache', at: cached.at, message: '使用缓存的模型目录', url }
    } catch {
      // Fall through: a corrupt cache must not win over a fresh fetch.
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`目录返回 HTTP ${response.status}`)
    const text = await readBounded(response, url)
    const table = parseCatalogue(text)
    const at = Date.now()
    if (typeof cachePath === 'string' && cachePath !== '') {
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        // Cache the *trimmed* catalogue, not the 5.6 MB original: only this
        // plugin's provider is ever read back, so storing the rest would be six
        // megabytes of dead weight per entry.
        const trimmed = extractProvider(text)
        const temp = `${cachePath}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify({ at, url, catalogue: trimmed }), 'utf8')
        fs.renameSync(temp, cachePath)
      } catch (error) {
        log?.('[opencode-live] 模型目录缓存写入失败：%s', String(error?.message ?? error))
      }
    }
    return { table, source: 'network', at, message: `已获取 ${table.size} 条模型容量`, url }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `在 ${timeoutMs}ms 内没有响应` : String(error?.message ?? error)
    if (cached !== null) {
      try {
        const table = tableOf(cached)
        log?.('[opencode-live] 模型目录刷新失败（沿用 %s 的缓存）：%s', new Date(cached.at).toISOString(), reason)
        return { table, source: 'cache', at: cached.at, message: `刷新失败，沿用缓存：${reason}`, url }
      } catch { /* the cache was unusable after all */ }
    }
    log?.('[opencode-live] 模型目录获取失败（回退离线快照）：%s', reason)
    return { table: null, source: 'none', at: 0, message: `无法获取模型目录：${reason}`, url }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
