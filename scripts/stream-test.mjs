/**
 * Stream test: drive the adapter against a fake gateway that speaks each of the
 * three dialects, and assert the harness chunk sequence.
 *
 * This is the test that matters most for an agent: a tool call has to arrive as
 * `block-start` → `tool-call-delta`… → `block-end` with the arguments reassembled,
 * because the loop will not execute a call it cannot name and parse.
 *
 * No network. Run: node scripts/stream-test.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'

import { OpenCodeLiveAdapter } from '../lib/adapter.js'
import { normalize } from '../lib/config.js'

let passed = 0
const failures = []

async function test(label, fn) {
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

/** An SSE body from a list of payloads. */
function sse(frames) {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/**
 * Start a gateway that answers each path with a canned body, and record what it
 * received.
 *
 * @param {Record<string, {status?: number, frames?: object[], body?: string}>} routes
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>}
 */
async function startGateway(routes) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: req.url, method: req.method, headers: req.headers, body })
      const route = routes[req.url]
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"no route"}')
        return
      }
      res.writeHead(route.status ?? 200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.end(route.body ?? sse(route.frames ?? []))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Collect every chunk from one turn. */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function makeAdapter(baseURL, { roster, modelProtocols = {}, apiKey = 'test-key' } = {}) {
  const cfg = normalize({ baseURL, apiKey, models: roster, modelProtocols })
  return new OpenCodeLiveAdapter({
    config: cfg,
    liveConfig: () => cfg,
    roster: () => cfg.models,
    attributionUserAgent: 'dsh-opencode-live/0.3.0 (opencode/1.18.31)',
    apiKey,
    log: () => {},
  })
}

// ── chat/completions ────────────────────────────────────────────────────────

section('chat-completions 方言')

await test('文本 + 推理 + 工具调用被正确组装', async () => {
  const gateway = await startGateway({
    '/v1/chat/completions': {
      frames: [
        { choices: [{ delta: { reasoning_content: 'let me think' } }] },
        { choices: [{ delta: { content: 'Sure' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ],
    },
  })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    const chunks = await collect(adapter, {
      provider: 'opencode-live',
      model: 'm1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
      sessionId: 'sess-1',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
      maxTokens: 100,
    })

    const starts = chunks.filter((c) => c.type === 'block-start')
    const ends = chunks.filter((c) => c.type === 'block-end')
    assert.equal(starts.length, 3, `应当有 reasoning/text/tool 三个块，实际 ${starts.length}`)
    assert.equal(ends.length, 3)

    const reasoning = ends.find((c) => c.block.type === 'reasoning')
    assert.equal(reasoning.block.text, 'let me think')

    const text = ends.find((c) => c.block.type === 'text')
    assert.equal(text.block.text, 'Sure')

    const tool = ends.find((c) => c.block.type === 'tool-call')
    assert.equal(tool.block.name, 'read')
    assert.equal(tool.block.id, 'call_1')
    assert.equal(tool.block.arguments, '{"file_path":"a.txt"}')

    const finish = chunks.find((c) => c.type === 'finish')
    assert.equal(finish.reason.kind, 'tool-calls')

    const usage = chunks.find((c) => c.type === 'usage')
    assert.equal(usage.usage.inputTokens, 10)
    assert.equal(usage.usage.outputTokens, 5)
  } finally {
    await gateway.close()
  }
})

await test('请求带 x-opencode-session 与正确端点', async () => {
  const gateway = await startGateway({ '/v1/chat/completions': { frames: [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] } })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [], sessionId: 'sess-abc' })
    const request = gateway.requests[0]
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer test-key')
    assert.match(request.headers['x-opencode-session'], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.match(request.headers['x-opencode-request'], /^msg_/)
  } finally {
    await gateway.close()
  }
})

await test('同一对话两次请求的 session 一致，不同对话不同', async () => {
  const gateway = await startGateway({ '/v1/chat/completions': { frames: [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] } })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [], sessionId: 'sess-A' })
    await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [], sessionId: 'sess-A' })
    await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [], sessionId: 'sess-B' })
    const [first, second, third] = gateway.requests.map((r) => r.headers['x-opencode-session'])
    assert.equal(first, second)
    assert.notEqual(first, third)
  } finally {
    await gateway.close()
  }
})

// ── responses ───────────────────────────────────────────────────────────────

section('responses 方言')

await test('typed 事件被正确组装', async () => {
  const gateway = await startGateway({
    '/v1/responses': {
      frames: [
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'grep' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"pattern":"x"}' },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } } },
      ],
    },
  })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'grok-4.7', name: 'Grok' }], modelProtocols: { 'grok-4.7': 'responses' } })
    const chunks = await collect(adapter, {
      provider: 'opencode-live',
      model: 'grok-4.7',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'sess-r',
      tools: [{ name: 'grep', description: 'Search', parameters: { type: 'object', properties: {} } }],
    })
    assert.equal(gateway.requests[0].url, '/v1/responses')
    const tool = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.equal(tool.block.name, 'grep')
    assert.equal(tool.block.arguments, '{"pattern":"x"}')
    const text = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    assert.equal(text.block.text, 'Hello')
  } finally {
    await gateway.close()
  }
})

await test('responses 请求体用 max_output_tokens', async () => {
  const gateway = await startGateway({ '/v1/responses': { frames: [{ type: 'response.completed', response: { status: 'completed' } }] } })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'g', name: 'G' }], modelProtocols: { g: 'responses' } })
    await collect(adapter, { provider: 'opencode-live', model: 'g', messages: [], maxTokens: 77 })
    const body = JSON.parse(gateway.requests[0].body)
    assert.equal(body.max_output_tokens, 77)
    assert.equal(body.max_tokens, undefined)
  } finally {
    await gateway.close()
  }
})

// ── anthropic-messages ──────────────────────────────────────────────────────

section('anthropic-messages 方言')

await test('messages 事件被正确组装，且用 x-api-key', async () => {
  const gateway = await startGateway({
    '/v1/messages': {
      frames: [
        { type: 'message_start', message: { usage: { input_tokens: 4 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi there' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
        { type: 'message_stop' },
      ],
    },
  })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'claude-haiku-5-5', name: 'Haiku' }], modelProtocols: { 'claude-haiku-5-5': 'anthropic-messages' } })
    const chunks = await collect(adapter, {
      provider: 'opencode-live',
      model: 'claude-haiku-5-5',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be terse' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'sess-m',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
    })

    const request = gateway.requests[0]
    assert.equal(request.url, '/v1/messages')
    assert.equal(request.headers['x-api-key'], 'test-key')
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers['anthropic-version'], '2023-06-01')

    const body = JSON.parse(request.body)
    assert.equal(body.system, 'be terse')
    assert.ok(Array.isArray(body.tools))

    const text = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    assert.equal(text.block.text, 'Hi there')
    const tool = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.equal(tool.block.name, 'read')
    assert.equal(tool.block.arguments, '{"path":"b"}')
    assert.equal(chunks.find((c) => c.type === 'finish').reason.kind, 'tool-calls')
  } finally {
    await gateway.close()
  }
})

// ── error paths ─────────────────────────────────────────────────────────────

section('错误路径')

await test('HTTP 400 得到分类失败与可读信息', async () => {
  const gateway = await startGateway({
    '/v1/chat/completions': {
      status: 400,
      body: '{"error":{"message":"Model does not support this protocol."}}',
    },
  })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    const chunks = await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [] })
    const finish = chunks.find((c) => c.type === 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'BAD_REQUEST')
    assert.match(finish.reason.failure.message, /does not support this protocol/)
    // The message must name the protocol that was tried, so the reader can act.
    assert.match(finish.reason.failure.message, /chat-completions/)
  } finally {
    await gateway.close()
  }
})

await test('401 映射为 AUTH', async () => {
  const gateway = await startGateway({ '/v1/chat/completions': { status: 401, body: '{"error":{"message":"bad key"}}' } })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    const chunks = await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [] })
    assert.equal(chunks.find((c) => c.type === 'finish').reason.failure.code, 'AUTH')
  } finally {
    await gateway.close()
  }
})

await test('429 映射为可重试的 RATE_LIMIT', async () => {
  const gateway = await startGateway({ '/v1/chat/completions': { status: 429, body: '{"error":{"message":"slow down"}}' } })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    const chunks = await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [] })
    const failure = chunks.find((c) => c.type === 'finish').reason.failure
    assert.equal(failure.code, 'RATE_LIMIT')
    assert.ok(adapter.providerRetryPolicy().retryableCodes.includes('RATE_LIMIT'))
  } finally {
    await gateway.close()
  }
})

await test('未选择协议的模型回落到 chat-completions 端点', async () => {
  const gateway = await startGateway({
    '/v1/chat/completions': { frames: [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] },
  })
  try {
    const adapter = makeAdapter(gateway.url, {
      roster: [{ id: 'nobody-classified-this', name: 'X' }],
    })
    const chunks = await collect(adapter, { provider: 'opencode-live', model: 'nobody-classified-this', messages: [] })
    assert.equal(gateway.requests[0].url, '/v1/chat/completions')
    assert.equal(chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
  } finally {
    await gateway.close()
  }
})

await test('用户选择的协议覆盖默认值', async () => {
  const gateway = await startGateway({
    '/v1/messages': { frames: [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }] },
  })
  try {
    const adapter = makeAdapter(gateway.url, {
      roster: [{ id: 'only-messages', name: 'M' }],
      modelProtocols: { 'only-messages': 'anthropic-messages' },
    })
    await collect(adapter, { provider: 'opencode-live', model: 'only-messages', messages: [] })
    assert.equal(gateway.requests[0].url, '/v1/messages', '没有走用户选择的端点')
    assert.equal(gateway.requests[0].headers['x-api-key'], 'test-key')
  } finally {
    await gateway.close()
  }
})

await test('连接失败抛 TRANSPORT', async () => {
  const adapter = makeAdapter('http://127.0.0.1:1/v1', { roster: [{ id: 'm1', name: 'M1' }] })
  let thrown
  try {
    await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [] })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, '应当抛出')
  const code = thrown?.failure?.code ?? thrown?.code
  assert.equal(code, 'TRANSPORT')
})

await test('已中止的信号直接返回 aborted', async () => {
  const gateway = await startGateway({ '/v1/chat/completions': { frames: [] } })
  try {
    const adapter = makeAdapter(gateway.url, { roster: [{ id: 'm1', name: 'M1' }] })
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect(adapter, { provider: 'opencode-live', model: 'm1', messages: [], signal: controller.signal })
    assert.equal(chunks[0].reason.kind, 'aborted')
    assert.equal(gateway.requests.length, 0)
  } finally {
    await gateway.close()
  }
})

// ── run ─────────────────────────────────────────────────────────────────────

section('结果')
const total = passed + failures.length
process.stdout.write(`\n${passed}/${total} 通过`)
if (failures.length > 0) {
  process.stdout.write(`，${failures.length} 失败\n`)
  for (const { label, error } of failures) process.stdout.write(`  - ${label}: ${error?.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n')
  process.exit(0)
}
