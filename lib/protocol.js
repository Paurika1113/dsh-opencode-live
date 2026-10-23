/**
 * Wire protocols.
 *
 * The gateway is addressed by an OpenAI-shaped API, but its models do **not**
 * all speak the same dialect — measured on 2026-10-21 across the full 37-model
 * listing:
 *
 *   - `grok-4.6` / `grok-4.7`        answer only on `responses`
 *   - `claude-haiku-5-5`             answers only on `messages`
 *   - `minimax-m2.7`                 answers only on `messages`
 *   - most `glm-*` / `kimi-*` / `qwen-*` answer on `chat-completions` + `responses`
 *   - `minimax-m3.1-flash-free`      answers on all three
 *
 * So the choice is per-model, and it belongs here rather than as branches
 * through the stream loop. Each protocol is one object with four
 * responsibilities: name its endpoint path, build a request body from
 * `GenerateOptions`, produce the authentication headers it needs, and turn one
 * streamed frame into the deltas the adapter's block bookkeeping consumes.
 *
 * @module dsh-opencode-live/protocol
 */

/** The dialects this adapter can speak, in default preference order. */
export const PROTOCOLS = ['chat-completions', 'responses', 'anthropic-messages']

/** The protocol used when a model declares none. */
export const DEFAULT_PROTOCOL = 'chat-completions'

/** Stable API version required by the Anthropic Messages endpoint. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * True for a name this module can speak.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProtocol(value) {
  return typeof value === 'string' && PROTOCOLS.includes(value)
}

/* -- shared ---------------------------------------------------------------- */

/**
 * Fields both OpenAI dialects understand.
 *
 * @param {object} options - `GenerateOptions`.
 * @param {string} model - the resolved model id.
 * @returns {object}
 */
function commonPayload(options, model) {
  const payload = { model, stream: true }
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    payload.temperature = options.temperature
  }
  return payload
}

/**
 * Turn a harness effort id into the value one dialect puts on the wire.
 *
 * The id is our stable vocabulary (see `./effort.js`); this is where it becomes
 * something a vendor accepts. Two rules matter:
 *
 *   - `off` means **send nothing**. It is deliberately not the string `none`:
 *     MiniMax documents that `effort: "none"` returns 400 for models that require
 *     adaptive thinking, and Grok rejects it too, while omitting the field is
 *     accepted everywhere.
 *   - `none` is a *real* level only OpenAI exposes ("thinking off"), so it maps to
 *     the literal string and is never collapsed into omission.
 *
 * An id this table does not know is passed through unchanged, so a deployment can
 * name its own level and let the vendor judge it.
 *
 * @param {unknown} effort - `GenerateOptions.reasoningEffort`.
 * @param {'openai'|'anthropic'} [dialect]
 * @returns {string|undefined} the wire value, or undefined for "send nothing".
 */
export function wireEffort(effort, dialect = 'openai') {
  if (typeof effort !== 'string' || effort === '') return undefined
  if (effort === 'off') return undefined
  // Unknown-to-us ids (including `none`) travel as written.
  return effort
}

/**
 * The thinking value a request should carry.
 *
 * The adapter resolves it first, because a user-declared table on the settings
 * page pairs each level with its own request value; only when it does not supply
 * one (a direct `build` call, as in the unit tests) is the level translated from
 * our own vocabulary. `parts.wireEffort === null` is "send nothing", which must
 * stay distinct from "not provided".
 *
 * @param {object} options - `GenerateOptions`.
 * @param {object} [parts]
 * @returns {string|undefined}
 */
function effortOf(options, parts, dialect = 'openai') {
  if (parts !== null && parts !== undefined && 'wireEffort' in parts) {
    const supplied = parts.wireEffort
    return typeof supplied === 'string' && supplied !== '' ? supplied : undefined
  }
  return wireEffort(options.reasoningEffort, dialect)
}

/**
 * Apply the thinking controls an OpenAI-shaped body takes.
 *
 * @param {object} payload
 * @param {object} options - `GenerateOptions`.
 * @param {object} [parts]
 * @returns {object} the same payload.
 */
function applyOpenAIReasoning(payload, options, parts) {
  const effort = effortOf(options, parts)
  if (effort !== undefined) payload.reasoning_effort = effort
  return payload
}

/**
 * Read a usage report in any of the three dialects and hand it on in one shape.
 *
 * The shapes are genuinely different (not aliased), so this is a normalization.
 * It only relocates the numbers; the disjoint-counter arithmetic that keeps
 * harness totals honest belongs to the adapter, because it is the same rule
 * everywhere.
 *
 * @param {object} frame - one streamed frame.
 * @returns {object|undefined} a chat-shaped usage object, or undefined.
 */
export function usageOf(frame) {
  const usage = frame?.usage ?? frame?.response?.usage ?? frame?.message?.usage
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: usage.prompt_tokens_details,
    completion_tokens_details: usage.completion_tokens_details,
  }
}

/**
 * Flatten a content array or string to plain text.
 *
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

/* -- chat/completions ------------------------------------------------------- */

/**
 * `POST {prefix}/v1/chat/completions`.
 *
 * Content arrives under `choices[0].delta`, a tool call arrives in fragments
 * under `delta.tool_calls`, and usage rides the final frame.
 */
const chatCompletions = {
  name: 'chat-completions',
  path: '/chat/completions',

  /**
   * @param {object} options
   * @param {string} model
   * @param {object} parts - `{ messages, tools, toolChoice }`.
   * @returns {object}
   */
  build(options, model, parts) {
    const payload = commonPayload(options, model)
    payload.messages = parts.messages
    payload.stream_options = { include_usage: true }
    if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
      // Verified on this gateway: both spellings are accepted, and `max_tokens`
      // is the one its OpenAI-style models accept across the board.
      payload.max_tokens = options.maxTokens
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) payload.stop = options.stop
    applyOpenAIReasoning(payload, options, parts)
    if (parts.tools.length > 0) {
      payload.tools = parts.tools
      payload.tool_choice = parts.toolChoice
    }
    return payload
  },

  /** @returns {Record<string, string>} */
  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` }
  },

  /**
   * @param {object} frame
   * @returns {{deltas: object[], finish: string|null}}
   */
  read(frame) {
    const choice = frame?.choices?.[0]
    if (!choice) return { deltas: [], finish: null }
    const delta = choice.delta
    if (!delta || typeof delta !== 'object') return { deltas: [], finish: choice.finish_reason ?? null }

    const deltas = []
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning !== '') {
      deltas.push({ kind: 'reasoning', text: reasoning })
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      deltas.push({ kind: 'text', text: delta.content })
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      deltas.push({
        kind: 'tool-call',
        key: call?.index ?? call?.id ?? 0,
        id: call?.id,
        name: call?.function?.name,
        argumentsDelta: call?.function?.arguments,
      })
    }
    return { deltas, finish: choice.finish_reason ?? null }
  },
}

/* -- responses -------------------------------------------------------------- */

/**
 * `POST {prefix}/v1/responses`.
 *
 * The conversation lives under `input`; output arrives as typed events rather
 * than a merged content field; a tool call is announced as a whole
 * `response.output_item.added` item; usage lands on `response.completed`.
 */
const responses = {
  name: 'responses',
  path: '/responses',

  build(options, model, parts) {
    const payload = commonPayload(options, model)
    // `input` is a list of typed items, not chat messages. The mapping is
    // one-way on purpose: a tool result is an item of its own, and folding it
    // back into a `role: tool` message would lose the call id.
    payload.input = toInputItems(parts.messages)
    if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
      payload.max_output_tokens = options.maxTokens
    }
    // The Responses dialect takes reasoning under a nested `reasoning` object
    // rather than the flat `reasoning_effort` field.
    const effort = effortOf(options, parts)
    if (effort !== undefined) payload.reasoning = { effort }
    if (parts.tools.length > 0) {
      payload.tools = toResponsesTools(parts.tools)
      payload.tool_choice = parts.toolChoice
    }
    return payload
  },

  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` }
  },

  read(frame) {
    const deltas = []
    const type = frame?.type

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (typeof frame?.delta === 'string' && frame.delta !== '') {
        deltas.push({ kind: 'text', text: frame.delta })
      }
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (typeof frame?.delta === 'string' && frame.delta !== '') {
        deltas.push({ kind: 'reasoning', text: frame.delta })
      }
    } else if (type === 'response.output_item.added') {
      const item = frame?.item
      if (item?.type === 'function_call') {
        deltas.push({
          kind: 'tool-call',
          key: item?.id ?? frame?.output_index ?? 0,
          id: item?.call_id ?? item?.id,
          name: item?.name,
          argumentsDelta: typeof item?.arguments === 'string' && item.arguments !== '' ? item.arguments : undefined,
        })
      }
    } else if (type === 'response.function_call_arguments.delta') {
      deltas.push({
        kind: 'tool-call',
        key: frame?.item_id ?? frame?.output_index ?? 0,
        argumentsDelta: typeof frame?.delta === 'string' ? frame.delta : undefined,
      })
    }

    const done = type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed'
    return { deltas, finish: done ? (frame?.response?.status ?? type) : null }
  },
}

/* -- anthropic-messages ----------------------------------------------------- */

/**
 * `POST {prefix}/v1/messages`.
 *
 * The third dialect is not a rebranding of either OpenAI shape: the system
 * prompt is a top-level `system` field, content is a block list, a tool call is
 * a `tool_use` block in the assistant message, a tool result is a `tool_result`
 * block inside a *user* message, and the stream is a named-event vocabulary
 * (`content_block_delta` / `message_delta` / `message_stop`).
 *
 * Measured on this gateway: it authenticates with `x-api-key` — a Bearer token
 * answers 401 — and it is the only dialect `claude-haiku-5-5` and `minimax-m2.7`
 * accept.
 */
const anthropicMessages = {
  name: 'anthropic-messages',
  path: '/messages',

  build(options, model, parts) {
    const payload = { model, stream: true, max_tokens: options.maxTokens ?? 4096 }
    if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
      payload.temperature = options.temperature
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) payload.stop_sequences = options.stop

    // Thinking here is **adaptive**, not a fixed budget. Measured on 2026-10-21:
    // this gateway rejects `thinking.type: "enabled"` with
    //   `"thinking.type.enabled" is not supported for this model. Use
    //    "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`
    // so the accepted shape is `{ type: 'adaptive' }` plus a separate effort, which
    // is exactly what it asks for. Omitting both is also accepted and means "no
    // thinking controls", which is how `off` is spelled here.
    const effort = effortOf(options, parts, 'anthropic')
    if (effort !== undefined) {
      payload.thinking = { type: 'adaptive' }
      payload.output_config = { effort }
    }

    const { system, messages } = toAnthropicMessages(parts.messages)
    if (system !== '') payload.system = system
    payload.messages = messages
    if (parts.tools.length > 0) {
      payload.tools = toAnthropicTools(parts.tools)
      // `none` is honoured by omitting the definitions' invitation rather than by
      // advertising an unused tool set the model could still call.
      payload.tool_choice = { type: parts.toolChoice === 'none' ? 'none' : 'auto' }
    }
    return payload
  },

  authHeaders(apiKey) {
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
  },

  read(frame) {
    const deltas = []
    const type = frame?.type

    if (type === 'content_block_delta') {
      const delta = frame?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        deltas.push({ kind: 'text', text: delta.text })
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
        deltas.push({ kind: 'reasoning', text: delta.thinking })
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json !== '') {
        deltas.push({
          kind: 'tool-call',
          key: frame?.index ?? 0,
          argumentsDelta: delta.partial_json,
        })
      }
    } else if (type === 'content_block_start') {
      const block = frame?.content_block
      if (block?.type === 'tool_use') {
        deltas.push({
          kind: 'tool-call',
          key: frame?.index ?? 0,
          id: block?.id,
          name: block?.name,
          argumentsDelta: undefined,
        })
      }
    }

    // `stop_reason` arrives on `message_delta` (not on the terminal
    // `message_stop`, which carries nothing) — reading it only at the end is what
    // made a tool-use turn report `stop` and strand the call. Both are reported so
    // the adapter keeps the first non-null one it sees.
    const isDeltaStop = type === 'message_delta'
      && typeof frame?.delta?.stop_reason === 'string'
      && frame.delta.stop_reason !== ''
    const finish = isDeltaStop
      ? frame.delta.stop_reason
      : (type === 'message_stop' ? (frame?.message?.stop_reason ?? 'end_turn') : null)
    return { deltas, finish }
  },
}

/**
 * Convert chat-shaped messages into `input` items for the responses dialect.
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
export function toInputItems(messages) {
  const items = []
  for (const message of messages ?? []) {
    const role = message?.role
    if (role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message?.tool_call_id ?? message?.name,
        output: textOf(message?.content),
      })
      continue
    }
    if (role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        items.push({
          type: 'function_call',
          call_id: call?.id,
          name: call?.function?.name,
          arguments: call?.function?.arguments ?? '{}',
        })
      }
      const text = textOf(message?.content)
      if (text !== '') items.push({ role: 'assistant', content: text })
      continue
    }
    const text = textOf(message?.content)
    if (text === '') continue
    items.push({ role: role === 'assistant' ? 'assistant' : 'user', content: text })
  }
  return items
}

/**
 * Convert chat-shaped tool definitions into the responses dialect.
 *
 * @param {object[]} tools
 * @returns {object[]}
 */
export function toResponsesTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool?.function?.name ?? tool?.name,
    description: tool?.function?.description ?? tool?.description ?? '',
    parameters: tool?.function?.parameters ?? tool?.parameters ?? { type: 'object', properties: {} },
  }))
}

/**
 * Convert chat-shaped messages into the Anthropic Messages dialect.
 *
 * Two structural differences drive this: the system prompt is hoisted out of the
 * message list into its own field, and a tool result must appear as a
 * `tool_result` **block inside a user message** rather than as a `role: "tool"`
 * message. Consecutive same-role messages are merged because the endpoint
 * rejects two in a row.
 *
 * @param {object[]} messages
 * @returns {{system: string, messages: object[]}}
 */
export function toAnthropicMessages(messages) {
  const systemParts = []
  const out = []

  const push = (role, content) => {
    if (content.length === 0) return
    const last = out[out.length - 1]
    if (last !== undefined && last.role === role) {
      last.content = [...last.content, ...content]
      return
    }
    out.push({ role, content })
  }

  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message?.role

    if (role === 'system') {
      const text = textOf(message?.content)
      if (text !== '') systemParts.push(text)
      continue
    }

    if (role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: message?.tool_call_id,
        content: textOf(message?.content),
      }])
      continue
    }

    if (role === 'assistant') {
      const blocks = []
      // The chat-shaped projection carries the replayed reasoning in
      // `reasoning_content` (that is the field the OpenAI dialects need back);
      // here it becomes a leading text block, which is how the Messages dialect
      // replays a thinking turn.
      const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
      if (reasoning !== '') {
        blocks.push({ type: 'text', text: reasoning })
      }
      const text = textOf(message?.content)
      if (text !== '') blocks.push({ type: 'text', text })
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        let input = {}
        try { input = JSON.parse(call?.function?.arguments ?? '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: call?.id, name: call?.function?.name, input })
      }
      push('assistant', blocks)
      continue
    }

    const text = textOf(message?.content)
    if (text !== '') push('user', [{ type: 'text', text }])
  }

  return { system: systemParts.join('\n\n'), messages: out }
}

/**
 * Convert chat-shaped tool definitions into the Anthropic dialect.
 *
 * @param {object[]} tools
 * @returns {object[]}
 */
export function toAnthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool?.function?.name ?? tool?.name,
    description: tool?.function?.description ?? tool?.description ?? '',
    input_schema: tool?.function?.parameters ?? tool?.parameters ?? { type: 'object', properties: {} },
  }))
}

/** The dialects, by canonical name. */
export const BY_NAME = Object.freeze({
  [chatCompletions.name]: chatCompletions,
  [responses.name]: responses,
  [anthropicMessages.name]: anthropicMessages,
})

/**
 * Resolve a protocol name to its implementation.
 *
 * An unknown name falls back to the default rather than throwing: a deployment
 * with a typo should still get a working route and a visible wrong-protocol
 * failure from the gateway, not a plugin that refuses to mount.
 *
 * @param {unknown} name
 * @returns {object}
 */
export function protocolFor(name) {
  return isProtocol(name) ? BY_NAME[name] : BY_NAME[DEFAULT_PROTOCOL]
}
