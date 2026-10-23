/**
 * The route's adapter.
 *
 * It satisfies the harness adapter contract structurally — `providerInfo`,
 * `providerRetryPolicy`, `listModels`, `resolveModel`, `prepareCall`, and the
 * `stream` generator — so it can be registered with `ctx.llm.registerAdapter`
 * without importing anything from `@deepseek-ai/*` (which would not resolve from
 * a junctioned package).
 *
 * Three things happen here that no configuration-level fix can do:
 *
 *   1. **The model's own protocol decides the endpoint.** A model measured on
 *      `anthropic-messages` goes to `/v1/messages`, not `/v1/chat/completions`.
 *      A route-level `api` cannot express this; pi-ai's `sharedCatalogApi()`
 *      gives up on a route whose catalog spans dialects.
 *   2. **`x-opencode-session` is derived per conversation**, so the gateway can
 *      route a turn to the backend holding that conversation's prefix. A static
 *      profile header is stable but globally shared.
 *   3. **The roster is whatever discovery last read**, not a build-time snapshot.
 *
 * @module dsh-opencode-live/adapter
 */

import { endpointOf } from './config.js'
import { modalitiesFrom } from './capability.js'
import { ladderFor, ladderFromDeclared, resolveWire } from './effort.js'
import { protocolFor, usageOf } from './protocol.js'
import { SESSION_RE, requestIdFor, sessionForConversation } from './session.js'
import {
  applyZenFingerprint,
  isCanonicalZenSession,
  mintZenSessionId,
  zenGatewayHeaders,
  zenSessionForConversation,
} from './zen-wire.js'

/** Provider-reachable status → harness failure code. */
const CODE_BY_STATUS = new Map([
  [400, 'BAD_REQUEST'],
  [401, 'AUTH'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [408, 'TIMEOUT'],
  [409, 'CONFLICT'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [422, 'BAD_REQUEST'],
  [429, 'RATE_LIMIT'],
  [500, 'SERVER'],
  [502, 'SERVER'],
  [503, 'SERVER'],
  [504, 'TIMEOUT'],
])

/** Codes the harness retry scheduler should treat as transient. */
const RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']

/**
 * Dialect preference for a model measured on several.
 *
 * Ordered so a model that answers on more than one lands on the most native and
 * cheapest option: the OpenAI chat shape carries the widest tool-call support,
 * the Responses shape is second (some models only speak it, e.g. `grok-4.7`), and
 * the Messages shape is last because it needs its own auth header.
 */
const PROTOCOL_PREFERENCE = ['chat-completions', 'responses', 'anthropic-messages']

/**
 * The thinking-strength ladder this route offers.
 *
 * Deliberately *not* a single global list: the models behind this gateway disagree
 * about both the set of levels and whether thinking can be turned off at all, so
 * each family carries its own ladder in `./effort.js` (sourced from the vendor
 * documentation, not from probing). A model whose family is not in that table
 * advertises no ladder — showing no control is better than showing one the model
 * would reject.
 */
export { ladderFor }

/**
 * The lowercase tool quartet the *free* lane fingerprints.
 *
 * Measured on 2026-10-21: the Go subscription lane does **not** require it —
 * `minimax-m3.1-flash-free` answered 200 with no tools, one tool, and all four.
 * So this is off by default here, and left configurable for a deployment that
 * points the route at the free lane by mistake.
 */
export const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']
const QUARTET_DONORS = { bash: ['pwsh'] }
const DECOY_DESCRIPTION = 'This tool is currently unavailable and must not be used.'

function quartetKey(name) {
  const lower = String(name ?? '').trim().toLowerCase()
  return FINGERPRINT_TOOLS.includes(lower) ? lower : ''
}

/**
 * Raise a harness-classified transport or protocol failure.
 *
 * The adapter contract draws exactly two legal error paths: a transport or
 * protocol fault *throws* out of `stream()`, while a provider fault carried in a
 * response body ends the stream as `finish {kind:'error'}`. The harness class is
 * imported lazily so this module stays loadable — and unit testable — without the
 * workspace peer graph installed.
 *
 * @param {string} message
 * @param {string} code
 * @returns {Promise<Error>}
 */
async function transportFailure(message, code) {
  try {
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    return new LlmError(message, code)
  } catch {
    const error = new Error(message)
    error.failure = { message, code }
    return error
  }
}

function codeForStatus(status) {
  return CODE_BY_STATUS.get(status) ?? (status >= 500 ? 'SERVER' : 'PROVIDER')
}

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/** Flatten the text blocks of a content-block list. */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Flatten the reasoning blocks of a content-block list.
 *
 * A thinking model on this gateway rejects the next request with
 * `400 The reasoning_content in the thinking mode must be passed back to the API`
 * unless the assistant turn's reasoning is replayed, so this text travels in its
 * own field rather than being folded into `content`.
 */
function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Project harness messages onto the OpenAI chat-completions message shape.
 *
 * The harness models a tool result as its own `role: "tool"` message carrying a
 * top-level `toolCallId` — there is no `tool-result` content-block type anywhere
 * in the seam. Getting that wrong is not cosmetic: the gateway validates that every
 * call is answered and rejects the entire request with
 * `400 … tool call and result not match (2013)` as soon as a history contains a
 * tool turn, which is exactly the "worked for a few replies, then failed" shape.
 *
 * An assistant turn's reasoning is replayed in `reasoning_content`, which this
 * gateway requires before it accepts a follow-up turn from a thinking model.
 *
 * @param {readonly object[]} messages
 * @returns {object[]}
 */
export function toChatMessages(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []

    if (message.role === 'system') {
      const text = textOf(blocks)
      if (text) out.push({ role: 'system', content: text })
      continue
    }

    // The harness's tool result: its own message, identity on the message.
    if (message.role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId
      out.push({
        role: 'tool',
        tool_call_id: callId,
        content: message.isError === true ? `${textOf(blocks) || '(no output)'}` : textOf(blocks) || '(no output)',
      })
      continue
    }

    if (message.role === 'user') {
      // A nested tool-result block is not the current message model, but accepting
      // it keeps the projection from being brittle about stored history written by
      // an older producer.
      const results = blocks.filter((block) => block?.type === 'tool-result')
      if (results.length > 0) {
        for (const result of results) {
          out.push({
            role: 'tool',
            tool_call_id: result.toolCallId ?? result.tool_use_id,
            content: textOf(result.content) || '(no output)',
          })
        }
        continue
      }
      out.push({ role: 'user', content: textOf(blocks) })
      continue
    }

    if (message.role === 'assistant') {
      const calls = blocks.filter((block) => block?.type === 'tool-call')
      const entry = { role: 'assistant', content: textOf(blocks) || null }
      const reasoning = reasoningOf(blocks)
      if (reasoning) entry.reasoning_content = reasoning
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        }))
      }
      out.push(entry)
    }
  }
  return out
}

/** Project harness tool schemas onto the OpenAI `tools` array. */
function toToolDefs(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object') return ''
  if (typeof tool.function?.name === 'string' && tool.function.name.trim()) return tool.function.name.trim()
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  return ''
}

function chatTool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } }
}

/**
 * Satisfy the free-tier fingerprint gate on `body.tools`.
 *
 * Off by default on this route (see {@link FINGERPRINT_TOOLS}); when a deployment
 * turns it on, a genuinely absent quartet member is appended as a
 * self-disabling decoy so the gate is satisfied by a name without inviting a call
 * to a tool that does not exist.
 *
 * @param {object[]} tools
 * @returns {{tools: object[], rename: Map<string, string>}}
 */
export function applyFingerprint(tools) {
  const rename = new Map()
  const out = []
  const seen = new Set()

  for (const tool of tools) {
    const current = toolNameOf(tool)
    if (current === '') continue
    const key = quartetKey(current)
    if (key === '') {
      out.push(tool)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    if (current === key) {
      out.push(tool)
      continue
    }
    rename.set(key, current)
    out.push({ ...tool, function: { ...tool.function, name: key } })
  }

  if (!seen.has('bash')) {
    const donors = QUARTET_DONORS.bash
    const index = out.findIndex((tool) => donors.includes(toolNameOf(tool).toLowerCase()))
    if (index !== -1) {
      rename.set('bash', toolNameOf(out[index]))
      out[index] = { ...out[index], function: { ...out[index].function, name: 'bash' } }
      seen.add('bash')
    }
  }

  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    out.push(chatTool(name, DECOY_DESCRIPTION, { type: 'object', properties: {} }))
  }
  return { tools: out, rename }
}

/**
 * Restore the caller's tool spelling in a decoded tool call.
 *
 * @param {string} name
 * @param {Map<string, string>} map
 * @returns {string}
 */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}

/** Map a provider finish reason onto the harness finish vocabulary. */
function finishReason(reason, sawToolCall) {
  const normalized = String(reason ?? '').toLowerCase()
  if (normalized === 'tool_calls' || normalized === 'function_call' || normalized === 'tool_use') {
    return { kind: 'tool-calls' }
  }
  if (normalized === 'length' || normalized === 'max_tokens' || normalized === 'max_output_tokens') {
    return { kind: 'max-tokens' }
  }
  if (normalized === '' && sawToolCall) return { kind: 'tool-calls' }
  if (reason == null && sawToolCall) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Incrementally decode a `text/event-stream` body into JSON payloads.
 *
 * Yields one value per complete `data:` frame and ignores comments, the
 * terminator, and malformed frames — a gateway that interleaves a keep-alive must
 * not abort the turn.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<object>}
 */
async function* sseFrames(body, signal) {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.search(/\r?\n\r?\n/)
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2))
        const payload = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (payload && payload !== '[DONE]') {
          try {
            yield JSON.parse(payload)
          } catch {
            // A frame the gateway could not encode is not a reason to fail.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/)
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock?.()
  }
}

/** Normalize the provider's usage object into the disjoint harness counters. */
function toUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const prompt = Number(raw.prompt_tokens ?? 0)
  const completion = Number(raw.completion_tokens ?? 0)
  const cached = Number(raw.prompt_tokens_details?.cached_tokens ?? 0)
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? 0)
  const usage = {
    // The harness counts cached input separately, so it is subtracted out here
    // rather than folded into `inputTokens`.
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: Math.max(0, completion - reasoning),
  }
  const total = Number(raw.total_tokens ?? 0)
  if (total > 0) usage.totalTokens = total
  if (cached > 0) usage.cacheReadTokens = cached
  if (reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

export class OpenCodeLiveAdapter {
  /**
   * @param {object} deps
   * @param {object} deps.config - resolved plugin configuration.
   * @param {() => object} [deps.liveConfig] - configuration as it stands *now*.
   * @param {() => Record<string, {supported: string[], at: number}>} [deps.routeMap]
   *   - the per-model protocol matrix for this route, read per request so a
   *     refresh applies to the next turn without a restart.
   * @param {() => Array<object>} [deps.roster] - the models this route serves now.
   * @param {string} deps.attributionUserAgent - the harness's own `User-Agent`.
   * @param {string} [deps.apiKey]
   * @param {() => Promise<string|null>} [deps.resolveApiKey]
   * @param {(message: string, ...rest: unknown[]) => void} [deps.log]
   */
  constructor(deps) {
    this.deps = deps
    this.cachedApiKey = deps.apiKey || null
  }

  /** The configuration this request is built from. */
  config() {
    try {
      return this.deps.liveConfig?.() ?? this.deps.config
    } catch (error) {
      this.deps.log?.('[opencode-live] 读取当前配置失败，改用挂载时的配置：%s', String(error?.message ?? error))
      return this.deps.config
    }
  }

  /** The models this route serves right now. */
  roster() {
    try {
      const current = this.deps.roster?.()
      if (Array.isArray(current) && current.length > 0) return current
    } catch (error) {
      this.deps.log?.('[opencode-live] 读取模型清单失败：%s', String(error?.message ?? error))
    }
    return this.config().models ?? []
  }

  /** The protocol matrix for this route. */
  routeMap() {
    try {
      return this.deps.routeMap?.() ?? {}
    } catch {
      return {}
    }
  }

  /**
   * The bearer token for one request.
   *
   * An explicit `config.apiKey` wins outright: a deployment that writes its own
   * key is making a deliberate choice about which credential the route uses, and
   * a leftover key in the store must not quietly override it.
   *
   * @returns {Promise<{value: string, source: string}|null>}
   */
  async apiKey() {
    const configured = this.config().apiKey
    if (typeof configured === 'string' && configured !== '') return { value: configured, source: 'config' }

    if (this.deps.resolveApiKey) {
      try {
        const value = await this.deps.resolveApiKey()
        if (value) {
          this.cachedApiKey = value
          return { value, source: 'store' }
        }
      } catch (error) {
        this.deps.log?.('[opencode-live] 凭据查找失败：%s', String(error?.message ?? error))
      }
    }
    return this.cachedApiKey ? { value: this.cachedApiKey, source: 'cache' } : null
  }

  providerInfo(provider) {
    return { id: provider, name: this.config().displayName }
  }

  /**
   * A fully resolved policy, not a configuration fragment — the kernel stores
   * this object verbatim and the backoff scheduler reads the delay fields off the
   * top level.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: Object.freeze(RETRYABLE_CODES),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  async listModels(provider) {
    const config = this.config()
    return this.roster().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(entry.description ? { description: entry.description } : {}),
      inputModalities: modalitiesFrom(entry.id, config),
    }))
  }

  /**
   * The thinking ladder for one model.
   *
   * The user's declared table wins: they may have published a model whose vendor
   * never documented an effort control, or discovered that a level this table
   * offers is rejected. Falls back to the vendor-documentation table, and to
   * nothing at all when the family is unknown — the harness reads an absent
   * `reasoning` field as "no thinking control", which is the honest answer.
   *
   * @param {string} id
   * @param {object} config
   * @returns {object|undefined}
   */
  ladderOf(id, config) {
    const declared = config.modelSettings?.[id]?.reasoningEfforts
    if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
      // An empty table is a decision ("this model gets no thinking control"), so it
      // must not fall through to the documented ladder.
      return ladderFromDeclared(declared)
    }
    return ladderFor(id)
  }

  async resolveModel(provider, model) {
    const config = this.config()
    const id = baseModelId(model)
    const entry = this.roster().find((candidate) => candidate.id === id)
    const declared = config.modelSettings?.[id] ?? {}
    const contextWindow = declared.contextWindow ?? entry?.contextWindow ?? config.defaultContextWindow
    // The ladder is per model family, from the vendor's own documentation, unless
    // the user declared their own on the settings page.
    const ladder = this.ladderOf(id, config)
    return {
      provider,
      id,
      name: entry?.name ?? id,
      inputModalities: modalitiesFrom(id, config),
      context: { contextWindow },
      defaultMaxTokens: Math.min(declared.maxTokens ?? entry?.maxTokens ?? config.defaultMaxTokens, contextWindow),
      ...(ladder === undefined ? {} : {
        reasoning: {
          efforts: ladder.efforts.map((effort) => ({ ...effort })),
          ...(ladder.defaultEffort === null ? {} : { defaultEffort: ladder.defaultEffort }),
        },
      }),
    }
  }

  /**
   * Bind model metadata and the dispatch closure to one configuration
   * generation, so a refresh mid-turn cannot combine one generation's
   * capabilities with another's endpoint.
   */
  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * The protocol this model is dialled on.
   *
   * The user's per-model choice, then a declared model's own protocol, then the
   * default dialect. Never measured: choosing the dialect is the user's job on the
   * settings page, because only they know which models they actually intend to use
   * and guessing costs a wasted round trip on every wrong guess.
   *
   * @param {string} model
   * @returns {string}
   */
  protocolFor(model) {
    const entry = this.roster().find((candidate) => candidate.id === model)
    if (typeof entry?.protocol === 'string' && entry.protocol !== '') return entry.protocol
    const chosen = this.config().modelProtocols?.[model]
    if (typeof chosen === 'string' && chosen !== '') return chosen
    return PROTOCOL_PREFERENCE[0]
  }

  /**
   * The dialect to use. Mirrors {@link protocolFor} and exists so a caller has one
   * shape to switch on if a model ever gains an "unusable" state.
   *
   * @param {string} model
   * @returns {{protocol: string}}
   */
  resolveDialect(model) {
    return { protocol: this.protocolFor(model) }
  }

  /**
   * Build the headers for one request.
   *
   * `x-opencode-session` is applied last so a static `headers` entry cannot
   * silently flatten every conversation onto one id again.
   *
   * @param {object} options - `GenerateOptions`.
   * @param {string} session - derived per-conversation session id.
   * @param {string} protocol - canonical protocol name.
   * @returns {Promise<Record<string, string>>}
   */
  async headersFor(options, session, protocol) {
    const config = this.config()
    const headers = {}
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (typeof value === 'string' && value !== '') headers[name.toLowerCase()] = value
    }
    headers['user-agent'] = this.deps.attributionUserAgent
    headers['x-opencode-client'] = config.client
    headers['x-opencode-project'] = config.project
    headers['x-opencode-session'] = session
    headers['x-opencode-request'] = requestIdFor(options.sessionId, turnSeedOf(options))

    const credential = await this.apiKey()
    if (credential) {
      // The Messages dialect authenticates with x-api-key; the OpenAI dialects use
      // the configured header. Measured, not assumed: a Bearer token on /messages
      // answers 401 on this gateway.
      if (protocol === 'anthropic-messages' && (config.apiKeyHeader ?? '').toLowerCase() === 'authorization') {
        headers['x-api-key'] = credential.value
        headers['anthropic-version'] = '2023-06-01'
      } else {
        const header = typeof config.apiKeyHeader === 'string' && config.apiKeyHeader !== ''
          ? config.apiKeyHeader
          : 'authorization'
        const prefix = config.apiKeyPrefix === undefined ? 'Bearer ' : String(config.apiKeyPrefix)
        headers[header] = `${prefix}${credential.value}`
      }
    }
    return headers
  }

  /**
   * @param {object} options - `GenerateOptions`
   * @yields {object} `StreamChunk`
   */
  async * stream(options) {
    const config = this.config()
    const model = baseModelId(options.model)

    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { message: 'request aborted before dispatch', code: 'ABORTED' } },
      }
      return
    }

    // The dialect is the user's choice, recorded per model on the settings page.
    // A model nobody has classified is dialled on chat-completions, the dialect
    // most of this gateway accepts.
    const dialect = this.resolveDialect(model)
    if (dialect.unsupported !== undefined) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: dialect.unsupported, code: 'UNSUPPORTED_MODEL' } },
      }
      return
    }
    const protocolName = dialect.protocol
    const protocol = protocolFor(protocolName)
    const session = sessionForConversation(options.sessionId)

    const hadClientTools = Array.isArray(options.tools) && options.tools.length > 0
    const declared = toToolDefs(options.tools) ?? []
    const fingerprinted = config.fingerprint
      ? applyFingerprint(declared)
      : { tools: declared, rename: new Map() }

    const declaredSettings = config.modelSettings?.[model]?.reasoningEfforts
    const payload = protocol.build(options, model, {
      messages: toChatMessages(options.messages),
      tools: fingerprinted.tools,
      toolChoice: hadClientTools && fingerprinted.tools.length > 0 ? 'auto' : 'none',
      // The request value for the chosen level. The user's declared table pairs
      // each level with its own value; without one the level is translated from
      // our own vocabulary. `undefined` here means "send no thinking control".
      wireEffort: resolveWire(options.reasoningEffort, declaredSettings),
    })

    const headers = await this.headersFor(options, session, protocolName)
    const endpoint = endpointOf(config.baseURL, protocol.path)

    this.deps.log?.(
      '[opencode-live] %s [%s] → %s  session=%s request=%s',
      config.route, protocolName, model, session, headers['x-opencode-request'],
    )

    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      throw await transportFailure(`transport failure: ${String(error?.message ?? error)}`, 'TRANSPORT')
    }

    if (!response.ok) {
      yield { type: 'finish', reason: { kind: 'error', failure: await describeFailure(response, protocolName, model) } }
      return
    }

    // Block bookkeeping. Indexes are allocated on first use and every open block
    // is closed before the terminal finish, in allocation order.
    let next = 0
    let textIndex = null
    let textSoFar = ''
    let reasoningIndex = null
    let reasoningSoFar = ''
    const toolBlocks = new Map()
    let sawToolCall = false
    let providerFinish = null
    let usageReport = {}

    try {
      for await (const frame of sseFrames(response.body, options.signal)) {
        const usage = usageOf(frame)
        if (usage !== undefined) {
          // A dialect that reports cached input on a later frame than the one
          // carrying the totals still has to land on the same usage record, so the
          // last report that carries a field wins rather than being dropped.
          usageReport = { ...usageReport, ...toUsage(usage) }
        }

        const { deltas, finish } = protocol.read(frame)
        // First non-null wins. The Messages dialect reports `stop_reason` on
        // `message_delta` and then a terminal `message_stop` carrying only
        // `end_turn`; letting the later one overwrite would turn a tool-use turn
        // into a `stop` and strand the call. The other two dialects report once.
        if (finish !== null && providerFinish === null) providerFinish = finish

        for (const delta of deltas) {
          if (delta.kind === 'reasoning' && typeof delta.text === 'string' && delta.text !== '') {
            if (reasoningIndex === null) {
              reasoningIndex = next++
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
            }
            reasoningSoFar += delta.text
            yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.text }
          } else if (delta.kind === 'text' && typeof delta.text === 'string' && delta.text !== '') {
            if (textIndex === null) {
              textIndex = next++
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            textSoFar += delta.text
            yield { type: 'text-delta', index: textIndex, text: delta.text }
          } else if (delta.kind === 'tool-call') {
            let block = toolBlocks.get(delta.key)
            if (!block) {
              block = { index: next++, id: delta.id ?? `call_${next}`, name: '', args: '' }
              toolBlocks.set(delta.key, block)
              sawToolCall = true
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            if (typeof delta.id === 'string' && delta.id) block.id = delta.id
            if (typeof delta.name === 'string' && delta.name) {
              block.name = restoreToolName(delta.name, fingerprinted.rename)
            }
            if (typeof delta.argumentsDelta === 'string' && delta.argumentsDelta !== '') {
              block.args += delta.argumentsDelta
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.id,
                ...(block.name ? { name: block.name } : {}),
                argumentsDelta: delta.argumentsDelta,
              }
            }
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'stream aborted', code: 'ABORTED' } } }
        return
      }
      throw await transportFailure(`stream failure: ${String(error?.message ?? error)}`, 'TRANSPORT')
    }

    // Close every open block, in allocation order.
    if (reasoningIndex !== null) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningSoFar } }
    }
    if (textIndex !== null) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textSoFar } }
    }
    for (const block of toolBlocks.values()) {
      yield {
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args || '{}' },
      }
    }

    if (Object.keys(usageReport).length > 0) yield { type: 'usage', usage: usageReport }
    yield { type: 'finish', reason: finishReason(providerFinish, sawToolCall) }
  }

  /**
   * Send the smallest request the configuration allows, and report what came back.
   *
   * This is the check a person changing the gateway address, the key or a model's
   * protocol actually wants: all three mistakes are invisible until a request is
   * sent, and each produces a different error.
   *
   * @param {object} [options]
   * @param {string} [options.model]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ok: boolean, status: number, endpoint: string, protocol: string, message: string}>}
   */
  async probe(options = {}) {
    const config = this.config()
    const model = baseModelId(options.model ?? this.roster()[0]?.id ?? '')
    const dialect = this.resolveDialect(model)
    if (dialect.unsupported !== undefined) {
      return { ok: false, status: 0, endpoint: '', protocol: '', message: dialect.unsupported }
    }
    const protocolName = dialect.protocol
    const protocol = protocolFor(protocolName)
    const endpoint = endpointOf(config.baseURL, protocol.path)
    const headers = await this.headersFor({ sessionId: `probe-${model}` }, sessionForConversation(`probe-${model}`), protocolName)
    const payload = protocol.build(
      { maxTokens: 1 },
      model,
      { messages: [{ role: 'user', content: 'ping' }], tools: [], toolChoice: 'none' },
    )

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        const failure = await describeFailure(response, protocolName, model)
        return { ok: false, status: response.status, endpoint, protocol: protocolName, message: failure.message }
      }
      // Cancel rather than drain on success: the point is the status line, and a
      // completion nobody reads is still a completion somebody pays for.
      await response.body?.cancel().catch(() => {})
      return { ok: true, status: response.status, endpoint, protocol: protocolName, message: '网关接受了请求（HTTP 200）' }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        endpoint,
        protocol: protocolName,
        message: options.signal?.aborted === true
          ? '请求已取消'
          : `无法连接：${String(error?.message ?? error)}（检查地址、协议与网络）`,
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * A per-turn token that stays constant across retries of the same turn, so the
 * gateway can collapse a retry onto the request it already saw.
 *
 * @param {object} options - `GenerateOptions`
 * @returns {string}
 */
function turnSeedOf(options) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user' && message?.source?.kind === 'user' && message.id) return String(message.id)
  }
  return ''
}

/**
 * Turn a non-2xx response into a harness failure.
 *
 * @param {Response} response
 * @param {string} protocolName
 * @param {string} model
 * @returns {Promise<object>}
 */
async function describeFailure(response, protocolName, model) {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 600)
  } catch {
    // A body that cannot be read is not a reason to lose the status.
  }
  let message = `opencode gateway returned HTTP ${response.status}`
  if (detail) {
    try {
      const parsed = JSON.parse(detail)
      const err = parsed?.error
      const text = typeof err === 'string' ? err : (err?.message ?? parsed?.message)
      if (typeof text === 'string' && text) message = `${message}: ${text}`
    } catch {
      message = `${message}: ${detail}`
    }
  }
  // A wrong-protocol refusal is actionable only if it names the protocol that was
  // tried and the one that might work, so the reader is not left guessing.
  if (response.status === 400 && /does not support this protocol/i.test(detail)) {
    message += `（模型 ${model} 不接受 ${protocolName}；到设置页把它的协议改成别的试试。实测：claude-haiku-5-5、minimax-m2.7 只吃 anthropic-messages，grok-4.6/4.7 只吃 responses）`
  }
  const retryAfter = Number(response.headers?.get?.('retry-after'))
  return {
    message,
    code: codeForStatus(response.status),
    status: response.status,
    ...(Number.isFinite(retryAfter) && retryAfter > 0
      ? { providerRetryAfterMs: Math.round(retryAfter * (retryAfter > 100 ? 1 : 1000)) }
      : {}),
  }
}

/** Re-exported so a test can assert the shape the gateway must receive. */
export { SESSION_RE, requestIdFor, sessionForConversation }

/**
 * OpenCode Zen 免费模型车道的独立适配器。
 *
 * 满足与 OpenCodeLiveAdapter 相同的 Harness 接口契约，但底层通信针对 Zen 免费门禁做特化：
 * 1. 强制走 https://opencode.ai/inference/v1/chat/completions (chat-completions 方言)；
 * 2. 注入官方 CLI read/shell 工具定义及占位警告（规避 403 FreeTierError）；
 * 3. 绝不下发 tool_choice: 'none'；
 * 4. 强制 stream: true；
 * 5. 使用倒序 hex 编码的时间戳 session id，多轮会话绑定同一 id；
 * 6. 支持免密 public 或自定义 key。
 */
export class OpenCodeZenFreeAdapter {
  constructor(deps) {
    this.deps = deps
  }

  config() {
    return this.deps.liveConfig?.() ?? this.deps.config
  }

  roster() {
    return this.deps.roster()
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: this.config().displayName,
    }
  }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: Object.freeze(RETRYABLE_CODES),
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      jitterRatio: 0.2,
    })
  }

  async listModels(provider) {
    const config = this.config()
    return this.roster().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
      inputModalities: modalitiesFrom(entry.id, config),
    }))
  }

  ladderOf(id, config) {
    const declared = config.modelSettings?.[id]?.reasoningEfforts
    if (declared !== undefined) {
      return ladderFromDeclared(declared)
    }
    return ladderFor(id)
  }

  async resolveModel(provider, model) {
    const config = this.config()
    const id = baseModelId(model)
    const entry = this.roster().find((candidate) => candidate.id === id)
    const declared = config.modelSettings?.[id] ?? {}
    const contextWindow = declared.contextWindow ?? entry?.contextWindow ?? 131072
    const ladder = this.ladderOf(id, config)

    return {
      provider,
      id: model,
      name: entry?.name ?? id,
      inputModalities: modalitiesFrom(id, config),
      context: { contextWindow },
      defaultMaxTokens: Math.min(declared.maxTokens ?? entry?.maxTokens ?? 32768, contextWindow),
      ...(ladder === undefined ? {} : {
        reasoning: {
          efforts: ladder.efforts.map((effort) => ({ ...effort })),
          ...(ladder.defaultEffort === null ? {} : { defaultEffort: ladder.defaultEffort }),
        },
      }),
    }
  }

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  async * stream(options) {
    const config = this.config()
    const model = baseModelId(options.model)

    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { message: 'request aborted before dispatch', code: 'ABORTED' } },
      }
      return
    }

    const session = zenSessionForConversation(options.sessionId)
    const protocolName = 'chat-completions'
    const protocol = protocolFor(protocolName)

    const declared = toToolDefs(options.tools) ?? []
    const declaredSettings = config.modelSettings?.[model]?.reasoningEfforts

    const payload = protocol.build(options, model, {
      messages: toChatMessages(options.messages),
      tools: declared,
      toolChoice: declared.length > 0 ? 'auto' : undefined,
      wireEffort: resolveWire(options.reasoningEffort, declaredSettings),
    })

    // 应用 Zen 免费车道门禁指纹（注入 read/shell 官方工具与警告，强制 stream: true，清除 none）
    const placeholderDecoys = applyZenFingerprint(payload)

    const apiKey = typeof config.apiKey === 'string' && config.apiKey.trim() ? config.apiKey.trim() : 'public'
    const headers = zenGatewayHeaders({
      session,
      apiKey,
      stream: true,
    })
    const endpoint = endpointOf(config.baseURL, '/chat/completions')

    this.deps.log?.(
      '[opencode-zen-free] %s [%s] → %s session=%s',
      config.route, protocolName, model, session,
    )

    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      throw await transportFailure(`transport failure: ${String(error?.message ?? error)}`, 'TRANSPORT')
    }

    if (!response.ok) {
      yield { type: 'finish', reason: { kind: 'error', failure: await describeFailure(response, protocolName, model) } }
      return
    }

    let next = 0
    let textIndex = null
    let textSoFar = ''
    let reasoningIndex = null
    let reasoningSoFar = ''
    const toolBlocks = new Map()
    let sawToolCall = false
    let providerFinish = null
    let usageReport = {}

    try {
      for await (const frame of sseFrames(response.body, options.signal)) {
        const usage = usageOf(frame)
        if (usage !== undefined) {
          usageReport = { ...usageReport, ...toUsage(usage) }
        }

        const { deltas, finish } = protocol.read(frame)
        if (finish !== null && providerFinish === null) providerFinish = finish

        for (const delta of deltas) {
          if (delta.kind === 'reasoning' && typeof delta.text === 'string' && delta.text !== '') {
            if (reasoningIndex === null) {
              reasoningIndex = next++
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
            }
            reasoningSoFar += delta.text
            yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.text }
          } else if (delta.kind === 'text' && typeof delta.text === 'string' && delta.text !== '') {
            if (textIndex === null) {
              textIndex = next++
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            textSoFar += delta.text
            yield { type: 'text-delta', index: textIndex, text: delta.text }
          } else if (delta.kind === 'tool-call') {
            let block = toolBlocks.get(delta.key)
            if (!block) {
              block = { index: null, id: undefined, name: '', args: '', dropped: false, opened: false }
              toolBlocks.set(delta.key, block)
            }
            if (typeof delta.id === 'string' && delta.id) block.id = delta.id
            if (typeof delta.name === 'string' && delta.name) block.name = delta.name
            if (typeof delta.argumentsDelta === 'string' && delta.argumentsDelta !== '') {
              block.args += delta.argumentsDelta
            }

            // A call is only published once its name is known: the decoy filter
            // needs the name, and a name that arrives after the first argument
            // fragment would otherwise leave an unnamed call behind. Anything
            // buffered is flushed as one delta the moment the name resolves.
            if (block.opened) {
              if (typeof delta.argumentsDelta === 'string' && delta.argumentsDelta !== '') {
                yield {
                  type: 'tool-call-delta',
                  index: block.index,
                  id: block.id,
                  ...(block.name ? { name: block.name } : {}),
                  argumentsDelta: delta.argumentsDelta,
                }
              }
            } else if (!block.dropped && block.name !== '') {
              if (placeholderDecoys.has(block.name.toLowerCase())) {
                // An injected decoy was called; the request never declared it.
                block.dropped = true
              } else {
                block.index = next++
                block.opened = true
                block.id ??= `call_${block.index + 1}`
                sawToolCall = true
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
                if (block.args !== '') {
                  yield {
                    type: 'tool-call-delta',
                    index: block.index,
                    id: block.id,
                    name: block.name,
                    argumentsDelta: block.args,
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      throw await transportFailure(`stream decode error: ${String(error?.message ?? error)}`, 'TRANSPORT')
    }

    if (reasoningIndex !== null) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningSoFar } }
    }
    if (textIndex !== null) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textSoFar } }
    }
    for (const block of toolBlocks.values()) {
      // A dropped block called an injected placeholder that the request never
      // declared; it must not reach the executor.
      if (block.dropped) continue
      if (!block.opened) {
        // The name never arrived. Publishing what we have keeps the turn honest:
        // silently discarding it would look like the model called nothing.
        block.index = next++
        block.opened = true
        block.id ??= `call_${block.index + 1}`
        sawToolCall = true
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        if (block.args !== '') {
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: block.id,
            ...(block.name ? { name: block.name } : {}),
            argumentsDelta: block.args,
          }
        }
      }
      yield {
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args || '{}' },
      }
    }

    if (Object.keys(usageReport).length > 0) yield { type: 'usage', usage: usageReport }
    // A gateway that announced tool use can still end with no call to run: every
    // call it sent was an injected decoy, dropped above. Keeping `tool-calls`
    // there would strand the loop waiting for results from a turn that has none,
    // so that turn completes as a plain stop instead.
    const announcesToolUse = providerFinish === 'tool_calls'
      || providerFinish === 'function_call'
      || providerFinish === 'tool_use'
    const effectiveFinish = announcesToolUse && !sawToolCall ? null : providerFinish
    yield { type: 'finish', reason: finishReason(effectiveFinish, sawToolCall) }
  }
}
