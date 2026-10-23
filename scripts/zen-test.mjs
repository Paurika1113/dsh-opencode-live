/**
 * Zen 免费车道单元与协议测试。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import {
  mintZenSessionId,
  isCanonicalZenSession,
  zenSessionForConversation,
  applyZenFingerprint,
  zenGatewayHeaders,
  isZenFreeModel,
  ZEN_CLIENT_UA,
  ZEN_FINGERPRINT_TOOLS,
  ZEN_FREE_PRESETS,
} from '../lib/zen-wire.js'
import { readListing } from '../lib/discovery.js'
import { fetchZenLiveModels } from '../lib/discovery.js'
import { capacityFromLimit, extractProvider, loadCatalogue, readCatalogue } from '../lib/zen-catalogue.js'
import { normalizeZenConfig, DEFAULT_ZEN_CONFIG } from '../lib/config.js'

const pending = []
const failures = []

/**
 * A `Response`-shaped object whose body is a real byte stream.
 *
 * `readBounded` deliberately keeps nothing when `body` is null, so a stub that
 * only implements `text()` would exercise the empty-body branch instead of the
 * parser — the test would pass for the wrong reason.
 *
 * @param {unknown} payload
 * @param {{ status?: number }} [init]
 */
function jsonResponse(payload, init = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: { get: () => String(bytes.byteLength) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function test(name, fn) {
  let result
  try {
    result = fn()
  } catch (error) {
    console.error(`  FAIL  ${name}`)
    throw error
  }
  // Async tests must be awaited before the summary prints; a rejection that
  // surfaces after `ok` reads as a pass and hides the failure.
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    pending.push(result.then(
      () => console.log(`  ok  ${name}`),
      (error) => {
        failures.push({ name, error })
        console.error(`  FAIL  ${name}: ${error?.message}`)
      },
    ))
    return
  }
  console.log(`  ok  ${name}`)
}

console.log('\nZen Session 算法与格式校验')
test('铸造的 session 符合格式与低12位倒序要求', () => {
  for (let i = 0; i < 10; i++) {
    const s = mintZenSessionId()
    assert.equal(isCanonicalZenSession(s), true, `session ${s} should be canonical`)
  }
})

test('对话绑定稳定复用同一 session', () => {
  const s1 = zenSessionForConversation('conv-1')
  const s2 = zenSessionForConversation('conv-1')
  assert.equal(s1, s2)
  const s3 = zenSessionForConversation('conv-2')
  assert.notEqual(s1, s3)
})

console.log('\nZen 门禁指纹与请求头')
test('请求头完整包含 CLI UA 与 session 群组', () => {
  const session = mintZenSessionId()
  const headers = zenGatewayHeaders({ session, apiKey: 'public', stream: true })
  assert.equal(headers['user-agent'], ZEN_CLIENT_UA)
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-project'], 'global')
  assert.equal(headers['x-opencode-session'], session)
  assert.equal(headers['x-opencode-session-id'], session)
  assert.equal(headers['x-session-affinity'], session)
  assert.equal(headers['x-session-id'], session)
  assert.equal(headers['authorization'], 'Bearer public')
  assert.equal(headers['x-opencode-request'], undefined, '绝不能带 x-opencode-request')
})

test('applyZenFingerprint 强制 stream 并注入 read/shell 工具及警告', () => {
  const body = {
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: 'test' }],
    tool_choice: 'none',
  }
  const injected = applyZenFingerprint(body)
  assert.equal(body.stream, true)
  assert.equal(body.tool_choice, undefined)
  const names = body.tools.map(t => t.function?.name ?? t.name)
  assert.equal(names.includes('read'), true)
  assert.equal(names.includes('shell'), true)
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /Do not call the `read` or `shell` tools/)
  assert.deepEqual([...injected].sort(), ['read', 'shell'], '两个占位都被报告')
})

test('applyZenFingerprint 只报告自己注入的占位，不把调用方工具当占位', () => {
  const body = {
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: 'test' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'real', parameters: {} } }],
  }
  const injected = applyZenFingerprint(body)
  assert.deepEqual([...injected], ['shell'], 'read 是调用方声明的真工具')
  const names = body.tools.map(t => t.function?.name ?? t.name)
  assert.equal(names.filter(name => name === 'read').length, 1, '真 read 不被覆盖或重复注入')
})

console.log('\nZen 免费模型识别与配置')
test('识别常见 free 模型', () => {
  assert.equal(isZenFreeModel('deepseek-v4.1-flash-free'), true)
  assert.equal(isZenFreeModel('big-pickle'), true)
  assert.equal(isZenFreeModel('glm-5.3-flash-free'), true)
  assert.equal(isZenFreeModel('minimax-m3.1-flash'), false)
  assert.equal(isZenFreeModel('gpt-5.6'), false)
})

test('normalizeZenConfig 具有健壮的默认值', () => {
  const cfg = normalizeZenConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.route, DEFAULT_ZEN_CONFIG.route)
  assert.equal(cfg.apiKey, 'public')
  assert.equal(cfg.baseURL, 'https://opencode.ai/inference/v1')
})

console.log('\nZen 适配器契约校验')
import { OpenCodeZenFreeAdapter } from '../lib/adapter.js'

test('providerInfo 与 providerRetryPolicy 同步返回有效对象', () => {
  const adapter = new OpenCodeZenFreeAdapter({
    config: { route: 'opencode-zen-free', displayName: 'OpenCode Zen · 免费模型' },
    roster: () => [],
  })
  const info = adapter.providerInfo('opencode-zen-free')
  assert.equal(info instanceof Promise, false, 'providerInfo 必须是同步方法')
  assert.equal(info.id, 'opencode-zen-free')
  assert.equal(info.name, 'OpenCode Zen · 免费模型')

  const policy = adapter.providerRetryPolicy('opencode-zen-free')
  assert.equal(policy instanceof Promise, false, 'providerRetryPolicy 必须是同步方法')
  assert.equal(typeof policy.maxRetries, 'number')
})

test('listModels 与 resolveModel 符合 DSH 核心契约', async () => {
  const testRoster = [
    { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', contextWindow: 131072, maxTokens: 32768, vision: false },
  ]
  const adapter = new OpenCodeZenFreeAdapter({
    config: { route: 'opencode-zen-free', displayName: 'OpenCode Zen · 免费模型' },
    roster: () => testRoster,
  })

  const models = await adapter.listModels('opencode-zen-free')
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, 'opencode-zen-free')
  assert.equal(models[0].id, 'deepseek-v4.1-flash-free')
  assert.equal(models[0].name, 'DeepSeek V4.1 Flash Free')

  const resolved = await adapter.resolveModel('opencode-zen-free', 'deepseek-v4.1-flash-free')
  assert.equal(resolved.provider, 'opencode-zen-free')
  assert.equal(resolved.id, 'deepseek-v4.1-flash-free')
  assert.equal(resolved.name, 'DeepSeek V4.1 Flash Free')
  assert.equal(resolved.context.contextWindow, 131072)
  assert.equal(resolved.defaultMaxTokens, 32768)
})

console.log('\n容量目录（models.dev）')

// A miniature catalogue shaped like the real one: `opencode` is only one
// provider among many, which is the detail that matters — the reader must pick
// that provider out and ignore every other.
const FIXTURE = {
  opencode: {
    id: 'opencode',
    models: {
      'deepseek-v4.1-flash-free': {
        name: 'DeepSeek V4.1 Flash (Free)',
        limit: { context: 200000, output: 32000 },
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      'big-pickle': {
        name: 'Big Pickle',
        // Deliberately unlike any snapshot value: if the code reads the snapshot
        // instead of the catalogue, these assertions fail instead of coinciding.
        limit: { context: 123456, output: 11111 },
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
      },
      // No `limit` at all: this is the case that must *not* be invented.
      'no-limit-model': { name: 'No Limit', modalities: { input: ['text'] } },
      // `context` and `input` both present — the smaller one wins, because a
      // request cannot exceed the input window even when the context window is
      // nominally larger.
      'dual-limit': { limit: { context: 1000000, input: 120000, output: 65536 } },
      // Garbage that must be skipped rather than crash the parse.
      'not-an-object': 42,
    },
  },
  anthropic: { id: 'anthropic', models: { 'claude-x': { limit: { context: 999, output: 999 } } } },
}

test('readCatalogue 只取 opencode 且正确翻译 limit', () => {
  const table = readCatalogue(FIXTURE)
  assert.equal(table.has('claude-x'), false, '不能把别的 provider 的模型混进来')

  const free = table.get('deepseek-v4.1-flash-free')
  assert.equal(free.contextWindow, 200000)
  assert.equal(free.maxTokens, 32000)
  assert.equal(free.vision, true, 'modalities.input 含 image 应翻译成 vision')
  assert.equal(free.reasoning, true)
  assert.equal(free.name, 'DeepSeek V4.1 Flash (Free)')

  assert.equal(table.get('big-pickle').vision, false)
  // Missing capacity stays missing — the caller falls back, the catalogue does
  // not guess.
  const bare = table.get('no-limit-model')
  assert.equal(bare.contextWindow, undefined)
  assert.equal(bare.maxTokens, undefined)

  const dual = table.get('dual-limit')
  assert.equal(dual.contextWindow, 120000, 'context 与 input 同时存在时取较小者')
  assert.equal(dual.maxTokens, 65536)

  assert.equal(table.has('not-an-object'), false, '非对象条目应被跳过')
})

test('capacityFromLimit 拒绝非法数字', () => {
  assert.deepEqual(capacityFromLimit({ context: -1, output: 0 }), {}, '负数与零不是容量')
  assert.deepEqual(capacityFromLimit({ context: '999', output: 1.5 }), {}, '字符串与小数不是容量')
  assert.deepEqual(capacityFromLimit({ context: 12345 }), { contextWindow: 12345 })
  assert.deepEqual(capacityFromLimit(null), {})
})

test('extractProvider 裁掉无关 provider 与无关字段', () => {
  const trimmed = extractProvider(JSON.stringify(FIXTURE))
  assert.deepEqual(Object.keys(trimmed), ['opencode'])
  assert.equal(trimmed.opencode.models['claude-x'], undefined)
  const kept = trimmed.opencode.models['deepseek-v4.1-flash-free']
  assert.deepEqual(kept.limit, { context: 200000, output: 32000 })
  assert.equal(kept.name, 'DeepSeek V4.1 Flash (Free)')
  // 裁剪后的目录必须与裁剪前解析出同一张表，否则缓存就是错的。
  assert.deepEqual([...readCatalogue(trimmed)], [...readCatalogue(JSON.parse(JSON.stringify(FIXTURE)))])
})

test('extractProvider 对缺失的 provider 返回 null', () => {
  assert.equal(extractProvider(JSON.stringify({ anthropic: { id: 'anthropic', models: {} } })), null)
})

test('loadCatalogue 在无网络且无缓存时报 none 并给出空表', async () => {
  const answer = await loadCatalogue({
    url: 'https://127.0.0.1:1/definitely-not-listening.json',
    cachePath: '',
    timeoutMs: 2000,
  })
  assert.equal(answer.source, 'none')
  assert.equal(answer.table, null)
  assert.match(answer.message, /无法获取模型目录/)
})

test('loadCatalogue 在刷新失败时沿用未过期缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zen-cat-'))
  const cachePath = join(dir, 'catalogue.json')
  try {
    // Seed a cache the way a successful round would have.
    await writeFile(cachePath, JSON.stringify({ at: Date.now(), url: 'x', catalogue: extractProvider(JSON.stringify(FIXTURE)) }), 'utf8')
    const answer = await loadCatalogue({
      url: 'https://127.0.0.1:1/definitely-not-listening.json',
      cachePath,
      ttlMs: 60_000,
      forceRefresh: true,
      timeoutMs: 2000,
    })
    assert.equal(answer.source, 'cache', '刷新失败应降级到缓存')
    assert.equal(answer.table.get('deepseek-v4.1-flash-free').contextWindow, 200000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadCatalogue 把缓存写成裁剪后的目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zen-cat-'))
  const cachePath = join(dir, 'catalogue.json')
  try {
    // Serve the fixture over a real socket so the network path runs end to end.
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(FIXTURE))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const answer = await loadCatalogue({ url: `http://127.0.0.1:${port}/api.json`, cachePath })
      assert.equal(answer.source, 'network')
      const raw = JSON.parse(await readFile(cachePath, 'utf8'))
      assert.equal(raw.text, undefined, '缓存不应保留整份原始目录')
      assert.deepEqual(Object.keys(raw.catalogue), ['opencode'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    // Second load must read that cache without touching the network.
    const again = await loadCatalogue({ url: 'https://127.0.0.1:1/would-fail.json', cachePath })
    assert.equal(again.source, 'cache')
    assert.equal(again.table.size, 4, '裁剪后的缓存应能还原出同一批带容量的模型')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('目录优先级：目录的值覆盖离线预设', async () => {
  const table = readCatalogue(FIXTURE)
  const models = await fetchZenLiveModels({
    baseURL: 'https://opencode.ai/inference/v1',
    apiKey: 'public',
    catalogue: table,
    fetchImpl: async () => jsonResponse({
      data: [
        { id: 'deepseek-v4.1-flash-free', object: 'model', owned_by: 'opencode' },
        { id: 'big-pickle', object: 'model', owned_by: 'opencode' },
      ],
    }),
  })
  assert.equal(models.ok, true)
  const byId = new Map(models.models.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('deepseek-v4.1-flash-free').contextWindow, 200000, '应使用目录里的真实上限')
  assert.equal(byId.get('deepseek-v4.1-flash-free').maxTokens, 32000)
  assert.equal(byId.get('big-pickle').contextWindow, 123456)
  assert.equal(byId.get('big-pickle').vision, false)
})

test('目录缺失的模型回退到离线快照', async () => {
  // `big-pickle` is in the fixture; `beam-free` is not — it must come out with
  // the snapshot's numbers rather than `undefined`.
  const models = await fetchZenLiveModels({
    baseURL: 'https://opencode.ai/inference/v1',
    apiKey: 'public',
    catalogue: readCatalogue(FIXTURE),
    fetchImpl: async () => jsonResponse({ data: [{ id: 'beam-free', object: 'model' }] }),
  })
  assert.equal(models.ok, true)
  const beam = models.models.find((entry) => entry.id === 'beam-free')
  assert.equal(beam.contextWindow, ZEN_FREE_PRESETS['beam-free'].contextWindow)
  assert.equal(beam.maxTokens, ZEN_FREE_PRESETS['beam-free'].maxTokens)
})

await Promise.all(pending)
if (failures.length > 0) {
  console.error(`\n${failures.length} 失败`)
  process.exitCode = 1
}

