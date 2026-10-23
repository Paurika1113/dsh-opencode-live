/**
 * Host-contract regression test.
 *
 * The plugin's other suites assert what the *adapter* yields. This one asserts
 * that the *harness* accepts every one of those chunks, by feeding each one into
 * the real `AssistantStreamAccumulator` and `BlockAssembler` and reading the
 * final blocks back. That is the contract an adapter can silently violate: a
 * well-shaped custom event looks fine in a collected array and still throws
 * `unreachable variant` inside the accumulator on the first real turn.
 *
 * The host modules live inside the desktop app's `app.asar`, so they cannot be
 * imported by path. This test unpacks the two needed modules from that archive
 * into a temp directory and evaluates them, which means it runs the *installed*
 * host rather than a hand-written stand-in.
 *
 * Set `DSH_ASAR` to point at a different `app.asar`. When no archive can be
 * found the suite fails with a skip message rather than passing silently —
 * a green run that never touched the host would be worse than no test.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ASAR_CANDIDATES = [
  process.env.DSH_ASAR,
  'D:/Program Files (x86)/dshdesktop/resources/app.asar',
  'C:/Program Files/dsh-desktop/resources/app.asar',
  'C:/Program Files (x86)/dsh-desktop/resources/app.asar',
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

function locateAsar() {
  for (const candidate of ASAR_CANDIDATES) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  return null
}

/**
 * Pull `node_modules/@deepseek-ai/<pkg>/lib/index.js` out of the archive.
 *
 * The archive's own root prefix (`dsh/`, or whatever the build used) is matched
 * rather than assumed, so a repackaged app still resolves.
 *
 * @param {Buffer} bytes whole archive
 * @param {object} header parsed asar header
 * @param {string} pkg
 * @returns {string}
 */
function extractModule(bytes, header, pkg) {
  const suffix = `node_modules/@deepseek-ai/${pkg}/lib/index.js`
  const base = 8 + bytes.readUInt32LE(4)
  const stack = [header]
  while (stack.length > 0) {
    const node = stack.pop()
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = node.path === undefined ? name : `${node.path}/${name}`
      if (entry.files) {
        stack.push({ ...entry, path })
        continue
      }
      if (!path.endsWith(suffix)) continue
      if (entry.unpacked) throw new Error(`${path} is unpacked; extract it from app.asar.unpacked instead`)
      const start = base + Number(entry.offset)
      return bytes.subarray(start, start + entry.size).toString('utf8')
    }
  }
  throw new Error(`app.asar has no ${suffix}`)
}

/** Evaluate the host assembler source, which is plain ESM minus its imports. */
function loadHost(assemblerSource, valuesSource) {
  const valueRegion = valuesSource.slice(
    valuesSource.indexOf('//#region lib/types/index.js'),
    valuesSource.indexOf('\nexport {'),
  )
  const start = assemblerSource.indexOf('//#region lib/types/assembler.js')
  const end = assemblerSource.indexOf('//#endregion', assemblerSource.indexOf('//#region lib/types/assistant-stream.js'))
  assert.ok(start !== -1 && end > start, 'host assembler region not found in the unpacked module')
  const factory = new Function(
    `${valueRegion}\nconst brandString = (s) => s;\n${assemblerSource.slice(start, end)}\n`
    + 'return { AssistantStreamAccumulator, BlockAssembler, expandAssistantStream };',
  )
  return factory()
}

const asar = locateAsar()
if (asar === null) {
  console.error('SKIP host-contract: no app.asar found; set DSH_ASAR to the desktop build')
  process.exit(1)
}

const archive = readFileSync(asar)
const header = JSON.parse(archive.toString('utf8', 16, 16 + archive.readUInt32LE(12)))
const host = loadHost(
  extractModule(archive, header, 'dsh-llm'),
  extractModule(archive, header, 'dsh-util-values'),
)

const { OpenCodeLiveAdapter, OpenCodeZenFreeAdapter } = await import('../lib/adapter.js')
const { normalize, normalizeZenConfig } = await import('../lib/config.js')

/* -- fixtures -------------------------------------------------------------- */

const reasoningFrame = (text) => ({ choices: [{ delta: { reasoning_content: text } }] })
const textFrame = (text) => ({ choices: [{ delta: { content: text } }] })
const finishFrame = (reason, usage) => ({
  choices: [{ delta: {}, finish_reason: reason }],
  ...(usage === undefined ? {} : { usage }),
})
const callFrame = (item) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...item }] } }] })

const TOOLS = [
  { name: 'glob', description: 'List', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'read', description: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
]
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 6,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
}

/* -- harness --------------------------------------------------------------- */

/** Drive one adapter over a mocked SSE body and return every chunk in order. */
async function collect(frames, lane) {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(
      `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  try {
    const config = lane === 'zen'
      ? normalizeZenConfig({ baseURL: 'https://fixture.invalid/v1', apiKey: 'public' })
      : normalize({ baseURL: 'https://fixture.invalid/v1', apiKey: 'fixture-key', models: [{ id: 'fixture-model' }] })
    const Adapter = lane === 'zen' ? OpenCodeZenFreeAdapter : OpenCodeLiveAdapter
    const adapter = new Adapter({
      config,
      roster: () => [{ id: 'fixture-model' }],
      attributionUserAgent: 'offline-fixture',
      apiKey: 'fixture-key',
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: config.route,
      model: 'fixture-model',
      sessionId: `host-contract-${lane}`,
      messages: [],
      tools: TOOLS,
    })) chunks.push(chunk)
    assert.equal(requests, 1, 'one request per turn')
    return chunks
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Run the real host consumer over a chunk sequence.
 *
 * Both consumers are exercised: the accumulator decides whether the chunk is
 * legal, the assembler decides what the turn produced, and the durable replay
 * must rebuild the same blocks — an adapter that only satisfies one of the three
 * is still broken.
 */
function consume(chunks) {
  const accumulator = new host.AssistantStreamAccumulator()
  const assembler = new host.BlockAssembler()
  for (const [index, chunk] of chunks.entries()) {
    const timed = accumulator.push({ time: 1_000 + index, chunk })
    assembler.push(timed.chunk)
  }
  const replay = new host.BlockAssembler()
  for (const { chunk } of host.expandAssistantStream(accumulator.snapshot())) replay.push(chunk)
  assert.deepEqual(replay.blocks(), assembler.blocks(), 'durable replay must rebuild the same blocks')
  return { blocks: assembler.blocks(), finish: assembler.finish, usage: assembler.usage }
}

let passed = 0
let failed = 0
const test = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error.message}`)
  }
}

/* -- the contract ---------------------------------------------------------- */

console.log(`\n宿主契约（真实 ${asar}）`)

await test('free lane: reasoning-only turn is consumable', async () => {
  const result = consume(await collect([reasoningFrame('thinking')], 'zen'))
  assert.deepEqual(result.blocks, [{ type: 'reasoning', text: 'thinking' }])
  assert.deepEqual(result.finish, { kind: 'stop' })
})

await test('free lane: reasoning then text keeps both blocks and the usage', async () => {
  const result = consume(await collect([reasoningFrame('r'), textFrame('t'), finishFrame('stop', USAGE)], 'zen'))
  assert.deepEqual(result.blocks, [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 't' }])
  assert.deepEqual(result.finish, { kind: 'stop' })
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 2 })
})

await test('free lane: a tool turn finishes as tool-calls', async () => {
  const result = consume(await collect([
    callFrame({ id: 'call_1', function: { name: 'glob', arguments: '{"pattern":"*"}' } }),
    finishFrame('tool_calls'),
  ], 'zen'))
  assert.deepEqual(result.finish, { kind: 'tool-calls' })
  assert.deepEqual(result.blocks, [{ type: 'tool-call', id: 'call_1', name: 'glob', arguments: '{"pattern":"*"}' }])
})

await test('free lane: length truncation drops the unusable call and says max-tokens', async () => {
  const result = consume(await collect([
    callFrame({ id: 'call_1', function: { name: 'glob', arguments: '{"pattern":' } }),
    finishFrame('length'),
  ], 'zen'))
  assert.deepEqual(result.finish, { kind: 'max-tokens' })
  assert.deepEqual(result.blocks, [], 'a truncated call cannot be executed')
})

await test('free lane: a caller-declared read is not mistaken for the injected decoy', async () => {
  const result = consume(await collect([
    callFrame({ id: 'read_1', function: { name: 'read', arguments: '{"file_path":"x"}' } }),
    finishFrame('tool_calls'),
  ], 'zen'))
  assert.deepEqual(result.blocks, [{ type: 'tool-call', id: 'read_1', name: 'read', arguments: '{"file_path":"x"}' }])
})

await test('free lane: a name split from its arguments still yields one named call', async () => {
  const result = consume(await collect([
    callFrame({ id: 'call_9', function: { name: 'glob' } }),
    callFrame({ function: { arguments: '{"pattern":"*"}' } }),
    finishFrame('tool_calls'),
  ], 'zen'))
  assert.deepEqual(result.blocks, [{ type: 'tool-call', id: 'call_9', name: 'glob', arguments: '{"pattern":"*"}' }])
})

await test('free lane: a decoy that was never declared is dropped', async () => {
  const result = consume(await collect([
    callFrame({ id: 'decoy_1', function: { name: 'shell', arguments: '{"cmd":"rm"}' } }),
    finishFrame('tool_calls'),
  ], 'zen'))
  assert.deepEqual(result.blocks, [], 'the injected placeholder must never reach the executor')
  assert.deepEqual(result.finish, { kind: 'stop' })
})

await test('free lane: a call whose name never arrives is still reported', async () => {
  const result = consume(await collect([
    callFrame({ id: 'call_7', function: { arguments: '{"pattern":"*"}' } }),
    finishFrame('tool_calls'),
  ], 'zen'))
  const call = result.blocks.find((block) => block.type === 'tool-call')
  assert.ok(call, 'an unnamed call must not be silently discarded')
  assert.equal(call.id, 'call_7')
  assert.equal(call.arguments, '{"pattern":"*"}')
  assert.deepEqual(result.finish, { kind: 'tool-calls' })
})

await test('subscribed lane: the same data still passes unchanged', async () => {
  const result = consume(await collect([reasoningFrame('r'), textFrame('t'), finishFrame('stop', USAGE)], 'go'))
  assert.deepEqual(result.blocks, [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 't' }])
  assert.deepEqual(result.finish, { kind: 'stop' })
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 2 })
})

await test('both lanes emit only chunk types the accumulator knows', async () => {
  const known = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-start', 'block-end', 'usage', 'finish'])
  for (const lane of ['zen', 'go']) {
    const chunks = await collect([reasoningFrame('r'), textFrame('t'), finishFrame('stop', USAGE)], lane)
    const unknown = chunks.map((chunk) => chunk.type).filter((type) => !known.has(type))
    assert.deepEqual(unknown, [], `${lane} emitted a type the accumulator rejects: ${unknown.join(', ')}`)
  }
})

console.log(`\n宿主契约结果\n\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
