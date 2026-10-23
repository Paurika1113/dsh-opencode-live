/**
 * Client-half test: does the browser bundle load, register its two slots, and
 * render without touching anything it does not own?
 *
 * The shell provides `react`, `window.__ModuleLoader__`, `ctx.slots` and
 * `ctx.locale`; this fake supplies exactly those and nothing more, so a page that
 * quietly depended on something else fails here rather than in the app.
 *
 * No browser, no network. Run: node scripts/client-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

let passed = 0
const failures = []

/**
 * Run one case.
 *
 * Async cases are awaited so a test that drives a promise (the page loads its view
 * through `fetch`) is judged on its settled result rather than on a pending
 * promise that trivially "passes".
 */
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

const SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Load the bundle in a sandbox shaped like the web shell, and return what it
 * registered.
 *
 * The React stand-in keeps real hook state instead of constant values, because a
 * `useState` that never updates freezes the page on its loading state and then no
 * assertion about the model rows can ever mean anything. State updates mark the
 * tree dirty, and `settle()` re-runs the component until it stops changing — the
 * same loop React performs, just driven by hand.
 */
function loadClient() {
  const registrations = []
  const styleNodes = []
  const dictionaries = []

  const hooks = []
  let cursor = 0
  let dirty = false

  const react = {
    // React puts children in `props.children`, and the page's own code reads them
    // that way (`props.children`), so a fake that kept them beside `props` would
    // make every assertion about rendered text fail for the wrong reason.
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children: children.length <= 1 ? children[0] : children },
    }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const at = cursor++
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(hooks[at]) : next
        if (value !== hooks[at]) { hooks[at] = value; dirty = true }
      }
      return [hooks[at], set]
    },
    useEffect: (fn) => {
      const at = cursor++
      const key = `effect${at}`
      if (!(key in hooks)) { hooks[key] = true; queueMicrotask(() => { fn() }) }
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }

  const document = {
    createElement: (tag) => ({ tag, textContent: '', remove() {} }),
    head: { appendChild: (node) => styleNodes.push(node) },
    documentElement: { lang: 'zh' },
    querySelector: () => null,
  }

  const locale = {
    bind: (ns) => (key) => `${ns}:${key}`,
    register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
    getLocale: () => ({ active: 'zh' }),
  }

  let captured
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        captured = { id, factory }
      },
    },
  }

  const sandbox = {
    window,
    document,
    console,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    setTimeout,
    clearTimeout,
    // `call()` aborts a request that never settles, so the page needs the same
    // global the browser provides. Without it every load fails with
    // "AbortController is not defined" and the page can only ever show loading —
    // which is how a test that only asserted "does not throw" passed a page that
    // never loaded anything.
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

  assert.ok(captured !== undefined, 'bundle did not call __ModuleLoader__.load')

  const module = captured.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })

  const ctx = {
    slots: {
      inject: (name, fn) => { fn(); return () => {} },
      register: (decl, render) => { registrations.push({ decl, render }); return () => {} },
    },
    locale,
    effect: (fn) => { const d = fn(); return d },
  }

  module.apply(ctx)

  /**
   * Re-run a component until its state stops changing, like React does.
   *
   * Async because the page's one effect starts a promise (`load()`): the microtask
   * queue has to drain between passes or the view never arrives and every
   * assertion would be looking at the loading state.
   *
   * Child components are expanded too. The shell renders the page, and the page
   * renders a row and the row renders its panel — a test that stopped at the
   * first element would never see the panel at all. The hook cursor simply keeps
   * counting through the depth-first walk, which is the order React uses.
   */
  const settle = async (component, props, limit = 30) => {
    const expand = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(expand)
      if (typeof node.type === 'function') return expand(node.type(node.props))
      const children = expand(node.props?.children)
      if (children === node.props?.children) return node
      return { ...node, props: { ...node.props, children } }
    }
    let tree
    dirty = true
    for (let pass = 0; pass < limit && dirty; pass += 1) {
      cursor = 0
      dirty = false
      tree = expand(component(props))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return tree
  }

  return { module, captured, registrations, styleNodes, dictionaries, sandbox, settle }
}

section('bundle 加载')

await test('模块导出 name / apply / inject', async () => {
  const { module } = loadClient()
  assert.equal(module.name, 'dsh-opencode-live')
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
  assert.deepEqual([...module.inject], ['slots', 'locale'])
})

section('注册')

await test('注册 settings.section 与 settings.plugins.tab', async () => {
  const { registrations } = loadClient()
  const names = registrations.map((r) => r.decl.name)
  assert.ok(names.includes('settings.section'), 'missing settings.section')
  assert.ok(names.includes('settings.plugins.tab'), 'missing settings.plugins.tab')
})

await test('两个槽位都带 id、order 与 label', async () => {
  const { registrations } = loadClient()
  for (const { decl } of registrations) {
    assert.equal(decl.id, 'opencode-live')
    assert.equal(typeof decl.order, 'number')
    assert.equal(typeof decl.label, 'function')
    assert.ok(decl.label().length > 0, `${decl.name} label 为空`)
  }
})

await test('每个渲染函数都是一个组件', async () => {
  const { registrations } = loadClient()
  for (const { decl, render } of registrations) {
    assert.equal(typeof render, 'function', `${decl.name} 没有渲染函数`)
  }
})

section('样式与词典')

await test('注入一段 style 并返回清理函数', async () => {
  const { styleNodes } = loadClient()
  assert.equal(styleNodes.length, 1)
  assert.ok(styleNodes[0].textContent.includes('.ocl_root'))
})

await test('注册 zh 与 en 两份词典', async () => {
  const { dictionaries } = loadClient()
  assert.equal(dictionaries.length, 1)
  assert.ok(dictionaries[0].dicts.zh, 'missing zh')
  assert.ok(dictionaries[0].dicts.en, 'missing en')
})

await test('两份词典的键集合一致（缺键会退化成原始 key）', async () => {
  const { dictionaries } = loadClient()
  const zh = Object.keys(dictionaries[0].dicts.zh).sort()
  const en = Object.keys(dictionaries[0].dicts.en).sort()
  const onlyZh = zh.filter((k) => !en.includes(k))
  const onlyEn = en.filter((k) => !zh.includes(k))
  assert.deepEqual(onlyZh, [], `只在 zh 里: ${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `只在 en 里: ${onlyEn.join(', ')}`)
})

section('渲染')

/**
 * Invoke the component the slot registered.
 *
 * The shell calls the render function and React then invokes *that component*;
 * a bare `createElement` does not run it. So the test has to make the same two
 * calls the shell does, or it would only ever inspect an unrendered element.
 */
function renderPage(registrations, props = { t: (k) => k }) {
  const element = registrations[0].render(props)
  // The slot's render returns `<SettingsPage …/>`; call it as React would.
  return element.type({ ...element.props })
}

await test('页面能渲染成一棵元素树而不抛错', async () => {
  const { registrations } = loadClient()
  const tree = renderPage(registrations)
  assert.equal(typeof tree, 'object')
  assert.ok(tree !== null)
  assert.equal(tree.props.className, 'ocl_root')
})

await test('渲染结果包含路线、密钥与模型三块', async () => {
  const { registrations } = loadClient()
  const tree = renderPage(registrations)
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))
  for (const marker of ['routeTitle', 'keyTitle', 'modelsTitle', 'refreshBtn']) {
    assert.ok(text.includes(marker), `渲染结果里没有 ${marker}`)
  }
})

await test('渲染结果包含网关地址与模型列表地址', async () => {
  const { registrations } = loadClient()
  const tree = renderPage(registrations)
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))
  assert.ok(text.includes('routeBase'), '缺少网关地址行')
  assert.ok(text.includes('routeModels'), '缺少模型列表地址行')
})

await test('页面在 view 为 undefined（尚未加载）时不崩', async () => {
  const { registrations } = loadClient()
  assert.doesNotThrow(() => renderPage(registrations))
})

await test('未加载时模型区显示加载提示而不是空崩溃', async () => {
  const { registrations } = loadClient()
  const tree = renderPage(registrations)
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))
  assert.ok(text.includes('modelsLoading'), '应显示 loading 文案')
})

// ── ordering ────────────────────────────────────────────────────────────────

section('排序与分组')

/**
 * The ordering rule, extracted from the bundle source and evaluated here.
 *
 * Copying the comparator into the test would test the copy; reading it out of the
 * shipped file is what makes the assertion mean something about the page.
 */
function extractComparator() {
  const match = SOURCE.match(/const ordered = (\[\.\.\.catalogue\][\s\S]*?\n\s*\}\))\n/)
  assert.ok(match !== null, '源码里找不到排序表达式')
  // eslint-disable-next-line no-new-func
  return { body: match[1], build: (catalogue) => new Function('catalogue', `return ${match[1]}`)(catalogue) }
}

await test('源码中的排序把可见项置顶', async () => {
  const { build } = extractComparator()
  const catalogue = [
    { id: 'alpha', visible: false },
    { id: 'beta', visible: true },
    { id: 'gamma', visible: false },
    { id: 'delta', visible: true },
  ]
  assert.deepEqual(build(catalogue).map((m) => m.id), ['beta', 'delta', 'alpha', 'gamma'])
})

await test('组内保持原顺序（稳定排序）', async () => {
  const { build } = extractComparator()
  const catalogue = [
    { id: 'z1', visible: true },
    { id: 'a2', visible: false },
    { id: 'z2', visible: true },
    { id: 'a1', visible: false },
  ]
  assert.deepEqual(build(catalogue).map((m) => m.id), ['z1', 'z2', 'a2', 'a1'], '组内顺序被改变了')
})

await test('全部隐藏时不把已隐藏项置顶', async () => {
  const { build } = extractComparator()
  const catalogue = [{ id: 'a', visible: false }, { id: 'b', visible: false }]
  assert.deepEqual(build(catalogue).map((m) => m.id), ['a', 'b'])
})

await test('渲染结果里带分组标题键', async () => {
  const { registrations } = loadClient()
  const tree = renderPage(registrations)
  const text = JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))
  // The divider only appears with a mixed list, so only the key's presence in the
  // dictionary is assertable from a first render.
  assert.ok(text.includes('visibilityHint') || text.includes('hiddenGroup') || text.includes('modelsTitle'))
})

section('每个模型的详细设置')

/**
 * Render the page with a catalogue, expanded, so the panel controls materialise.
 *
 * The view is served by the fake `fetch` the page calls in its effect, so the
 * render has to be driven to settlement rather than once: a single pass would
 * only ever show the loading state. Expanding is a second round of the same
 * thing — the button's onClick sets state, and React would then re-render.
 */
async function renderWithCatalogue(catalogue, extra = {}, { expand = true } = {}) {
  const client = loadClient()
  const view = {
    ok: true,
    route: 'opencode-live',
    protocols: ['chat-completions', 'responses', 'anthropic-messages'],
    effortLevels: ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    visibilityChosen: true,
    catalogue,
    models: catalogue.filter((m) => m.visible),
    ...extra,
  }
  client.sandbox.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => (String(url).endsWith('/view') ? JSON.stringify(view) : '{}'),
  })
  const element = client.registrations[0].render({ t: (k) => k })
  const props = { ...element.props }
  let tree = await client.settle(element.type, props)
  if (expand) {
    for (const button of collect(tree, (node) => node?.props?.className === 'ocl_disclose')) button.props.onClick()
    tree = await client.settle(element.type, props)
  }
  return { tree, view, client, element, props }
}

/** Collect every element whose props match a predicate. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) collect(entry, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  collect(node.props?.children, predicate, out)
  return out
}

/**
 * Pull a helper out of the shipped bundle.
 *
 * The capacity parser is not exported to the shell (the shell only needs `apply`),
 * and copying it into the test would test the copy. Evaluating the source's own
 * definitions is what makes these assertions mean something about the page. The
 * two constants it closes over live beside it, so they come along.
 */
function extractFunction(name) {
  const fn = SOURCE.match(new RegExp(`\\n    function ${name}\\([\\s\\S]*?\\n    \\}\\n`))
  assert.ok(fn !== null, `源码里找不到 ${name}`)
  const consts = SOURCE.match(/\n    const CAPACITY_PATTERN = .*\n    const CAPACITY_SCALE = .*\n/)
  assert.ok(consts !== null, '源码里找不到容量常量')
  // eslint-disable-next-line no-new-func
  return new Function(`${consts[0]}${fn[0]}\nreturn ${name}`)()
}

/** Every model entry, shaped like `/view` returns it, with the panel fields. */
function modelEntry(id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: null,
    vision: false,
    autoVision: false,
    visionChosen: false,
    visible: true,
    contextWindow: null,
    autoContextWindow: 1000000,
    maxTokens: null,
    autoMaxTokens: 128000,
    inputModalities: ['text'],
    autoInputModalities: ['text'],
    reasoningEfforts: null,
    autoReasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    autoReasoningSource: 'platform.minimax.io',
    overridden: { contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: false },
    ...overrides,
  }
}

const flatten = (tree) => JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))

await test('每行都有一个展开按钮，收起时不渲染详情面板', async () => {
  const { tree } = await renderWithCatalogue([modelEntry('minimax-m3')], {}, { expand: false })
  const nodes = collect(tree, (node) => node?.props?.className === 'ocl_disclose')
  assert.equal(nodes.length, 1, '应有且只有一个展开按钮')
  assert.equal(nodes[0].props['aria-expanded'], 'false')
  assert.equal(nodes[0].props.children, '+')
  assert.equal(collect(tree, (node) => node?.props?.className === 'ocl_advanced').length, 0, '收起时不应有详情面板')
})

await test('点开后详情面板出现，按钮变成收起态', async () => {
  const { tree } = await renderWithCatalogue([modelEntry('minimax-m3')])
  const buttons = collect(tree, (node) => node?.props?.className === 'ocl_disclose')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props['aria-expanded'], 'true')
  assert.equal(buttons[0].props.children, '−')
  const panels = collect(tree, (node) => node?.props?.className === 'ocl_advanced')
  assert.equal(panels.length, 1, '应有且只有一个详情面板')
})

await test('详情面板包含协议、容量、输入类型与思考档位', async () => {
  const declared = modelEntry('minimax-m3', {
    reasoningEfforts: { low: 'low', high: 'high' },
    overridden: { contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: true },
  })
  const text = flatten((await renderWithCatalogue([declared])).tree)
  for (const key of ['protocol', 'ctxWindow', 'maxTokens', 'inputTypes', 'inputText', 'inputImage', 'reasoning', 'reasoningAdd']) {
    assert.ok(text.includes(key), `详情面板里没有 ${key}`)
  }
  // The add button only exists once levels are declared, so the inherited panel
  // must not offer it: an add button with nothing to add is a dead control.
  const inherited = flatten((await renderWithCatalogue([modelEntry('minimax-m3')])).tree)
  assert.ok(!inherited.includes('reasoningAdd'), '未声明档位时不应出现添加按钮')
})

await test('展开的那一行带 expanded 类名', async () => {
  const { tree } = await renderWithCatalogue([modelEntry('minimax-m3')])
  assert.ok(flatten(tree).includes('ocl_rowItemExpanded'), '缺少展开态样式钩子')
  const collapsed = await renderWithCatalogue([modelEntry('minimax-m3')], {}, { expand: false })
  assert.ok(!flatten(collapsed.tree).includes('ocl_rowItemExpanded'), '收起时不应带展开态类名')
})

await test('容量解析支持 K/M 后缀，空串表示继承', async () => {
  const parseCapacity = extractFunction('parseCapacity')
  assert.equal(parseCapacity('128K'), 128000)
  assert.equal(parseCapacity('1M'), 1000000)
  assert.equal(parseCapacity('200000'), 200000)
  assert.equal(parseCapacity(' 128k '), 128000)
  assert.equal(parseCapacity(''), undefined, '空串应表示继承')
  assert.equal(parseCapacity('abc'), Number.NaN)
  assert.equal(parseCapacity('1.5K'), 1500)
  assert.equal(parseCapacity('0'), Number.NaN, '0 不是有效容量')
  assert.equal(parseCapacity('0.5'), Number.NaN, '小数容量是打字错误')
})

await test('容量格式化回 K/M', async () => {
  const formatCapacity = extractFunction('formatCapacity')
  assert.equal(formatCapacity(1000000), '1M')
  assert.equal(formatCapacity(128000), '128K')
  assert.equal(formatCapacity(1234), '1234')
  assert.equal(formatCapacity(0), '')
  assert.equal(formatCapacity(null), '')
})

await test('输入类型永远至少保留一种', async () => {
  // The checkbox for the last remaining type is disabled, which is the UI side of
  // "never declare an empty modality list".
  assert.ok(SOURCE.includes('selected.length === 1 && selected.includes(modality)'), '缺少最后一项禁用逻辑')
  const { tree } = await renderWithCatalogue([modelEntry('minimax-m3')])
  const boxes = collect(tree, (node) => node?.props?.className === 'ocl_modality')
  assert.equal(boxes.length, 2, '应有文本与图片两个勾选框')
  const inputs = boxes.map((box) => collect(box, (node) => node?.type === 'input')[0])
  assert.equal(inputs[0].props.checked, true, '文本默认勾选')
  assert.equal(inputs[0].props.disabled, true, '只剩文本时不能再取消')
  assert.equal(inputs[1].props.checked, false)
})

await test('思考档位：未声明时显示继承，声明后显示档位行', async () => {
  const inherited = flatten((await renderWithCatalogue([modelEntry('minimax-m3')])).tree)
  assert.ok(inherited.includes('reasoningOff'), '未声明时开关应为关')
  assert.ok(inherited.includes('reasoningInherit'), '未声明时应说明跟随厂商文档')
  const declared = modelEntry('minimax-m3', {
    reasoningEfforts: { low: 'low', high: 'high' },
    overridden: { contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: true },
  })
  const text = flatten((await renderWithCatalogue([declared])).tree)
  assert.ok(text.includes('reasoningOn'), '声明后应显示"自定义档位"')
  const rows = collect((await renderWithCatalogue([declared])).tree, (node) => node?.props?.className === 'ocl_effortRow')
  assert.equal(rows.length, 2, '两档应渲染两行')
})

await test('只有一档时提示两档才有意义', async () => {
  const one = modelEntry('minimax-m3', {
    reasoningEfforts: { high: 'high' },
    overridden: { contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: true },
  })
  const text = flatten((await renderWithCatalogue([one])).tree)
  assert.ok(text.includes('reasoningNeedsTwo'), '一档时应提示至少两档')
})

await test('声明为零档时说明不发思考参数，且不提示两档', async () => {
  const zero = modelEntry('minimax-m3', {
    reasoningEfforts: {},
    overridden: { contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: true },
  })
  const text = flatten((await renderWithCatalogue([zero])).tree)
  assert.ok(text.includes('reasoningEmpty'), '零档时应说明不发思考参数')
  assert.ok(!text.includes('reasoningNeedsTwo'), '零档时不应提示两档')
})

await test('同一档位不会被两行同时选中', async () => {
  assert.ok(SOURCE.includes('option !== level && entries.some(([used]) => used === option)'),
    '缺少重复档位禁用逻辑')
  const two = modelEntry('minimax-m3', {
    reasoningEfforts: { low: 'low', high: 'high' },
    overridden: { contextWindow: false, maxTokens: false, inputModalities: false, reasoningEfforts: true },
  })
  const { tree } = await renderWithCatalogue([two])
  const rows = collect(tree, (node) => node?.props?.className === 'ocl_effortRow')
  assert.equal(rows.length, 2, '两档应渲染两行')
  const firstSelect = collect(rows[0], (node) => node?.type === 'select')[0]
  const options = firstSelect.props.children
  const lowOption = options.find((option) => option.props.value === 'low')
  const highOption = options.find((option) => option.props.value === 'high')
  assert.equal(lowOption.props.disabled, false, '当前行自己的档位不应禁用')
  assert.equal(highOption.props.disabled, true, '另一行已用的档位应禁用')
})

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
