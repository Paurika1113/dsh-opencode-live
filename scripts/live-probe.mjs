/**
 * Live end-to-end check against the real gateway.
 *
 * Verifies the three things this route is responsible for:
 *   1. discovery reads the gateway's *live* listing (not a build-time snapshot);
 *   2. each model is dialled on the dialect the user chose for it;
 *   3. the adapter's stream produces harness chunks for a real turn.
 *
 * Consumes a handful of tokens (a short completion per model). Run:
 *   node scripts/live-probe.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalize } from '../lib/config.js'
import { fetchLiveModels } from '../lib/discovery.js'
import { OpenCodeLiveAdapter } from '../lib/adapter.js'

function readKey() {
  const store = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const match = store.match(/^\s*(OPENCODE_GO_API_KEY|OPENCODEGO_API_KEY):\s+(.+?)\s*$/m)
  if (!match) throw new Error('credential store has no OPENCODE_GO_API_KEY')
  return match[2].replace(/^['"]|['"]$/g, '')
}

const key = readKey()
let failures = 0

const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ── 1. discovery ────────────────────────────────────────────────────────────

console.log('\n=== 1. 实时模型列表 ===')
const listing = await fetchLiveModels({ baseURL: 'https://opencode.ai/zen/go/v1', apiKey: key, timeoutMs: 20000 })
if (!listing.ok) {
  console.error(`发现失败：${listing.message}`)
  process.exit(1)
}
console.log(`  ${listing.endpoint}  →  ${listing.models.length} 个模型`)
check('拉到了模型', listing.models.length > 0)
const ids = listing.models.map((m) => m.id)
check('minimax-m3.1-flash-free 在列', ids.includes('minimax-m3.1-flash-free'))

// ── 2. per-model dialect ────────────────────────────────────────────────────

console.log('\n=== 2. 按选择的协议拨号 ===')
// The dialects below are the ones measured against this gateway on 2026-10-21;
// they are exactly what the settings page lets a user record.
const CHOSEN = {
  'minimax-m3.1-flash-free': 'chat-completions',
  'grok-4.7': 'responses',
  'claude-haiku-5-5': 'anthropic-messages',
  'minimax-m2.7': 'anthropic-messages',
}

const cfg = normalize({
  baseURL: 'https://opencode.ai/zen/go/v1',
  apiKey: key,
  modelProtocols: CHOSEN,
})

const roster = listing.models.map((m) => ({
  ...m,
  ...(CHOSEN[m.id] === undefined ? {} : { protocol: CHOSEN[m.id] }),
}))

const adapter = new OpenCodeLiveAdapter({
  config: cfg,
  liveConfig: () => cfg,
  roster: () => roster,
  attributionUserAgent: 'dsh-opencode-live/0.3.0 (opencode/1.18.31)',
  apiKey: key,
  log: () => {},
})

check('未选择的模型回落到 chat-completions',
  adapter.protocolFor('some-model-nobody-classified') === 'chat-completions')
for (const [model, expected] of Object.entries(CHOSEN)) {
  check(`${model} 走 ${expected}`, adapter.protocolFor(model) === expected, adapter.protocolFor(model))
}

// ── 3. real turns ───────────────────────────────────────────────────────────

console.log('\n=== 3. 真实对话 ===')
async function runTurn(model, sessionId) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: cfg.route,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'reply with the single word: ok' }] }],
    sessionId,
    // A thinking model spends part of the budget on reasoning before it emits
    // text, so the ceiling has to leave room for both.
    maxTokens: 512,
  })) chunks.push(chunk)
  const finish = chunks.find((c) => c.type === 'finish')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const blocks = chunks.filter((c) => c.type === 'block-end').length
  return { finish, text, blocks }
}

for (const model of ['minimax-m3.1-flash-free', 'grok-4.7', 'claude-haiku-5-5']) {
  if (!ids.includes(model)) { console.log(`  skip ${model}（不在当前列表）`); continue }
  const out = await runTurn(model, `liveprobe-${model}`)
  console.log(`  ${model.padEnd(28)} ${JSON.stringify(out.finish?.reason ?? {})}  text=${JSON.stringify(out.text.slice(0, 24))}`)
  check(`${model} 返回 stop`, out.finish?.reason?.kind === 'stop', JSON.stringify(out.finish?.reason ?? {}))
  check(`${model} 产生了文本`, out.blocks > 0)
}

// ── 4. session header ───────────────────────────────────────────────────────

console.log('\n=== 4. 会话头 ===')
const sessionA1 = await adapter.headersFor({ sessionId: 'same-conversation' }, 'uuid-a', 'chat-completions')
const sessionA2 = await adapter.headersFor({ sessionId: 'same-conversation' }, 'uuid-a', 'chat-completions')
const sessionB = await adapter.headersFor({ sessionId: 'other-conversation' }, 'uuid-b', 'chat-completions')
check('同一对话一致', sessionA1['x-opencode-session'] === sessionA2['x-opencode-session'])
check('不同对话不同', sessionA1['x-opencode-session'] !== sessionB['x-opencode-session'])

const anthropicHeaders = await adapter.headersFor({ sessionId: 's' }, 'uuid', 'anthropic-messages')
check('messages 用 x-api-key 而非 Bearer',
  anthropicHeaders['x-api-key'] !== undefined && anthropicHeaders.authorization === undefined)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exitCode = failures === 0 ? 0 : 1
