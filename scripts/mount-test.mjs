/**
 * Mount test: does the fiber register its route, its directory entry, and its
 * discovery offer against a realistic fake `ctx`?
 *
 * No DSH process, no network. Run: node scripts/mount-test.mjs
 *
 * This is the test that catches the failure modes that only appear at mount time:
 * a route id that collides, a schema that throws, a cleanup that does not release
 * what it took.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, Config, name, inject } from '../lib/index.js'

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

/**
 * A `ctx` that records what the fiber does, shaped like the real one for the
 * seams this plugin touches.
 *
 * `effect(fn)` follows the cordis contract: the callback itself *is* the
 * disposer. The plugin registers its cleanup that way, so a fake that treated the
 * return value as the disposer would test a contract the host does not have.
 *
 * Each fake context also carries its own temporary override directory, so a test
 * never reads (or overwrites) the developer's real saved choices. That isolation
 * is the difference between a suite that asserts the plugin's behaviour and one
 * that asserts whatever was last clicked in the app.
 */
function fakeCtx({ hasCredentials = true, registerAdapterThrows, brokenWebServer = false, scopeWithoutEffect = false, registerReturnsNothing = false } = {}) {
  const state = {
    adapters: new Map(),
    directory: [],
    discoveries: new Map(),
    disposers: [],
    warnings: [],
    errors: [],
    infos: [],
    webRoutes: new Map(),
    mounts: [],
    writes: [],
    overridesPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-mount-')),
  }

  const ctx = {
    logger: {
      info: (...args) => state.infos.push(args),
      warn: (...args) => state.warnings.push(args),
      error: (...args) => state.errors.push(args),
    },
    get: (service) => (service === 'credentials' && hasCredentials ? {
      resolve: async (ref) => (ref === 'OPENCODE_GO_API_KEY' ? { value: 'test-key' } : undefined),
      // The real signature is `set(ref, value)` where value is the secret itself.
      // A fake that accepted a record object would let a plugin passing the wrong
      // shape pass its own tests — which is exactly how this shipped broken.
      set: async (ref, value) => {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
        }
        state.writes.push({ ref, secret: value })
      },
      unset: async (ref) => { state.writes.push({ ref, secret: undefined }) },
    } : undefined),
    // cordis: the callback is the disposer.
    effect: (fn) => {
      if (typeof fn === 'function') state.disposers.push(fn)
    },
    inject: (services, callback) => {
      callback({
        get: ctx.get,
        // An older scope object without its own `effect`; the plugin must then fall
        // back to the parent context rather than declaring the mount a failure.
        ...(scopeWithoutEffect ? {} : { effect: ctx.effect }),
        // A composition whose web server offers no registration seam at all.
        webServer: brokenWebServer ? {} : {
          // The real seam is `register({ kind, path, handler })` returning a
          // disposer. A fake offering only `route()` would let a plugin that calls
          // a method the host does not have pass its own tests — which is exactly
          // how a 404 on every path reached the app.
          register: (mount) => {
            state.mounts.push(mount)
            state.webRoutes.set(mount.path, mount.handler)
            // A seam that mounts without handing back a way to unmount. The real one
            // does return a disposer; a fake must be able to model the absence too,
            // or the plugin's "mounted but unreleasable" branch is untested.
            if (registerReturnsNothing) return undefined
            return () => state.webRoutes.delete(mount.path)
          },
        },
      })
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        for (const provider of providers) {
          if (registerAdapterThrows === provider) {
            const error = new Error(`an adapter for provider "${provider}" is already registered`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
          if (state.adapters.has(provider)) {
            const error = new Error(`an adapter for provider "${provider}" is already registered`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
          const info = adapter.providerInfo(provider)
          if (info instanceof Promise) throw new Error('adapter.providerInfo must be synchronous')
          if (typeof info?.id !== 'string' || info.id !== provider || typeof info?.name !== 'string' || info.name.length === 0) {
            throw new Error(`INVALID_ADAPTER: adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`)
          }
          const policy = adapter.providerRetryPolicy(provider)
          if (policy instanceof Promise) throw new Error('adapter.providerRetryPolicy must be synchronous')
          state.adapters.set(provider, adapter)
        }
        return () => state.adapters.delete(providers[0])
      },
      registerConfigurableProviders: (entries) => {
        state.directory.push(...entries)
        const release = () => { state.directory = state.directory.filter((e) => !entries.includes(e)) }
        release.replace = (next) => { state.directory = [...next] }
        return release
      },
      registerModelDiscovery: (ns, fn) => {
        if (state.discoveries.has(ns)) {
          const error = new Error(`model discovery for "${ns}" is already registered`)
          error.code = 'DUPLICATE_DISCOVERY'
          throw error
        }
        state.discoveries.set(ns, fn)
        return () => state.discoveries.delete(ns)
      },
    },
    fiber: { entry: { options: { id: 'opencode-live' } } },
  }
  return { ctx, state }
}

/** Wait for the mount-time refresh kickoff to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

/**
 * Mount the plugin with this fake context's isolated override directory.
 *
 * Every test goes through here rather than calling `apply` directly, so no test
 * can accidentally read the real `~/.dsh/opencode-live/config.json` — which is
 * the user's live configuration, not test data.
 *
 * @param {object} ctx
 * @param {object} state - the fake's state, carrying `overridesPath`.
 * @param {object} [config]
 */
function mount(ctx, state, config = {}) {
  apply(ctx, { overridesPath: state.overridesPath, ...config })
}

/** A response object shaped like the one the web server hands a route. */
function newResponse() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status },
    end(body) { this.body = body },
  }
}

/** A request whose body is one JSON document. */
function newRequest(url, method, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

// ── schema ──────────────────────────────────────────────────────────────────

section('模块导出')

await test('导出 name / inject / apply', () => {
  assert.equal(name, 'dsh-opencode-live')
  assert.deepEqual(inject, ['llm'])
  assert.equal(typeof apply, 'function')
})

await test('Config 要么是可用 schema，要么是 undefined（不会 throw）', () => {
  assert.ok(Config === undefined || typeof Config === 'object' || typeof Config === 'function')
})

// ── mount ───────────────────────────────────────────────────────────────────

section('挂载')

await test('注册路由、目录条目与发现回调', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()

  assert.ok(state.adapters.has('opencode-live'), '主适配器未注册')
  assert.ok(state.adapters.has('opencode-zen-free'), 'Zen 免费适配器未注册')
  assert.equal(state.directory.length, 2)
  assert.equal(state.directory[0].provider, 'opencode-live')
  assert.equal(state.directory[0].settingsNs, 'opencode-live')
  assert.equal(state.directory[1].provider, 'opencode-zen-free')
  assert.ok(state.discoveries.has('opencode-live'), '主发现回调未注册')
  assert.ok(state.discoveries.has('opencode-live.zen'), 'Zen 发现回调未注册')
})

await test('挂载时不会抛错退出（即使网关不可达）', async () => {
  const { ctx, state } = fakeCtx()
  assert.doesNotThrow(() => mount(ctx, state, { baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 200 }))
  await settle()
  assert.ok(state.adapters.has('opencode-live'))
})

await test('enabled: false 时不注册任何东西', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { enabled: false })
  await settle()
  assert.equal(state.adapters.size, 0)
  assert.equal(state.discoveries.size, 0)
})

await test('配置非法时不注册，且记录错误', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { baseURL: 'ftp://nope' })
  await settle()
  assert.equal(state.adapters.size, 0)
  assert.ok(state.errors.length > 0, '应当记录错误')
})

await test('路由被占用时记录可读错误并退出', async () => {
  const { ctx, state } = fakeCtx({ registerAdapterThrows: 'opencode-live' })
  mount(ctx, state)
  await settle()
  assert.equal(state.adapters.size, 0)
  const message = state.errors.map((args) => args.join(' ')).join('\n')
  assert.match(message, /DUPLICATE|已被其他适配器占用/)
})

await test('自定义 route 被采纳', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { route: 'opencode-live-alt' })
  await settle()
  assert.ok(state.adapters.has('opencode-live-alt'))
  assert.equal(state.directory[0].provider, 'opencode-live-alt')
})

// ── adapter contract ────────────────────────────────────────────────────────

section('适配器契约')

await test('providerInfo 保留 id 且名字非空', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { displayName: '测试路由' })
  await settle()
  const adapter = state.adapters.get('opencode-live')
  const info = adapter.providerInfo('opencode-live')
  assert.equal(info.id, 'opencode-live')
  assert.equal(info.name, '测试路由')
})

await test('providerRetryPolicy 是已解析的策略', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()
  const policy = state.adapters.get('opencode-live').providerRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.ok(Array.isArray(policy.retryableCodes))
  assert.ok(Number.isInteger(policy.maxRetries))
})

await test('resolveModel 补全上下文窗口', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { defaultContextWindow: 123456, defaultMaxTokens: 4096 })
  await settle()
  const model = await state.adapters.get('opencode-live').resolveModel('opencode-live', 'whatever')
  assert.equal(model.context.contextWindow, 123456)
  assert.equal(model.defaultMaxTokens <= 123456, true)
})

await test('listModels 输出合法元数据', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { models: [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100 }] })
  await settle()
  const models = await state.adapters.get('opencode-live').listModels('opencode-live')
  // The mount-time refresh fails against no network, so the declared roster stands.
  assert.ok(models.every((m) => m.provider === 'opencode-live' && m.id.length > 0 && m.name.length > 0))
})

// ── discovery offer ─────────────────────────────────────────────────────────

section('发现回调')

await test('发现回调在网关不可达时返回配置声明的模型', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, {
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 200,
    models: [{ id: 'declared', name: 'Declared' }],
  })
  await settle()
  const discover = state.discoveries.get('opencode-live')
  const models = await discover({}, undefined)
  assert.ok(Array.isArray(models))
  assert.ok(models.some((m) => m.id === 'declared'), '配置声明的模型应当保留')
})

// ── cleanup ─────────────────────────────────────────────────────────────────

section('卸载')

await test('disposer 释放路由与目录条目', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()
  assert.equal(state.adapters.size, 2)
  assert.equal(state.disposers.length > 0, true)
  // Each registered effect callback, invoked as the host would on unload.
  for (const effect of state.disposers) {
    const disposer = effect()
    if (typeof disposer === 'function') disposer()
  }
  assert.equal(state.adapters.size, 0)
  assert.equal(state.directory.length, 0)
})

// ── web route ───────────────────────────────────────────────────────────────

section('设置页接口')

await test('接口挂在 /api/opencode-live', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()
  assert.ok(state.webRoutes.has('/api/opencode-live'))
})

await test('用 prefix 方式注册（webServer 只有 register）', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()
  assert.equal(state.mounts.length, 1, '应当恰好注册一次')
  assert.equal(state.mounts[0].kind, 'prefix')
  assert.equal(state.mounts[0].path, '/api/opencode-live')
  assert.equal(typeof state.mounts[0].handler, 'function')
})

await test('没有 webServer.register 时记录错误而不是静默', async () => {
  const { ctx, state } = fakeCtx({ brokenWebServer: true })
  mount(ctx, state)
  await settle()
  const message = state.errors.map((args) => args.join(' ')).join('\n')
  assert.match(message, /webServer\.register|设置页接口/)
})

await test('scope 没有 effect 时回退到 ctx.effect，接口照样能清理', async () => {
  // An older scope object without its own `effect` is not a failure: the routes
  // really are mounted, and the parent context can still hand out the disposer.
  const { ctx, state } = fakeCtx({ scopeWithoutEffect: true })
  mount(ctx, state)
  await settle()
  assert.ok(state.webRoutes.has('/api/opencode-live'), '接口应当确实挂上了')
  assert.equal(state.errors.length, 0, '不该记录错误')
  assert.equal(state.warnings.length, 0, '有可用的回退钩子，不该告警')
  for (const fn of state.disposers) fn()?.()
  assert.equal(state.webRoutes.has('/api/opencode-live'), false, '回退的钩子也应能释放接口')
})

await test('注册成功但 register 没返回 disposer 时只警告，不谎报挂载失败', async () => {
  // Mounted but unreleasable: the endpoints work and only outlive the fiber.
  // Reporting a mount failure here would send the reader looking for the wrong
  // problem — the page is being served while the log says it is not.
  const { ctx, state } = fakeCtx({ registerReturnsNothing: true })
  mount(ctx, state)
  await settle()
  assert.ok(state.webRoutes.has('/api/opencode-live'), '接口应当确实挂上了')
  assert.equal(state.errors.length, 0, '不该记录错误')
  const warned = state.warnings.map((args) => args.join(' ')).join('\n')
  assert.match(warned, /清理钩子/)
})

await test('清理时释放接口注册', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()
  assert.ok(state.webRoutes.has('/api/opencode-live'))
  // cordis contract: the callback *returns* the disposer, so calling it is the
  // setup step and its result is the cleanup — not the cleanup itself.
  for (const fn of state.disposers) fn()?.()
  assert.equal(state.webRoutes.has('/api/opencode-live'), false, '停用后接口应当消失')
})

await test('/health 返回 ok', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state)
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler({ url: '/api/opencode-live/health', method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
})

await test('/view 报告状态与模型', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { models: [{ id: 'm1', name: 'M1' }] })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler({ url: '/api/opencode-live/view', method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.route, 'opencode-live')
  assert.ok(Array.isArray(payload.models))
  assert.ok(payload.models.some((m) => m.id === 'm1'))
  assert.equal(typeof payload.lastRefresh.ok, 'boolean')
  assert.equal(typeof payload.storePath, 'string')
})

await test('/update 把密钥写进凭据库，且不回声', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { apiKey: 'sk-typed-secret' }), res)
  assert.equal(res.statusCode, 200)
  assert.ok(
    state.writes.some((w) => w.ref === 'OPENCODE_GO_API_KEY' && w.secret === 'sk-typed-secret'),
    '密钥没有写进凭据库',
  )
  assert.equal(res.body.includes('sk-typed-secret'), false, '响应体泄露了密钥')
})

await test('凭据服务晚于 fiber 出现时仍能写入', async () => {
  // The credential service is published by another bundle. A plugin that captured
  // `ctx.get('credentials')` at mount time would answer "no credential service"
  // forever after — the failure this test exists to prevent.
  const { ctx, state } = fakeCtx({ hasCredentials: false })
  mount(ctx, state, { baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()

  // The service appears after mount.
  state.lateCredential = {
    resolve: async () => ({ value: 'late-key' }),
    set: async (ref, value) => { state.writes.push({ ref, secret: value }) },
    unset: async (ref) => { state.writes.push({ ref, secret: undefined }) },
  }
  ctx.get = ((original) => (service) => (service === 'credentials' ? state.lateCredential : original(service)))(ctx.get)

  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { apiKey: 'sk-late' }), res)
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(state.writes.some((w) => w.secret === 'sk-late'), '晚到的凭据服务没有被使用')
})

await test('/update 清空密钥走 unset 而不是写空串', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { apiKey: '' }), res)
  assert.equal(res.statusCode, 200, res.body)
  const last = state.writes.at(-1)
  assert.equal(last.ref, 'OPENCODE_GO_API_KEY')
  assert.equal(last.secret, undefined, '空密钥应当走 unset')
})

await test('/update 归一化 baseURL（完整端点 → 前缀）', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-upd-'))
  apply(ctx, { overridesPath: tmp, baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', {
    baseURL: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
  }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).baseURL, 'https://opencode.ai/inference/go/openai/v1', '完整端点没有被裁剪')
  // And it must be persisted, not just echoed.
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.equal(saved.baseURL, 'https://opencode.ai/inference/go/openai/v1')
})

await test('/update 拒绝非对象 body', async () => {
  const { ctx, state } = fakeCtx()
  mount(ctx, state, { baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  const text = '[1,2,3]'
  await handler({
    url: '/api/opencode-live/update',
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(text) },
  }, res)
  assert.equal(res.statusCode, 400)
})

await test('/reset 删掉覆盖配置文件', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-reset-'))
  apply(ctx, { overridesPath: tmp, baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()
  const configFile = path.join(tmp, 'config.json')
  fs.writeFileSync(configFile, '{"displayName":"x"}\n', 'utf8')
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler({ url: '/api/opencode-live/reset', method: 'POST', async *[Symbol.asyncIterator]() {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(fs.existsSync(configFile), false, '覆盖文件仍然存在')
})

await test('挂载心跳记录 plugin 与 route', async () => {
  const { ctx } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-hb-'))
  apply(ctx, { overridesPath: tmp, baseURL: 'https://127.0.0.1:1/v1', discoveryTimeoutMs: 150 })
  await settle()
  const heartbeat = JSON.parse(fs.readFileSync(path.join(tmp, 'mounted.json'), 'utf8'))
  assert.equal(heartbeat.plugin, 'dsh-opencode-live')
  assert.equal(heartbeat.route, 'opencode-live')
  assert.ok(['applying', 'mounted'].includes(heartbeat.state), `意外的 state: ${heartbeat.state}`)
})

// ── model visibility ────────────────────────────────────────────────────────

section('模型可见性')

await test('未选择时 /view 暴露完整目录且全部可见', async () => {
  const { ctx, state } = fakeCtx()
  // An explicit empty directory, so this test cannot read the developer's real
  // override file and pass or fail depending on what they last saved.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-default-'))
  apply(ctx, { overridesPath: tmp, models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler({ url: '/api/opencode-live/view', method: 'GET' }, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.visibilityChosen, false, '尚未选择时不应声称已选择')
  assert.equal(payload.catalogue.length, 2)
  assert.ok(payload.catalogue.every((m) => m.visible === true))
  assert.equal(payload.models.length, 2, '未选择时应服务全部模型')
})

await test('保存后重新读取仍生效（写入必须能读回）', async () => {
  // The bug this guards: a null override store made writes land on disk while
  // `reload()` merged an empty object, so the page saved and then showed the old
  // state. Anything written must survive a fresh read of the same directory.
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-readback-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const saved = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { visibleModels: [] }), saved)
  assert.equal(saved.statusCode, 200, saved.body)

  // A second read, as the page performs on its next load.
  const reread = newResponse()
  await handler({ url: '/api/opencode-live/view', method: 'GET' }, reread)
  const payload = JSON.parse(reread.body)
  assert.equal(payload.visibilityChosen, true, '重新读取后丢失了已保存的选择')
  assert.deepEqual(payload.models, [], '重新读取后隐藏没有生效')
})

await test('写入 visibleModels 后 roster 只剩选中的', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { visibleModels: ['b'] }), res)
  assert.equal(res.statusCode, 200, res.body)
  const payload = JSON.parse(res.body)
  assert.equal(payload.visibilityChosen, true)
  assert.deepEqual(payload.models.map((m) => m.id), ['b'], 'roster 没有收敛到选中集合')
  // The catalogue still lists everything, so hiding stays undoable.
  assert.equal(payload.catalogue.length, 2)
  assert.equal(payload.catalogue.find((m) => m.id === 'a').visible, false)
  // And it is persisted.
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.deepEqual(saved.visibleModels, ['b'])
})

await test('全部隐藏是合法的刻意状态', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis0-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'a', name: 'A' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { visibleModels: [] }), res)
  assert.equal(res.statusCode, 200, res.body)
  const payload = JSON.parse(res.body)
  assert.equal(payload.visibilityChosen, true, '空数组是"已选择"，不是"未选择"')
  assert.deepEqual(payload.models, [])
})

await test('visibleModels 过滤非字符串与空串', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis2-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'a', name: 'A' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', { visibleModels: ['a', '', 42, null] }), res)
  assert.equal(res.statusCode, 200, res.body)
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.deepEqual(saved.visibleModels, ['a'])
})

await test('adapter 的 listModels 只返回可见模型', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis3-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  await handler(newRequest('/api/opencode-live/update', 'POST', { visibleModels: ['a'] }), newResponse())
  const models = await state.adapters.get('opencode-live').listModels('opencode-live')
  assert.deepEqual(models.map((m) => m.id), ['a'], '适配器仍在服务隐藏的模型')
})

// ── vision capability ───────────────────────────────────────────────────────

section('图片能力')

/** GET a path from the mounted prefix handler and return the parsed body. */
async function readView(handler, suffix = '/view') {
  const res = newResponse()
  await handler(newRequest(`/api/opencode-live${suffix}`), res)
  assert.equal(res.statusCode, 200, res.body)
  return JSON.parse(res.body)
}

/** POST a patch and return the parsed reply. */
async function patchConfig(handler, patch) {
  const res = newResponse()
  await handler(newRequest('/api/opencode-live/update', 'POST', patch), res)
  assert.equal(res.statusCode, 200, res.body)
  return JSON.parse(res.body)
}

await test('view 报告实测与用户选择的图片能力', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis-cat-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'minimax-m3', name: 'M' }, { id: 'mystery-model', name: 'X' }],
  })
  await settle()
  const payload = await readView(state.webRoutes.get('/api/opencode-live'))

  const known = payload.catalogue.find((m) => m.id === 'minimax-m3')
  assert.equal(known.vision, true, '实测能看图的模型应默认打开')
  assert.equal(known.autoVision, true)
  assert.equal(known.visionChosen, false, '未选择时不应声称用户已选择')

  const unknown = payload.catalogue.find((m) => m.id === 'mystery-model')
  assert.equal(unknown.vision, false, '未知模型应默认纯文本而不是猜支持')
  assert.equal(unknown.autoVision, false)
})

await test('用户选择优先于实测表', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis-pick-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'minimax-m3', name: 'M' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')

  // Turn off a measured-capable model.
  let payload = await patchConfig(handler, { modelVision: { 'minimax-m3': false } })
  let entry = payload.catalogue.find((m) => m.id === 'minimax-m3')
  assert.equal(entry.vision, false, '用户关掉后应不再支持图片')
  assert.equal(entry.visionChosen, true)
  assert.equal(entry.autoVision, true, 'auto 值仍应反映实测结果')

  const models = await state.adapters.get('opencode-live').listModels('opencode-live')
  assert.deepEqual(models[0].inputModalities, ['text'], '适配器没有跟随用户选择')

  // Clearing with null falls back to the measured table rather than meaning "no".
  payload = await patchConfig(handler, { modelVision: { 'minimax-m3': null } })
  entry = payload.catalogue.find((m) => m.id === 'minimax-m3')
  assert.equal(entry.vision, true, 'null 应清除覆盖并回落实测值')
  assert.equal(entry.visionChosen, false)
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.equal(saved.modelVision?.['minimax-m3'], undefined, '保存的表里不应留下被清除的键')
})

await test('modelVision 忽略非布尔值', async () => {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-vis-bad-'))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [{ id: 'a', name: 'A' }],
  })
  await settle()
  const handler = state.webRoutes.get('/api/opencode-live')
  await patchConfig(handler, { modelVision: { a: 'yes', b: 1, c: true } })
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.deepEqual(saved.modelVision, { c: true })
})

// ── per-model settings ──────────────────────────────────────────────────────

section('模型的详细设置')

/** Fresh mount whose catalogue holds one model, for the settings tests. */
async function mountOne(prefix, overrides = {}, model = { id: 'minimax-m3', name: 'M' }) {
  const { ctx, state } = fakeCtx()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ocl-${prefix}-`))
  mount(ctx, state, {
    overridesPath: tmp,
    baseURL: 'https://127.0.0.1:1/v1',
    discoveryTimeoutMs: 150,
    models: [model],
    ...overrides,
  })
  await settle()
  return { ctx, state, tmp, handler: state.webRoutes.get('/api/opencode-live') }
}

const entryOf = (payload, id = 'minimax-m3') => payload.catalogue.find((m) => m.id === id)

await test('view 报告继承值与用户值两套容量', async () => {
  const { handler } = await mountOne('set-cap')
  const entry = entryOf(await readView(handler))
  assert.equal(entry.contextWindow, null, '未声明时不应谎报一个值')
  assert.equal(entry.maxTokens, null)
  assert.equal(entry.autoContextWindow, 204800, '应回落到配置的默认上下文窗口')
  assert.equal(entry.autoMaxTokens, 131072)
  assert.deepEqual(entry.overridden, {
    contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: false,
  })
})

await test('保存容量后适配器按用户值报告，清空后回落', async () => {
  const { state, handler } = await mountOne('set-cap2')
  let payload = await patchConfig(handler, {
    modelSettings: { 'minimax-m3': { contextWindow: 64000, maxTokens: 4096 } },
  })
  let entry = entryOf(payload)
  assert.equal(entry.contextWindow, 64000)
  assert.equal(entry.autoContextWindow, 204800, 'auto 值应保持继承值不变')
  assert.equal(entry.overridden.contextWindow, true)

  const info = await state.adapters.get('opencode-live').resolveModel('opencode-live', 'minimax-m3')
  assert.equal(info.context.contextWindow, 64000, '适配器没有采用用户容量')
  assert.equal(info.defaultMaxTokens, 4096)

  // null clears one field, leaving the other in place.
  payload = await patchConfig(handler, { modelSettings: { 'minimax-m3': { contextWindow: null } } })
  entry = entryOf(payload)
  assert.equal(entry.contextWindow, null, '清空后应回到继承')
  assert.equal(entry.maxTokens, 4096, '清一个字段不应动另一个')
  assert.equal(entry.overridden.contextWindow, false)
})

await test('整条设为 null 删掉该模型的全部覆盖', async () => {
  const { tmp, handler } = await mountOne('set-drop')
  await patchConfig(handler, {
    modelSettings: { 'minimax-m3': { contextWindow: 64000, maxTokens: 4096 } },
  })
  const payload = await patchConfig(handler, { modelSettings: { 'minimax-m3': null } })
  assert.equal(entryOf(payload).contextWindow, null)
  assert.equal(entryOf(payload).maxTokens, null)
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.deepEqual(saved.modelSettings, {}, '保存的表里不应留下整条被删的模型')
})

await test('输入类型可以覆盖实测的图片能力', async () => {
  const { state, handler } = await mountOne('set-modal')
  const before = entryOf(await readView(handler))
  assert.deepEqual(before.inputModalities, ['text', 'image'], 'minimax-m3 实测能看图')

  let payload = await patchConfig(handler, { modelSettings: { 'minimax-m3': { inputModalities: ['text'] } } })
  assert.deepEqual(entryOf(payload).inputModalities, ['text'], '用户改成纯文本后应生效')
  assert.deepEqual(entryOf(payload).autoInputModalities, ['text', 'image'], 'auto 值仍应反映实测')
  let models = await state.adapters.get('opencode-live').listModels('opencode-live')
  assert.deepEqual(models[0].inputModalities, ['text'], '适配器没有跟随 inputModalities')

  payload = await patchConfig(handler, { modelSettings: { 'minimax-m3': { inputModalities: null } } })
  assert.deepEqual(entryOf(payload).inputModalities, ['text', 'image'], '清空后应回落实测表')
  models = await state.adapters.get('opencode-live').listModels('opencode-live')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
})

await test('inputModalities 丢掉非法值后再判空', async () => {
  const { handler } = await mountOne('set-modal2')
  const payload = await patchConfig(handler, {
    modelSettings: { 'minimax-m3': { inputModalities: ['text', 'audio', '', 42] } },
  })
  assert.deepEqual(entryOf(payload).inputModalities, ['text'], '只应留下 text 与 image')
})

await test('思考档位：未声明时暴露厂商文档的档位', async () => {
  const { state, handler } = await mountOne('set-eff1')
  const entry = entryOf(await readView(handler))
  assert.equal(entry.reasoningEfforts, null, '未声明时应是 null 而不是空对象')
  assert.ok(entry.autoReasoningEfforts && typeof entry.autoReasoningEfforts === 'object')
  assert.ok(entry.autoReasoningEfforts.max !== undefined, 'minimax 应有 max 档')
  assert.match(entry.autoReasoningSource, /^platform\.minimax\.io/, '应说明档位来源')

  const info = await state.adapters.get('opencode-live').resolveModel('opencode-live', 'minimax-m3')
  assert.ok(info.reasoning?.efforts?.length >= 2, '适配器应暴露多档')
  assert.ok(info.reasoning.efforts.some((e) => e.id === 'max'))
})

await test('思考档位：声明后按用户表暴露，且值映射生效', async () => {
  const { state, handler } = await mountOne('set-eff2')
  const payload = await patchConfig(handler, {
    modelSettings: { 'minimax-m3': { reasoningEfforts: { fast: 'low', deep: 'high' } } },
  })
  const entry = entryOf(payload)
  assert.deepEqual(Object.keys(entry.reasoningEfforts), ['fast', 'deep'], '自定义档位 id 应原样保留')
  assert.deepEqual(Object.keys(entry.autoReasoningEfforts).sort(), ['high', 'low', 'max', 'medium', 'xhigh'],
    'auto 档位必须仍是厂商文档那一套，而不是把用户表回显给自己')

  const info = await state.adapters.get('opencode-live').resolveModel('opencode-live', 'minimax-m3')
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ['fast', 'deep'])
  assert.equal(info.reasoning.defaultEffort, 'fast', '第一档应作为默认')
})

await test('思考档位：null 值表示该档不发参数', async () => {
  const { tmp, handler } = await mountOne('set-eff3')
  await patchConfig(handler, {
    modelSettings: { 'minimax-m3': { reasoningEfforts: { default: null, high: 'high' } } },
  })
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.equal(saved.modelSettings['minimax-m3'].reasoningEfforts.default, null, 'null 是真实指令，不能被吞')
})

await test('思考档位：零档是合法指令（等于不暴露控制）', async () => {
  const { state, handler } = await mountOne('set-eff4')
  const payload = await patchConfig(handler, { modelSettings: { 'minimax-m3': { reasoningEfforts: {} } } })
  assert.deepEqual(entryOf(payload).reasoningEfforts, {}, '空对象应保留而不是当成未声明')
  assert.equal(entryOf(payload).overridden.reasoningEfforts, true)

  const info = await state.adapters.get('opencode-live').resolveModel('opencode-live', 'minimax-m3')
  assert.equal(info.reasoning, undefined, '零档时不应暴露思考控件')
})

await test('思考档位：只有一档时不暴露控件', async () => {
  const { state, handler } = await mountOne('set-eff5')
  await patchConfig(handler, { modelSettings: { 'minimax-m3': { reasoningEfforts: { high: 'high' } } } })
  const info = await state.adapters.get('opencode-live').resolveModel('opencode-live', 'minimax-m3')
  assert.equal(info.reasoning, undefined, '单档不是选择，不应暴露')
})

await test('modelSettings 忽略非法容量与非法档位值', async () => {
  const { tmp, handler } = await mountOne('set-bad')
  await patchConfig(handler, {
    modelSettings: {
      'minimax-m3': { contextWindow: -1, maxTokens: 'big', reasoningEfforts: { a: '', b: '  ', c: 42 } },
      'other-model': { contextWindow: 1000 },
    },
  })
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.equal(saved.modelSettings['minimax-m3'], undefined, '全是非法值时整条应被丢弃')
  assert.equal(saved.modelSettings['other-model'].contextWindow, 1000, '合法值不应被牵连')
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
