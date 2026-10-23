/**
 * Offline self-test: config normalization, session derivation, protocol shapes,
 * listing parsing, and the adapter's block bookkeeping.
 *
 * No network, no credentials, no restart. Run: node scripts/selftest.mjs
 */

import assert from 'node:assert/strict'

import {
  ConfigError,
  DEFAULT_CONFIG,
  canonicalProtocol,
  endpointOf,
  hasVersionSegment,
  modelsEndpoint,
  normalize,
  normalizeBaseURL,
  normalizeModelSettings,
} from '../lib/config.js'
import { SESSION_RE, sessionForConversation, requestIdFor } from '../lib/session.js'
import {
  toAnthropicMessages,
  toAnthropicTools,
  toInputItems,
  toResponsesTools,
  protocolFor,
  usageOf,
  wireEffort,
} from '../lib/protocol.js'
import { readListing } from '../lib/discovery.js'
import { baseModelId, toChatMessages, applyFingerprint, restoreToolName, OpenCodeLiveAdapter, ladderFor } from '../lib/adapter.js'

let passed = 0
const failures = []
const pending = []

function test(label, fn) {
  let result
  try {
    result = fn()
  } catch (error) {
    failures.push({ label, error })
    process.stdout.write(`  FAIL ${label}\n       ${error?.message}\n`)
    return
  }
  // A test that returns a promise has not finished yet. Track it so a rejection
  // lands in `failures` instead of escaping as an unhandled rejection after the
  // summary already printed `ok`.
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    pending.push(result.then(
      () => {
        passed += 1
        process.stdout.write(`  ok  ${label}\n`)
      },
      (error) => {
        failures.push({ label, error })
        process.stdout.write(`  FAIL ${label}\n       ${error?.message}\n`)
      },
    ))
    return
  }
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

async function testAsync(label, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok  ${label}\n`)
  } catch (error) {
    failures.push({ label, error })
    process.stdout.write(`  FAIL ${label}\n       ${error?.message}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`)
}

// ── baseURL normalization ────────────────────────────────────────────────────

section('baseURL 归一化')

test('裸主机加 /v1 保持原样', () => {
  assert.equal(normalizeBaseURL('https://opencode.ai/zen/go/v1'), 'https://opencode.ai/zen/go/v1')
})

test('去尾斜杠', () => {
  assert.equal(normalizeBaseURL('https://opencode.ai/zen/go/v1/'), 'https://opencode.ai/zen/go/v1')
})

test('前导空格被裁掉（YAML 引号值常见陷阱）', () => {
  assert.equal(normalizeBaseURL(' https://opencode.ai/zen/go/v1'), 'https://opencode.ai/zen/go/v1')
  assert.equal(normalizeBaseURL('\n\thttps://x.test/v1  '), 'https://x.test/v1')
})

test('完整 chat 端点被裁剪为前缀', () => {
  assert.equal(
    normalizeBaseURL('https://opencode.ai/inference/go/openai/v1/chat/completions'),
    'https://opencode.ai/inference/go/openai/v1',
  )
})

test('完整 responses 端点被裁剪', () => {
  assert.equal(normalizeBaseURL('https://x.test/v1/responses'), 'https://x.test/v1')
})

test('完整 messages 端点被裁剪', () => {
  assert.equal(normalizeBaseURL('https://x.test/v1/messages'), 'https://x.test/v1')
})

test('重复后缀被反复裁剪', () => {
  assert.equal(
    normalizeBaseURL('https://x.test/v1/chat/completions/chat/completions'),
    'https://x.test/v1',
  )
})

test('query 与 fragment 被丢弃', () => {
  assert.equal(normalizeBaseURL('https://x.test/v1/?a=1#frag'), 'https://x.test/v1')
})

test('非 http(s) 被拒绝', () => {
  assert.throws(() => normalizeBaseURL('ftp://x.test'), ConfigError)
  assert.throws(() => normalizeBaseURL('htps://x.test'), ConfigError)
  assert.throws(() => normalizeBaseURL(''), ConfigError)
  assert.throws(() => normalizeBaseURL('   '), ConfigError)
})

section('端点拼接')

test('modelsEndpoint 正确追加', () => {
  assert.equal(modelsEndpoint('https://x.test/zen/go'), 'https://x.test/zen/go/v1/models')
})

test('modelsEndpoint 不重复 /v1（曾经的 404 缺陷）', () => {
  assert.equal(modelsEndpoint('https://x.test/zen/go/v1'), 'https://x.test/zen/go/v1/models')
  assert.notEqual(modelsEndpoint('https://x.test/zen/go/v1'), 'https://x.test/zen/go/v1/v1/models')
})

test('归一化后的真实配置产出正确列表端点', () => {
  const cfg = normalize({})
  assert.equal(modelsEndpoint(cfg.baseURL), 'https://opencode.ai/zen/go/v1/models')
})

test('从完整端点归一化后列表端点仍正确', () => {
  const prefix = normalizeBaseURL('https://opencode.ai/inference/go/openai/v1/chat/completions')
  assert.equal(modelsEndpoint(prefix), 'https://opencode.ai/inference/go/openai/v1/models')
})

test('endpointOf 不会重复 /v1', () => {
  assert.equal(endpointOf('https://x.test/zen/go/v1', '/chat/completions'), 'https://x.test/zen/go/v1/chat/completions')
  assert.equal(endpointOf('https://x.test/zen/go', '/chat/completions'), 'https://x.test/zen/go/v1/chat/completions')
})

test('hasVersionSegment 识别 /v1 与 /v2', () => {
  assert.equal(hasVersionSegment('https://x.test/v1'), true)
  assert.equal(hasVersionSegment('https://x.test/v2'), true)
  assert.equal(hasVersionSegment('https://x.test/zen/go'), false)
})

test('三方言端点各异', () => {
  const p = 'https://x.test/zen/go/v1'
  assert.equal(endpointOf(p, protocolFor('chat-completions').path), `${p}/chat/completions`)
  assert.equal(endpointOf(p, protocolFor('responses').path), `${p}/responses`)
  assert.equal(endpointOf(p, protocolFor('anthropic-messages').path), `${p}/messages`)
})

// ── config normalization ────────────────────────────────────────────────────

section('配置归一化')

test('空配置得到全部默认值', () => {
  const cfg = normalize({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.route, DEFAULT_CONFIG.route)
  assert.equal(cfg.baseURL, DEFAULT_CONFIG.baseURL)
  assert.deepEqual(cfg.models, [])
})

test('默认路由不是 opencode-go（避免 DUPLICATE_ADAPTER）', () => {
  assert.notEqual(normalize({}).route, 'opencode-go')
})

test('非法 route 被拒绝', () => {
  assert.throws(() => normalize({ route: 'bad route!' }), ConfigError)
})

test('模型 id 必填', () => {
  assert.throws(() => normalize({ models: [{}] }), ConfigError)
})

test('模型 id 重复被拒绝', () => {
  assert.throws(() => normalize({ models: [{ id: 'a' }, { id: 'a' }] }), ConfigError)
})

test('非法协议被拒绝', () => {
  assert.throws(() => normalize({ models: [{ id: 'a', protocol: 'grpc' }] }), ConfigError)
})

test('协议别名被接受', () => {
  assert.equal(normalize({ models: [{ id: 'a', protocol: 'openai-completions' }] }).models[0].protocol, 'chat-completions')
  assert.equal(normalize({ models: [{ id: 'a', protocol: 'messages' }] }).models[0].protocol, 'anthropic-messages')
  assert.equal(normalize({ models: [{ id: 'a', protocol: 'openai-responses' }] }).models[0].protocol, 'responses')
})

test('静态 x-opencode-session 头被丢弃', () => {
  const cfg = normalize({ headers: { 'x-opencode-session': 'pinned', 'x-custom': 'ok' } })
  assert.equal(cfg.headers['x-opencode-session'], undefined)
  assert.equal(cfg.headers['x-custom'], 'ok')
})

test('apiKeyPrefix 允许显式空串', () => {
  assert.equal(normalize({ apiKeyPrefix: '' }).apiKeyPrefix, '')
  assert.equal(normalize({}).apiKeyPrefix, 'Bearer ')
})

test('capacity 字段拒绝非正整数', () => {
  const cfg = normalize({ models: [{ id: 'a', contextWindow: -1, maxTokens: 1.5 }] })
  assert.equal(cfg.models[0].contextWindow, undefined)
  assert.equal(cfg.models[0].maxTokens, undefined)
})

test('enabled: false 仍可归一化', () => {
  assert.equal(normalize({ enabled: false }).enabled, false)
})

test('canonicalProtocol 覆盖全部别名', () => {
  for (const name of ['chat-completions', 'openai-completions', 'chat', 'responses', 'openai-responses', 'anthropic-messages', 'messages']) {
    assert.notEqual(canonicalProtocol(name), null, name)
  }
  assert.equal(canonicalProtocol('nope'), null)
  assert.equal(canonicalProtocol(42), null)
})

// ── session derivation ──────────────────────────────────────────────────────

section('会话 ID 派生')

test('同一会话稳定', () => {
  assert.equal(sessionForConversation('abc'), sessionForConversation('abc'))
})

test('不同会话不同', () => {
  assert.notEqual(sessionForConversation('abc'), sessionForConversation('abd'))
})

test('输出是合法 v5 UUID', () => {
  assert.match(sessionForConversation('abc'), SESSION_RE)
})

test('无会话身份时回落到进程级常量', () => {
  assert.equal(sessionForConversation(undefined), sessionForConversation(null))
  assert.equal(sessionForConversation(''), sessionForConversation(undefined))
})

test('不把原始 id 透传出去', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  assert.notEqual(sessionForConversation(id), id)
})

test('请求 ID 形状正确', () => {
  assert.match(requestIdFor('abc', 'turn-1'), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('同回合的请求 ID 稳定（重试复用）', () => {
  assert.equal(requestIdFor('abc', 'turn-1'), requestIdFor('abc', 'turn-1'))
})

test('不同回合的请求 ID 不同', () => {
  assert.notEqual(requestIdFor('abc', 'turn-1'), requestIdFor('abc', 'turn-2'))
})

// ── protocol shapes ─────────────────────────────────────────────────────────

section('协议请求体')

const chatMessages = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' },
    ],
  },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] },
]

test('chat 协议保留 reasoning_content', () => {
  const messages = toChatMessages(chatMessages)
  const assistant = messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.reasoning_content, 'thinking')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
})

test('chat 协议把工具结果变成 role: tool', () => {
  const messages = toChatMessages(chatMessages)
  const tool = messages.find((m) => m.role === 'tool')
  assert.equal(tool.tool_call_id, 'call_1')
  assert.equal(tool.content, 'ok')
})

test('chat 请求体带 stream 与 max_tokens', () => {
  const body = protocolFor('chat-completions').build({ maxTokens: 64 }, 'm', {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    toolChoice: 'none',
  })
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 64)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('responses 请求体用 input 与 max_output_tokens', () => {
  const body = protocolFor('responses').build({ maxTokens: 64 }, 'm', {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    toolChoice: 'none',
  })
  assert.equal(body.max_output_tokens, 64)
  assert.equal(body.max_tokens, undefined)
  assert.ok(Array.isArray(body.input))
})

test('messages 请求体用 system + max_tokens', () => {
  const body = protocolFor('anthropic-messages').build({ maxTokens: 64 }, 'm', {
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    tools: [],
    toolChoice: 'none',
  })
  assert.equal(body.system, 'sys')
  assert.equal(body.max_tokens, 64)
  assert.equal(body.stream, true)
})

test('messages 协议把 tool_result 放进 user 消息', () => {
  const { system, messages } = toAnthropicMessages(toChatMessages(chatMessages))
  assert.equal(system, 'sys')
  const userBlocks = messages.at(-1).content
  assert.equal(userBlocks[0].type, 'tool_result')
  assert.equal(userBlocks[0].tool_use_id, 'call_1')
  // The tool_use block is what the result answers, so it must be there too.
  const assistant = messages.find((m) => m.role === 'assistant')
  assert.ok(assistant.content.some((block) => block.type === 'tool_use'))
})

test('messages 协议回放思考内容', () => {
  const { messages } = toAnthropicMessages(toChatMessages(chatMessages))
  const assistant = messages.find((m) => m.role === 'assistant')
  assert.ok(assistant.content.some((block) => block.type === 'text' && block.text === 'thinking'))
})

test('messages 协议合并连续同角色消息', () => {
  const { messages } = toAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content.length, 2)
})

test('responses 工具定义是扁平形状', () => {
  const tools = toResponsesTools([{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }])
  assert.equal(tools[0].name, 'read')
  assert.equal(tools[0].function, undefined)
})

test('messages 工具定义用 input_schema', () => {
  const tools = toAnthropicTools([{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }])
  assert.equal(tools[0].name, 'read')
  assert.deepEqual(tools[0].input_schema, { type: 'object' })
})

test('responses 的 tool result 是独立 item', () => {
  const items = toInputItems(toChatMessages(chatMessages))
  const output = items.find((item) => item.type === 'function_call_output')
  assert.equal(output.call_id, 'call_1')
  const call = items.find((item) => item.type === 'function_call')
  assert.equal(call.name, 'read')
})

// ── auth headers ────────────────────────────────────────────────────────────

section('认证头')

test('messages 用 x-api-key（实测 Bearer 会 401）', () => {
  const headers = protocolFor('anthropic-messages').authHeaders('KEY')
  assert.equal(headers['x-api-key'], 'KEY')
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['anthropic-version'], '2023-06-01')
})

test('两种 OpenAI 方言用 Bearer', () => {
  assert.equal(protocolFor('chat-completions').authHeaders('KEY').authorization, 'Bearer KEY')
  assert.equal(protocolFor('responses').authHeaders('KEY').authorization, 'Bearer KEY')
})

// ── frame reading ───────────────────────────────────────────────────────────

section('流帧解析')

test('chat 文本增量', () => {
  const { deltas } = protocolFor('chat-completions').read({ choices: [{ delta: { content: 'hi' } }] })
  assert.equal(deltas[0].kind, 'text')
  assert.equal(deltas[0].text, 'hi')
})

test('chat 推理增量走 reasoning', () => {
  const { deltas } = protocolFor('chat-completions').read({ choices: [{ delta: { reasoning_content: 'think' } }] })
  assert.equal(deltas[0].kind, 'reasoning')
})

test('chat 工具调用分片', () => {
  const { deltas } = protocolFor('chat-completions').read({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"a"' } }] } }],
  })
  assert.equal(deltas[0].kind, 'tool-call')
  assert.equal(deltas[0].key, 0)
  assert.equal(deltas[0].argumentsDelta, '{"a"')
})

test('chat finish_reason 被抓取', () => {
  assert.equal(protocolFor('chat-completions').read({ choices: [{ delta: {}, finish_reason: 'stop' }] }).finish, 'stop')
})

test('responses 文本事件', () => {
  const { deltas } = protocolFor('responses').read({ type: 'response.output_text.delta', delta: 'hi' })
  assert.equal(deltas[0].kind, 'text')
})

test('responses function_call item', () => {
  const { deltas } = protocolFor('responses').read({
    type: 'response.output_item.added',
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' },
  })
  assert.equal(deltas[0].kind, 'tool-call')
  assert.equal(deltas[0].name, 'read')
})

test('responses completed 结束', () => {
  const { finish } = protocolFor('responses').read({ type: 'response.completed', response: { status: 'completed' } })
  assert.equal(finish, 'completed')
})

test('messages text_delta', () => {
  const { deltas } = protocolFor('anthropic-messages').read({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hi' },
  })
  assert.equal(deltas[0].kind, 'text')
})

test('messages tool_use 起始', () => {
  const { deltas } = protocolFor('anthropic-messages').read({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' },
  })
  assert.equal(deltas[0].kind, 'tool-call')
  assert.equal(deltas[0].name, 'read')
})

test('messages input_json_delta 累积参数', () => {
  const { deltas } = protocolFor('anthropic-messages').read({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
  })
  assert.equal(deltas[0].argumentsDelta, '{"a":1}')
})

test('messages message_stop 结束', () => {
  assert.notEqual(protocolFor('anthropic-messages').read({ type: 'message_stop' }).finish, null)
})

test('usageOf 兼容三种形状', () => {
  assert.equal(usageOf({ usage: { prompt_tokens: 5 } }).prompt_tokens, 5)
  assert.equal(usageOf({ response: { usage: { input_tokens: 7 } } }).prompt_tokens, 7)
  assert.equal(usageOf({ message: { usage: { input_tokens: 3 } } }).prompt_tokens, 3)
  assert.equal(usageOf({}), undefined)
})

// ── listing parser ──────────────────────────────────────────────────────────

section('模型列表解析')

test('data 数组形状', () => {
  const models = readListing({ data: [{ id: 'a' }, { id: 'b', name: 'B' }] })
  assert.deepEqual(models.map((m) => m.id), ['a', 'b'])
  assert.equal(models[1].name, 'B')
})

test('models 对象形状，键为 id', () => {
  const models = readListing({ models: { a: { name: 'A' }, b: {} } })
  assert.deepEqual(models.map((m) => m.id), ['a', 'b'])
})

test('models 对象的原始值被忽略', () => {
  const models = readListing({ models: { a: { name: 'A' }, meta: 'not-a-model' } })
  assert.deepEqual(models.map((m) => m.id), ['a'])
})

test('缺失 id 的行被跳过而非整体失败', () => {
  const models = readListing({ data: [{ name: 'no id' }, { id: 'ok' }] })
  assert.deepEqual(models.map((m) => m.id), ['ok'])
})

test('容量字段被采纳', () => {
  const models = readListing({ data: [{ id: 'a', context_window: 200000, max_output_tokens: 64000 }] })
  assert.equal(models[0].contextWindow, 200000)
  assert.equal(models[0].maxTokens, 64000)
})

test('非法形状抛出可读错误', () => {
  assert.throws(() => readListing({ nope: true }), /data 数组也不是 models 对象/)
})

test('重复 id 被去重', () => {
  const models = readListing({ data: [{ id: 'a' }, { id: 'a' }] })
  assert.equal(models.length, 1)
})

// ── per-model protocol choices ──────────────────────────────────────────────

section('每个模型的协议选择')

test('未选择时不给模型加 protocol', () => {
  const cfg = normalize({ models: [{ id: 'm1' }] })
  assert.equal(cfg.models[0].protocol, undefined)
})

test('modelProtocols 按模型记录选择', () => {
  const cfg = normalize({ modelProtocols: { 'grok-4.7': 'responses' } })
  assert.equal(cfg.modelProtocols['grok-4.7'], 'responses')
})

test('modelProtocols 接受协议别名', () => {
  const cfg = normalize({ modelProtocols: { a: 'openai-completions', b: 'messages' } })
  assert.equal(cfg.modelProtocols.a, 'chat-completions')
  assert.equal(cfg.modelProtocols.b, 'anthropic-messages')
})

test('modelProtocols 丢弃不认识的协议', () => {
  const cfg = normalize({ modelProtocols: { a: 'grpc', b: 'responses' } })
  assert.equal(cfg.modelProtocols.a, undefined)
  assert.equal(cfg.modelProtocols.b, 'responses')
})

test('modelProtocols 拒绝非对象', () => {
  assert.deepEqual(normalize({ modelProtocols: ['x'] }).modelProtocols, {})
  assert.deepEqual(normalize({ modelProtocols: 'nope' }).modelProtocols, {})
})

test('models 上显式声明的 protocol 仍然被采纳', () => {
  const cfg = normalize({ models: [{ id: 'm1', protocol: 'responses' }] })
  assert.equal(cfg.models[0].protocol, 'responses')
})

// ── adapter helpers ─────────────────────────────────────────────────────────

section('适配器辅助')

test('baseModelId 剥离思考后缀', () => {
  assert.equal(baseModelId('minimax-m3.1-flash-free(max)'), 'minimax-m3.1-flash-free')
  assert.equal(baseModelId('plain'), 'plain')
})

// ── thinking effort ─────────────────────────────────────────────────────────

section('思考强度：线值映射')

test('off 映射为「不发参数」', () => {
  // Omitting the field is the only spelling every model in the table accepts;
  // MiniMax documents that `effort: "none"` returns 400.
  assert.equal(wireEffort('off'), undefined)
  assert.equal(wireEffort('off', 'anthropic'), undefined)
})

test('none 是 OpenAI 的真实档位，不能被折叠成省略', () => {
  // `none` differs from `off`: OpenAI exposes it as "thinking off" and expects the
  // literal string, so collapsing it would silently keep thinking on.
  assert.equal(wireEffort('none'), 'none')
})

test('各档位原样透传', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(wireEffort(effort), effort)
  }
})

test('空值与未知类型返回 undefined', () => {
  assert.equal(wireEffort(''), undefined)
  assert.equal(wireEffort(undefined), undefined)
  assert.equal(wireEffort(null), undefined)
  assert.equal(wireEffort(42), undefined)
})

// ── per-model ladders ──────────────────────────────────────────────────────

section('思考强度：每模型档位表')

test('MiniMax 五档且不支持关闭', () => {
  const ladder = ladderFor('minimax-m3.1-flash-free')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(ladder.defaultEffort, 'max')
  assert.equal(ladder.efforts.some((e) => e.id === 'off'), false, 'MiniMax 不允许关闭思考')
})

test('Kimi K3 只有 low/high/max', () => {
  const ladder = ladderFor('kimi-k3')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['low', 'high', 'max'])
  assert.equal(ladder.defaultEffort, 'max')
})

test('Kimi K2.7-code 恒开思考，不暴露档位', () => {
  // This model always reasons and offers no effort control at all, so the family is
  // declared as a single fixed level — and a one-option picker is not a choice. It
  // gets no `reasoning` field, and the harness then hides the effort control.
  assert.equal(ladderFor('kimi-k2.7-code'), undefined)
})

test('GLM-5.3 强制思考，无 off 档', () => {
  const ladder = ladderFor('glm-5.3')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['low', 'high', 'max'])
  assert.equal(ladder.efforts.some((e) => e.id === 'off'), false)
})

test('GLM-5.1 是混合模式，有 off 档', () => {
  assert.ok(ladderFor('glm-5.1').efforts.some((e) => e.id === 'off'))
})

test('DeepSeek 收敛到三档（文档里七值会塌缩）', () => {
  const ladder = ladderFor('deepseek-v4-pro')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
  assert.equal(ladder.defaultEffort, 'high')
})

test('Grok 四档，默认 high', () => {
  const ladder = ladderFor('grok-4.7')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(ladder.defaultEffort, 'high')
})

test('GPT 有完整的 OpenAI 档位且含 none', () => {
  const ladder = ladderFor('gpt-5.6-luna')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(ladder.defaultEffort, 'medium')
})

test('Claude 五档，默认 high', () => {
  const ladder = ladderFor('claude-haiku-5-5')
  assert.deepEqual(ladder.efforts.map((e) => e.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(ladder.defaultEffort, 'high')
})

test('Qwen 是开关而不是档位阶梯', () => {
  assert.deepEqual(ladderFor('qwen3.8-max').efforts.map((e) => e.id), ['off', 'medium'])
})

test('未知厂商不给档位（不猜）', () => {
  // Inventing a control the model may reject is worse than showing none.
  assert.equal(ladderFor('muse-spark-1.3-contributor'), undefined)
  assert.equal(ladderFor('omen-alpha'), undefined)
  assert.equal(ladderFor('longcat-2.0'), undefined)
  assert.equal(ladderFor(''), undefined)
})

test('每个档位都有 id 与 name（harness 严格校验）', () => {
  for (const model of ['minimax-m3.1-flash-free', 'kimi-k3', 'glm-5.3', 'grok-4.7', 'gpt-5.6-luna', 'claude-haiku-5-5']) {
    const ladder = ladderFor(model)
    for (const effort of ladder.efforts) {
      assert.ok(typeof effort.id === 'string' && effort.id !== '', `${model}: 缺 id`)
      assert.ok(typeof effort.name === 'string' && effort.name !== '', `${model}/${effort.id}: 缺 name`)
    }
    const ids = ladder.efforts.map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length, `${model}: 档位 id 有重复`)
    if (ladder.defaultEffort !== null) {
      assert.ok(ids.includes(ladder.defaultEffort), `${model}: defaultEffort 不在列表里`)
    }
  }
})

test('特定家族优先于宽泛家族', () => {
  // `kimi-k3` must beat `kimi-`, and `glm-5.3` must beat `glm-`.
  assert.deepEqual(ladderFor('kimi-k3').efforts.map((e) => e.id), ['low', 'high', 'max'])
  assert.deepEqual(ladderFor('kimi-k2.6').efforts.map((e) => e.id), ['off', 'medium'])
  assert.deepEqual(ladderFor('glm-5.3-flash').efforts.map((e) => e.id), ['low', 'high', 'max'])
})

test('chat 方言用 reasoning_effort', () => {
  const payload = protocolFor('chat-completions').build(
    { maxTokens: 1024, reasoningEffort: 'high' }, 'm',
    { messages: [], tools: [], toolChoice: 'none' },
  )
  assert.equal(payload.reasoning_effort, 'high')
})

test('chat 方言在 off 时不带 reasoning_effort', () => {
  const payload = protocolFor('chat-completions').build(
    { maxTokens: 1024, reasoningEffort: 'off' }, 'm',
    { messages: [], tools: [], toolChoice: 'none' },
  )
  assert.equal(payload.reasoning_effort, undefined)
})

test('responses 方言用嵌套 reasoning.effort', () => {
  const payload = protocolFor('responses').build(
    { maxTokens: 1024, reasoningEffort: 'low' }, 'm',
    { messages: [], tools: [], toolChoice: 'none' },
  )
  assert.deepEqual(payload.reasoning, { effort: 'low' })
})

test('messages 方言用 adaptive + output_config.effort', () => {
  // `thinking.type: "enabled"` is rejected by this gateway:
  //   "Use thinking.type.adaptive and output_config.effort to control thinking behavior."
  const payload = protocolFor('anthropic-messages').build(
    { maxTokens: 1024, reasoningEffort: 'high' }, 'm',
    { messages: [], tools: [], toolChoice: 'none' },
  )
  assert.deepEqual(payload.thinking, { type: 'adaptive' })
  assert.deepEqual(payload.output_config, { effort: 'high' })
  assert.equal(payload.thinking.budget_tokens, undefined, '不应发送被拒绝的 budget_tokens')
})

test('messages 方言在 off 时不带 thinking', () => {
  const payload = protocolFor('anthropic-messages').build(
    { maxTokens: 1024, reasoningEffort: 'off' }, 'm',
    { messages: [], tools: [], toolChoice: 'none' },
  )
  assert.equal(payload.thinking, undefined)
  assert.equal(payload.output_config, undefined)
})

test('resolveModel 暴露 reasoning 元数据', async () => {
  // A real family id: the ladder comes from the vendor's published effort levels,
  // matched by model-name family. `m` matches no family and would expose nothing.
  const cfg = normalize({ baseURL: 'https://example.test/v1', apiKey: 'k', models: [{ id: 'minimax-m3', name: 'M' }] })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const info = await adapter.resolveModel('opencode-live', 'minimax-m3')
  assert.ok(Array.isArray(info.reasoning?.efforts) && info.reasoning.efforts.length > 0, '缺少 efforts')
  const ids = info.reasoning.efforts.map((e) => e.id)
  for (const id of ['low', 'medium', 'high', 'max']) assert.ok(ids.includes(id), `缺少档位 ${id}`)
  assert.ok(ids.includes(info.reasoning.defaultEffort), 'defaultEffort 不在列表里')
  // The harness validates these fields strictly, and it renders `name` verbatim — so
  // they are capitalised English, matching what the built-in adapter reports.
  assert.ok(info.reasoning.efforts.every((e) => typeof e.id === 'string' && e.id !== '' && typeof e.name === 'string' && e.name !== ''))
  assert.equal(info.reasoning.efforts.find((e) => e.id === 'high').name, 'High')
})

test('resolveModel 对未知家族不暴露档位', async () => {
  // Not knowing what a model accepts is different from knowing it accepts nothing:
  // advertising a guessed ladder produced 400s from several vendors, so an unknown
  // family gets no `reasoning` field at all and the picker shows no effort control.
  const cfg = normalize({ baseURL: 'https://example.test/v1', apiKey: 'k', models: [{ id: 'm', name: 'M' }] })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const info = await adapter.resolveModel('opencode-live', 'm')
  assert.equal(info.reasoning, undefined, '未知家族不应有 reasoning')
})

test('resolveModel 按用户选择报告图片能力', async () => {
  const cfg = normalize({
    baseURL: 'https://example.test/v1',
    apiKey: 'k',
    models: [{ id: 'minimax-m3', name: 'M' }, { id: 'minimax-m3.1-flash-free', name: 'F' }],
    modelVision: { 'minimax-m3': false, 'minimax-m3.1-flash-free': true },
  })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const off = await adapter.resolveModel('opencode-live', 'minimax-m3')
  const on = await adapter.resolveModel('opencode-live', 'minimax-m3.1-flash-free')
  assert.deepEqual(off.inputModalities, ['text'], '用户关掉后应为纯文本')
  assert.deepEqual(on.inputModalities, ['text', 'image'], '用户打开后应接受图片')
})

test('用户声明的容量覆盖默认值', async () => {
  const cfg = normalize({
    baseURL: 'https://example.test/v1',
    apiKey: 'k',
    models: [{ id: 'minimax-m3', name: 'M' }],
    modelSettings: { 'minimax-m3': { contextWindow: 32000, maxTokens: 2048 } },
  })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const info = await adapter.resolveModel('opencode-live', 'minimax-m3')
  assert.equal(info.context.contextWindow, 32000)
  assert.equal(info.defaultMaxTokens, 2048)
})

test('最大输出不会超过上下文窗口', async () => {
  // A user can set them independently and legitimately create this contradiction.
  // Minimising is the only answer that cannot produce a request the model rejects.
  const cfg = normalize({
    baseURL: 'https://example.test/v1',
    apiKey: 'k',
    models: [{ id: 'minimax-m3', name: 'M' }],
    modelSettings: { 'minimax-m3': { contextWindow: 4000, maxTokens: 128000 } },
  })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const info = await adapter.resolveModel('opencode-live', 'minimax-m3')
  assert.equal(info.defaultMaxTokens, 4000)
})

test('用户声明的档位表取代厂商文档表', async () => {
  const cfg = normalize({
    baseURL: 'https://example.test/v1',
    apiKey: 'k',
    models: [{ id: 'minimax-m3', name: 'M' }],
    modelSettings: { 'minimax-m3': { reasoningEfforts: { quick: 'low', deep: 'max' } } },
  })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const info = await adapter.resolveModel('opencode-live', 'minimax-m3')
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ['quick', 'deep'])
  assert.equal(info.reasoning.defaultEffort, 'quick')
})

test('用户声明的零档位不暴露思考控件', async () => {
  const cfg = normalize({
    baseURL: 'https://example.test/v1',
    apiKey: 'k',
    models: [{ id: 'minimax-m3', name: 'M' }],
    modelSettings: { 'minimax-m3': { reasoningEfforts: {} } },
  })
  const adapter = new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    apiKey: 'k',
    log: () => {},
  })
  const info = await adapter.resolveModel('opencode-live', 'minimax-m3')
  assert.equal(info.reasoning, undefined, '零档位应让控件消失，而不是回落到文档表')
})

test('modelSettings 只保留它能兑现的字段', () => {
  const settings = normalizeModelSettings({
    'model-a': {
      contextWindow: 32000,
      maxTokens: -1,
      inputModalities: ['text', 'audio'],
      reasoningEfforts: { low: 'low', junk: '' },
      unrelated: 'ignored',
    },
    'model-b': { maxTokens: 'big' },
    '': { contextWindow: 1 },
  })
  assert.deepEqual(settings, { 'model-a': { contextWindow: 32000, inputModalities: ['text'], reasoningEfforts: { low: 'low' } } })
})

test('modelSettings 的零档位是真实指令，全非法则整条丢弃', () => {
  assert.deepEqual(normalizeModelSettings({ a: { reasoningEfforts: {} } }), { a: { reasoningEfforts: {} } })
  // Entries existed but none survived: honouring it would silently disable a
  // control the user did not ask to disable.
  assert.deepEqual(normalizeModelSettings({ a: { reasoningEfforts: { x: '', y: 7 } } }), {})
})

test('modelSettings 保留 null 档位值（表示该档不发参数）', () => {
  assert.deepEqual(normalizeModelSettings({ a: { reasoningEfforts: { off: null } } }), { a: { reasoningEfforts: { off: null } } })
})

test('normalize 把 modelSettings 纳入默认值', () => {
  const cfg = normalize({ baseURL: 'https://example.test/v1' })
  assert.deepEqual(cfg.modelSettings, {})
  const set = normalize({ baseURL: 'https://example.test/v1', modelSettings: { a: { contextWindow: 10 } } })
  assert.deepEqual(set.modelSettings, { a: { contextWindow: 10 } })
})

// ── tool call pairing ───────────────────────────────────────────────────────

section('工具调用配对')

/**
 * The harness models a tool result as its own `role: "tool"` message with a
 * top-level `toolCallId`; there is no `tool-result` block type. A projection that
 * looks for one silently drops every result, and the gateway then rejects the whole
 * request with `400 … tool call and result not match (2013)` — the "works for a few
 * replies, then fails" bug.
 */
const TOOL_HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call_abc', name: 'read', arguments: '{"file_path":"a.txt"}' },
    ],
  },
  {
    role: 'tool',
    toolCallId: 'call_abc',
    source: { kind: 'tool', callId: 'call_abc' },
    content: [{ type: 'text', text: 'file body' }],
    isError: false,
  },
]

test('role:tool 消息被投影为 chat 的 tool 消息', () => {
  const chat = toChatMessages(TOOL_HISTORY)
  const tool = chat.find((m) => m.role === 'tool')
  assert.ok(tool !== undefined, '没有生成 tool 消息')
  assert.equal(tool.tool_call_id, 'call_abc')
  assert.equal(tool.content, 'file body')
})

test('chat 方言 call 与 result 配对', () => {
  const chat = toChatMessages(TOOL_HISTORY)
  const calls = chat.flatMap((m) => m.tool_calls ?? []).map((c) => c.id)
  const results = chat.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  assert.deepEqual(calls, results)
  assert.deepEqual(calls, ['call_abc'])
})

test('tool 消息紧跟声明它的 assistant', () => {
  const chat = toChatMessages(TOOL_HISTORY)
  const at = chat.findIndex((m) => m.role === 'tool')
  assert.equal(chat[at - 1]?.role, 'assistant')
  assert.ok((chat[at - 1].tool_calls?.length ?? 0) > 0)
})

test('messages 方言把结果放进 user 消息', () => {
  const { messages } = toAnthropicMessages(toChatMessages(TOOL_HISTORY))
  const turn = messages.find((m) => m.content.some((b) => b.type === 'tool_result'))
  assert.ok(turn !== undefined, '没有 tool_result')
  assert.equal(turn.role, 'user', 'tool_result 必须在 user 消息里')
  const use = messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => b.id)
  const result = messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
  assert.deepEqual(use, result)
})

test('responses 方言 call 与 output 配对', () => {
  const items = toInputItems(toChatMessages(TOOL_HISTORY))
  const calls = items.filter((i) => i.type === 'function_call').map((i) => i.call_id)
  const outputs = items.filter((i) => i.type === 'function_call_output').map((i) => i.call_id)
  assert.deepEqual(calls, outputs)
})

test('多个连续工具调用都被应答', () => {
  const multi = [
    { role: 'user', content: [{ type: 'text', text: 'read two' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] },
    { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'b' }] },
  ]
  const chat = toChatMessages(multi)
  const calls = chat.flatMap((m) => m.tool_calls ?? []).map((c) => c.id)
  const results = chat.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  assert.deepEqual(calls, ['c1', 'c2'])
  assert.deepEqual(results, ['c1', 'c2'])
})

test('空的工具输出不被丢弃', () => {
  // An empty result still has to be answered, or the call looks unanswered.
  const chat = toChatMessages([
    { role: 'tool', toolCallId: 'c9', content: [] },
  ])
  assert.equal(chat[0].role, 'tool')
  assert.equal(chat[0].tool_call_id, 'c9')
  assert.equal(chat[0].content, '(no output)')
})

test('指纹补齐四件套', () => {
  const { tools } = applyFingerprint([])
  const names = tools.map((t) => t.function.name)
  for (const name of ['bash', 'glob', 'grep', 'read']) assert.ok(names.includes(name), name)
})

test('指纹把 pwsh 提升进 bash 槽', () => {
  const { tools, rename } = applyFingerprint([
    { type: 'function', function: { name: 'pwsh', description: 'shell', parameters: {} } },
  ])
  assert.ok(tools.some((t) => t.function.name === 'bash'))
  assert.equal(rename.get('bash'), 'pwsh')
  assert.equal(restoreToolName('bash', rename), 'pwsh')
})

test('指纹不复制已有槽位', () => {
  const { tools } = applyFingerprint([
    { type: 'function', function: { name: 'bash', description: 'x', parameters: {} } },
  ])
  assert.equal(tools.filter((t) => t.function.name === 'bash').length, 1)
})

test('恢复工具名对未知名字原样返回', () => {
  assert.equal(restoreToolName('other', new Map([['bash', 'pwsh']])), 'other')
})

// ── run ─────────────────────────────────────────────────────────────────────

await Promise.all(pending)
section('结果')
const total = passed + failures.length
process.stdout.write(`\n${passed}/${total} 通过`)
if (failures.length > 0) {
  process.stdout.write(`，${failures.length} 失败\n`)
  for (const { label, error } of failures) process.stdout.write(`  - ${label}: ${error?.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n')
}
