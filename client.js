/**
 * dsh-opencode-live — browser half.
 *
 * Contributes one settings section that owns this route's own surface: its
 * gateway, its credential, and the live model roster with each model's measured
 * protocol. Nothing here touches the stock Models page: that page edits pi-ai
 * profiles, and this route is not one — which is exactly why it needs a page of
 * its own.
 *
 * The page answers three questions a person actually has:
 *   1. is the key set, and which reference holds it?
 *   2. which models does the gateway list *right now*, and what protocol does
 *      each one speak?
 *   3. when a refresh fails, why?
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-live',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect } = React

    const NS = 'settings.opencodeLive'
    const inject = ['slots', 'locale']
    const API = '/api/opencode-live'

    // ── copy ──────────────────────────────────────────────────────────────────

    const DICT = {
      zh: {
        nav: 'OpenCode 实时目录',
        title: 'OpenCode 实时目录',
        subtitle: '这条路由的模型清单来自网关的实时列表，不是安装包里的快照',
        whyTitle: '为什么需要它',
        whyBody: '官方 opencode-go 路由的「获取可用模型」直接返回 pi-ai 包内的构建期快照，不发网络请求，所以网关上线的新模型永远看不到。这条路由自己拉 /v1/models，线路协议则由你在下面逐行选择。',
        routeTitle: '这条路由',
        routeId: '路由 ID',
        routeName: '显示名',
        routeBase: '网关地址',
        routeModels: '模型列表地址',
        routeChat: '对话地址',
        nameHint: '选择器里显示的名字',
        baseHint: '填到 /v1 或完整端点都会自动归一化为前缀',
        keyTitle: 'API Key',
        keySet: '已配置',
        keyUnset: '未配置',
        keyRef: '凭据引用',
        keyPlaceholder: '粘贴密钥；留空表示不改动',
        keyHint: '密钥只写入凭据库，不会出现在这个页面的响应里，也不会写进覆盖文件。',
        keyClear: '清除已存密钥',
        modelsTitle: '模型',
        modelsCount: '共 {n} 个',
        modelsLoading: '正在读取…',
        modelsEmpty: '网关没有列出任何模型',
        refreshTitle: '刷新',
        refreshHint: '只重新拉取网关的模型列表，不探测协议，所以很快。',
        refreshBtn: '刷新模型列表',
        refreshing: '刷新中…',
        lastRefresh: '上次刷新',
        never: '尚未刷新',
        capacitySource: '容量来源',
        capacityNetwork: '官方目录（已联网获取）',
        capacityCache: '官方目录（本地缓存）',
        capacityNone: '离线快照（无法访问目录）',
        capacityHint: '上下文与输出上限取自 models.dev 的官方目录，而不是插件里写死的数字。',
        protocol: '协议',
        protocolHint: '每个模型的线路协议由你选择，选中即保存。不选则默认 chat-completions。',
        protocolDefault: '默认（chat-completions）',
        protocolSaved: '协议已保存',
        vision: '图片',
        visionHint: '该模型是否接受图片输入。网关的模型列表不含任何模态字段，所以这里只列出实测能看图的模型；你的选择优先于实测结果。',
        visionAutoOn: '自动（实测：支持）',
        visionAutoOff: '自动（实测：不支持）',
        visionYes: '支持图片',
        visionNo: '仅文本',
        visionSaved: '图片能力已保存',
        chosen: '已选择',
        notChosen: '默认',
        hidden: '已隐藏',
        hiddenGroup: '未显示的模型',
        visibilitySaved: '显示设置已保存',
        visibleCount: '显示 {n} / {total}',
        showAll: '全部显示',
        hideAll: '全部隐藏',
        visibilityHint: '勾选决定这个模型是否出现在模型选择器里。列表始终显示网关的完整目录，取消勾选只是隐藏，不影响其他设置。',
        edit: '编辑',
        cancel: '取消',
        save: '保存',
        saving: '保存中…',
        reset: '恢复默认',
        test: '测试连接',
        testing: '测试中…',
        loading: '正在读取…',
        absent: '插件未加载',
        ready: '已就绪',
        saved: '已保存',
        resetDone: '已清除覆盖配置',
        keySaved: '密钥已写入凭据库',
        err: '失败',
        search: '搜索模型 ID',
        noMatch: '没有匹配的模型',
        autoRefresh: '自动刷新（分钟，0 关闭）',
        storeHint: '覆盖配置写在 {path}，也可以直接手改，下一回合生效。',
        liveHint: '保存后无需重启：下一个请求就用新的地址与密钥。',

        // ── 每个模型的详细设置 ──────────────────────────────────────────────
        advanced: '详细设置',
        advancedSaved: '详细设置已保存',
        advancedHint: '协议、容量、输入类型与思考档位都按模型单独保存；留空表示跟随默认。',
        ctxWindow: '上下文窗口',
        maxTokens: '最大输出 token',
        capacityHint: '支持 128K / 1M 这种写法；留空则跟随默认',
        capacityBad: '请填正整数，或像 128K / 1M 这样带单位的数',
        inherited: '继承（当前 {value}）',
        inheritedShort: '继承',
        inputTypes: '输入类型',
        inputText: '文本',
        inputImage: '图片',
        inputHint: '至少保留一种。标了图片但模型其实不支持时，带图的请求会被网关拒绝。',
        reasoning: '思考档位',
        reasoningHint: '每行是「档位 → 请求里真正发的值」。值留空表示不发这个参数。',
        reasoningInherit: '跟随厂商文档：{names}',
        reasoningInheritNone: '该模型没有查到厂商档位',
        reasoningEmpty: '已声明为不使用档位（不发任何思考参数）',
        reasoningOn: '自定义档位',
        reasoningOff: '不使用档位',
        reasoningLevel: '档位',
        reasoningValue: 'API 参数值',
        reasoningValueHint: '留空 = 不发这个参数',
        reasoningAdd: '添加档位',
        reasoningRemove: '删除',
        reasoningSource: '来源：{source}',
        reasoningNeedsTwo: '至少两档才有意义；只留一档等于不暴露选择。',
        resetField: '恢复继承',
        lastOne: '至少保留一种输入类型',
        custom: '自定义',

        // ── Zen 免费模型车道 ──────────────────────────────────────────────
        zenTitle: 'OpenCode Zen 免费模型车道',
        zenSubtitle: '基于 OpenCode Zen 免密公共池，无需付费 Key 即可使用官方限免模型',
        zenEnable: '启用此车道',
        zenRouteId: '独立路由 ID',
        zenRouteName: '显示名',
        zenRouteBase: '端点',
        zenKey: '认证 Key（留空默认 public）',
        zenRefreshBtn: '刷新免费模型',
        zenModelsTitle: 'Zen 免费模型',
        zenModelsCount: '共 {n} 个免费模型',
        zenNotice: '已注入官方 CLI 门禁指纹与工具桩，规避 403 频控与 FreeTierError。',
      },
      en: {
        nav: 'OpenCode Live Catalog',
        title: 'OpenCode Live Catalog',
        subtitle: 'This route\'s roster is the gateway\'s live listing, not the snapshot in the installed package',
        whyTitle: 'Why this exists',
        whyBody: 'The official opencode-go route answers "fetch available models" straight from the build-time snapshot inside the pi-ai package, without a network call — so a model the gateway started serving can never appear. This route reads /v1/models itself, and you pick each model\'s wire protocol below.',
        routeTitle: 'This route',
        routeId: 'Route id',
        routeName: 'Display name',
        routeBase: 'Gateway',
        routeModels: 'Model listing URL',
        routeChat: 'Chat URL',
        nameHint: 'the name shown in the picker',
        baseHint: 'A /v1 base or a full endpoint both normalize to a prefix',
        keyTitle: 'API key',
        keySet: 'configured',
        keyUnset: 'not set',
        keyRef: 'Stored under',
        keyPlaceholder: 'Paste a key; blank leaves it unchanged',
        keyHint: 'The key goes only to the credential store — never into this page\'s response, never into the override file.',
        keyClear: 'Clear the stored key',
        modelsTitle: 'Models',
        modelsCount: '{n} total',
        modelsLoading: 'Reading…',
        modelsEmpty: 'The gateway lists no models',
        refreshTitle: 'Refresh',
        refreshHint: 'Re-reads the gateway listing only — no protocol probing, so it is fast.',
        refreshBtn: 'Refresh models',
        refreshing: 'Refreshing…',
        lastRefresh: 'Last refresh',
        never: 'never refreshed',
        capacitySource: 'Capacity source',
        capacityNetwork: 'Official catalogue (fetched)',
        capacityCache: 'Official catalogue (local cache)',
        capacityNone: 'Offline snapshot (catalogue unreachable)',
        capacityHint: 'Context and output limits come from the official models.dev catalogue, not from numbers hard-coded in this plugin.',
        protocol: 'Protocol',
        protocolHint: 'Pick the wire protocol per model; the choice saves immediately. Unchosen models use chat-completions.',
        protocolDefault: 'default (chat-completions)',
        protocolSaved: 'Protocol saved',
        vision: 'Images',
        visionHint: 'Whether this model accepts image input. The gateway listing carries no modality field, so only models measured to read images are listed here by default; your choice overrides the measurement.',
        visionAutoOn: 'auto (measured: yes)',
        visionAutoOff: 'auto (measured: no)',
        visionYes: 'accepts images',
        visionNo: 'text only',
        visionSaved: 'Image support saved',
        chosen: 'chosen',
        notChosen: 'default',
        hidden: 'hidden',
        hiddenGroup: 'not shown',
        visibilitySaved: 'Visibility saved',
        visibleCount: 'showing {n} / {total}',
        showAll: 'Show all',
        hideAll: 'Hide all',
        visibilityHint: 'The checkbox decides whether a model appears in the picker. The list always shows the gateway\'s full catalogue; unchecking only hides it.',
        edit: 'Edit',
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Restore defaults',
        test: 'Test connection',
        testing: 'Testing…',
        loading: 'Reading…',
        absent: 'Plugin not loaded',
        ready: 'Ready',
        saved: 'Saved',
        resetDone: 'Overrides cleared',
        keySaved: 'Key stored in the credential store',
        err: 'Failed',
        search: 'Search model id',
        noMatch: 'No matching model',
        autoRefresh: 'Auto refresh (minutes, 0 off)',
        storeHint: 'Overrides live in {path}; edit that file by hand and the next turn picks it up.',
        liveHint: 'No restart: the next request uses the new address and key.',

        // ── per-model advanced panel ────────────────────────────────────────
        advanced: 'Advanced',
        advancedSaved: 'Advanced settings saved',
        advancedHint: 'Protocol, capacity, input types and thinking levels are stored per model; blank means inherited.',
        ctxWindow: 'Context window',
        maxTokens: 'Max output tokens',
        capacityHint: 'Accepts 128K / 1M; blank follows the default',
        capacityBad: 'Use a whole number, or one with a K/M suffix like 128K',
        inherited: 'inherited (now {value})',
        inheritedShort: 'inherited',
        inputTypes: 'Input types',
        inputText: 'Text',
        inputImage: 'Images',
        inputHint: 'Keep at least one. Marking images on a model that cannot read them makes the gateway reject the request.',
        reasoning: 'Thinking levels',
        reasoningHint: 'Each row is "level → the value actually sent". An empty value sends no parameter.',
        reasoningInherit: 'Following the vendor docs: {names}',
        reasoningInheritNone: 'No documented levels for this model',
        reasoningEmpty: 'Declared as using no levels (sends no thinking parameter)',
        reasoningOn: 'Custom levels',
        reasoningOff: 'No levels',
        reasoningLevel: 'Level',
        reasoningValue: 'API value',
        reasoningValueHint: 'blank = send nothing',
        reasoningAdd: 'Add level',
        reasoningRemove: 'Remove',
        reasoningSource: 'Source: {source}',
        reasoningNeedsTwo: 'Two levels at minimum; a single rung exposes no choice.',
        resetField: 'Use inherited',
        lastOne: 'Keep at least one input type',
        custom: 'custom',

        // ── Zen Free Lane ──────────────────────────────────────────────
        zenTitle: 'OpenCode Zen Free Models',
        zenSubtitle: 'Use official free-tier models via OpenCode public pool without a paid key',
        zenEnable: 'Enable this lane',
        zenRouteId: 'Route id',
        zenRouteName: 'Display name',
        zenRouteBase: 'Endpoint',
        zenKey: 'Auth Key (defaults to public)',
        zenRefreshBtn: 'Refresh free models',
        zenModelsTitle: 'Zen Free Models',
        zenModelsCount: '{n} free models',
        zenNotice: 'Injected with official CLI gate fingerprints and tool stubs to avoid 403 errors.',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────

    const CSS = `
      .ocl_root { display: flex; flex-direction: column; gap: 14px; max-width: 860px; }
      .ocl_hero { display: flex; flex-direction: column; gap: 4px; }
      .ocl_heroTitle { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ocl_heroSub { font-size: 13px; color: var(--dsw-alias-label-tertiary); }
      .ocl_card { border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .ocl_cardTitle { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 8px; }
      .ocl_body { margin: 0; font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
      .ocl_note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
      .ocl_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .ocl_grid { display: grid; grid-template-columns: 150px 1fr; gap: 8px 14px; align-items: center; }
      .ocl_key { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .ocl_val { font-size: 13px; color: var(--dsw-alias-label-primary); word-break: break-all; font-family: var(--ds-font-family-code); }
      .ocl_input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; font: inherit; font-size: 13px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); }
      .ocl_input:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
      .ocl_btn { box-sizing: border-box; height: 30px; padding: 0 12px; font: inherit; font-size: 13px; cursor: pointer;
        color: var(--dsw-alias-label-primary); background: transparent;
        border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); }
      .ocl_btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .ocl_btn:disabled { opacity: 0.4; cursor: default; }
      .ocl_btnPrimary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
      .ocl_btnDanger { color: var(--dsw-alias-state-error-primary); }
      .ocl_pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 8px;
        border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
      .ocl_dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
      .ocl_dotBad { background: var(--dsw-alias-state-error-primary); }
      .ocl_dotIdle { background: var(--dsw-alias-label-dimmed); }
      .ocl_err { color: var(--dsw-alias-state-error-primary); }
      .ocl_ok { color: var(--dsw-alias-state-success-primary); }
      .ocl_list { display: flex; flex-direction: column; gap: 1px; max-height: 340px; overflow-y: auto;
        border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); }
      .ocl_rowItem { display: flex; flex-direction: column; font-size: 12.5px; }
      .ocl_rowItemHidden { opacity: 0.45; }
      .ocl_rowTight { padding: 0 2px; justify-content: flex-end; }
      .ocl_check { display: inline-flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; flex: 1 1 auto; }
      .ocl_check input { cursor: pointer; flex: none; }
      .ocl_count { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-right: auto; }
      .ocl_divider { padding: 10px 10px 4px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--dsw-alias-label-dimmed); border-top: 0.5px solid var(--dsw-alias-border-l4); margin-top: 2px; }
      .ocl_rowItem:nth-child(odd) { background: var(--dsw-alias-bg-module-platform); }
      .ocl_rowId { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-primary); word-break: break-all; }
      .ocl_tag { font-size: 11px; padding: 1px 6px; border-radius: var(--dsw-radius-xs); flex: none;
        border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
      .ocl_tagOk { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .ocl_tagBad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .ocl_tagWarn { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-label); }
      .ocl_empty { padding: 14px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-tertiary); }
      .ocl_select { box-sizing: border-box; height: 28px; padding: 0 24px 0 8px; font: inherit; font-size: 12px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
        appearance: none; cursor: pointer; flex: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-position: right 8px center; background-repeat: no-repeat; }
      .ocl_select:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
      .ocl_select:disabled { opacity: 0.5; cursor: default; }

      /* ── the per-model advanced panel ─────────────────────────────────── */
      .ocl_rowMain { display: flex; align-items: center; gap: 10px; padding: 6px 10px; width: 100%; box-sizing: border-box; }
      .ocl_rowItemExpanded { background: var(--dsw-alias-bg-layer-1); }
      .ocl_disclose { box-sizing: border-box; width: 24px; height: 24px; padding: 0; font: inherit; font-size: 11px; flex: none;
        line-height: 1; cursor: pointer; color: var(--dsw-alias-label-tertiary); background: transparent;
        border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
      .ocl_disclose:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary); }
      .ocl_disclose:disabled { opacity: 0.4; cursor: default; }
      .ocl_advanced { display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 14px;
        border-top: 0.5px dashed var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-module-platform); }
      .ocl_field { display: flex; flex-direction: column; gap: 5px; }
      .ocl_fieldSelect { max-width: 280px; }
      .ocl_label { font-size: 11.5px; letter-spacing: 0.02em; color: var(--dsw-alias-label-tertiary); }
      .ocl_labelRow { display: flex; align-items: center; gap: 8px; }
      .ocl_capacityRow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .ocl_legacy { font-size: 11px; color: var(--dsw-alias-label-dimmed); }
      .ocl_inputSm { box-sizing: border-box; width: 100%; height: 28px; padding: 0 8px; font: inherit; font-size: 12.5px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); }
      .ocl_inputSm:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
      .ocl_inputSm:disabled { opacity: 0.5; cursor: default; }
      .ocl_inputBad { border-color: var(--dsw-alias-state-error-primary); }
      .ocl_modalities { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      .ocl_modality { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
        color: var(--dsw-alias-label-primary); cursor: pointer; }
      .ocl_modality input { cursor: pointer; }
      .ocl_modality input:disabled + span { color: var(--dsw-alias-label-dimmed); }
      .ocl_effortHead { display: flex; align-items: center; gap: 10px; }
      .ocl_switch { display: inline-flex; align-items: center; }
      .ocl_switch input { cursor: pointer; }
      .ocl_effortRows { display: flex; flex-direction: column; gap: 6px; }
      .ocl_effortRow { display: grid; grid-template-columns: 150px 1fr auto; gap: 8px; align-items: center; }
      .ocl_effortRow .ocl_select { height: 28px; }
      .ocl_mini { box-sizing: border-box; height: 26px; padding: 0 8px; font: inherit; font-size: 12px;
        cursor: pointer; color: var(--dsw-alias-state-error-primary); background: transparent;
        border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
      .ocl_mini:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .ocl_mini:disabled { opacity: 0.35; cursor: default; }
    `

    // ── data ──────────────────────────────────────────────────────────────────

    /**
     * Parse a capacity field the way the official editor does.
     *
     * `1M` / `128K` / `200000` all appear in vendor docs, so a plain number input
     * would make a person convert them by hand and get it wrong. An empty string
     * means "inherit", and anything unparseable returns NaN so the caller can mark
     * the field instead of silently sending garbage.
     */
    const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)\s*([km])?$/i
    const CAPACITY_SCALE = { k: 1e3, m: 1e6 }

    function parseCapacity(text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return undefined
      const match = CAPACITY_PATTERN.exec(trimmed)
      if (match === null) return Number.NaN
      const value = Number(match[1]) * (CAPACITY_SCALE[(match[2] ?? '').toLowerCase()] ?? 1)
      // The capacity reaches a token budget, so a fraction is a typo rather than a
      // value worth keeping.
      return Number.isInteger(value) && value > 0 ? value : Number.NaN
    }

    function formatCapacity(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`
      if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`
      return String(value)
    }

    /**
     * One model's advanced panel: capacity, input types, thinking levels.
     *
     * Defined at module scope so its identity is stable across re-renders — a
     * component declared inside the page would be a new function on every render,
     * and React would remount it, losing the half-typed capacity on each keystroke.
     *
     * Every field saves on its own, immediately, like the protocol picker: the
     * official editor works one model at a time, and a page-level save button would
     * either save 37 rows at once or need its own dirty tracking.
     */
    function AdvancedPanel({ model, t, saving, onSave, onProtocol, choices, levels }) {
      // The capacity fields are the only ones that hold text while typing: "128K"
      // is not a number until the suffix is parsed, so committing on every keystroke
      // would either reject the intermediate "128" or save a value the user is still
      // editing.
      const [draft, setDraft] = useState(() => ({
        contextWindow: model.overridden?.contextWindow ? formatCapacity(model.contextWindow) : '',
        maxTokens: model.overridden?.maxTokens ? formatCapacity(model.maxTokens) : '',
      }))
      const [badField, setBadField] = useState('')

      const commitCapacity = (field) => {
        const parsed = parseCapacity(draft[field])
        if (Number.isNaN(parsed)) {
          setBadField(field)
          return
        }
        setBadField('')
        // An empty box is a deliberate "inherit", which the server spells as null.
        void onSave(model.id, field, parsed === undefined ? null : parsed)
      }

      const capacityField = (field, label) => h('div', { className: 'ocl_field' },
        h('span', { className: 'ocl_label' }, label),
        h('input', {
          className: `ocl_inputSm ${badField === field ? 'ocl_inputBad' : ''}`,
          value: draft[field],
          disabled: saving === `${model.id}#${field}`,
          placeholder: formatCapacity(model[field === 'contextWindow' ? 'autoContextWindow' : 'autoMaxTokens']),
          title: t('capacityHint'),
          onChange: (e) => setDraft((current) => ({ ...current, [field]: e.target.value })),
          onBlur: () => commitCapacity(field),
          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
        }),
        badField === field ? h('span', { className: 'ocl_legacy ocl_err' }, t('capacityBad')) : null,
      )

      // ── input types ───────────────────────────────────────────────────────
      const selected = Array.isArray(model.inputModalities) && model.inputModalities.length > 0
        ? model.inputModalities
        : ['text']

      const toggleModality = (modality) => {
        const next = selected.includes(modality)
          ? selected.filter((entry) => entry !== modality)
          // `text` always stays, so a model is never declared image-only.
          : [...selected, modality]
        if (next.length === 0) return
        void onSave(model.id, 'inputModalities', next)
      }

      const modalityBox = (modality, label) => h('label', { className: 'ocl_modality' },
        h('input', {
          type: 'checkbox',
          checked: selected.includes(modality),
          // The last remaining type cannot be unchecked: an empty list would make the
          // adapter advertise no input at all, which every gateway rejects.
          disabled: saving === `${model.id}#inputModalities` || (selected.length === 1 && selected.includes(modality)),
          onChange: () => toggleModality(modality),
        }),
        h('span', null, label),
      )

      // ── thinking levels ───────────────────────────────────────────────────
      const declared = model.reasoningEfforts
      const isDeclared = declared !== null && declared !== undefined
      const inherited = model.autoReasoningEfforts
      const active = isDeclared ? declared : (inherited ?? {})
      const entries = Object.entries(active)
      // Every level the picker offers, plus any level this model uniquely names, so
      // an inherited custom ladder round-trips instead of being silently renamed.
      const levelOptions = [...new Set([...(levels ?? []), ...entries.map(([level]) => level)])]
      const available = levelOptions.filter((level) => !entries.some(([used]) => used === level))

      const commitEfforts = (record) => {
        void onSave(model.id, 'reasoningEfforts', Object.keys(record).length === 0 ? {} : record)
      }

      const setEntry = (index, level, value) => {
        const next = {}
        entries.forEach(([used, wire], position) => {
          if (position === index) next[level] = value
          else next[used] = wire
        })
        commitEfforts(next)
      }

      const removeEntry = (index) => {
        const next = {}
        entries.forEach(([used, wire], position) => { if (position !== index) next[used] = wire })
        commitEfforts(next)
      }

      const addEntry = () => {
        const free = available[0]
        if (free === undefined) return
        // Seeded with the value the vendor documents for that level, so adding a
        // rung is one click rather than a click plus knowing the wire spelling.
        const seeded = (inherited ?? {})[free] ?? defaultWire(free)
        commitEfforts({ ...active, [free]: seeded })
      }

      const toggleDeclared = (on) => {
        if (!on) {
          void onSave(model.id, 'reasoningEfforts', null)
          return
        }
        // Turning it on starts from whatever the model already resolves to, so the
        // panel shows the documented ladder as editable rows rather than empty.
        const seed = Object.keys(inherited ?? {}).length > 0
          ? { ...inherited }
          : { low: 'low', high: 'high' }
        commitEfforts(seed)
      }

      const inheritedText = inherited === null || Object.keys(inherited).length === 0
        ? t('reasoningInheritNone')
        : t('reasoningInherit', { names: Object.keys(inherited).join(' / ') })

      return h('div', { className: 'ocl_advanced' },
        h('p', { className: 'ocl_note' }, t('advancedHint')),

        h('div', { className: 'ocl_field ocl_fieldSelect' },
          h('span', { className: 'ocl_label' }, t('protocol')),
          h('select', {
            className: 'ocl_select',
            value: model.protocol ?? '',
            disabled: saving === model.id,
            title: t('protocolHint'),
            onChange: (e) => { onProtocol?.(model.id, e.target.value) },
          },
          h('option', { value: '' }, t('protocolDefault')),
          ...(choices ?? []).map((choice) => h('option', { value: choice, key: choice }, choice)),
          ),
          h('span', { className: 'ocl_legacy' }, t('protocolHint')),
        ),

        h('div', { className: 'ocl_capacityRow' },
          capacityField('contextWindow', t('ctxWindow')),
          capacityField('maxTokens', t('maxTokens')),
        ),

        h('div', { className: 'ocl_field' },
          h('span', { className: 'ocl_label' }, t('inputTypes')),
          h('div', { className: 'ocl_modalities' },
            modalityBox('text', t('inputText')),
            modalityBox('image', t('inputImage')),
          ),
          h('span', { className: 'ocl_legacy' }, t('inputHint')),
        ),

        h('div', { className: 'ocl_field' },
          h('div', { className: 'ocl_labelRow' },
            h('label', { className: 'ocl_switch' },
              h('input', {
                type: 'checkbox',
                checked: isDeclared,
                disabled: saving === `${model.id}#reasoningEfforts`,
                onChange: (e) => toggleDeclared(e.target.checked),
              }),
            ),
            h('span', { className: 'ocl_label' }, `${t('reasoning')} · ${isDeclared ? t('reasoningOn') : t('reasoningOff')}`),
          ),
          isDeclared
            ? h('span', { className: 'ocl_legacy' }, t('reasoningHint'))
            : h('span', { className: 'ocl_legacy' }, inheritedText),
          isDeclared && model.autoReasoningSource
            ? h('span', { className: 'ocl_legacy' }, t('reasoningSource', { source: model.autoReasoningSource }))
            : null,
          isDeclared
            ? h('div', { className: 'ocl_effortRows' }, entries.length === 0
              ? h('span', { className: 'ocl_legacy' }, t('reasoningEmpty'))
              : entries.map(([level, wire], index) => h('div', { className: 'ocl_effortRow', key: `${level}-${index}` },
                h('select', {
                  className: 'ocl_select',
                  value: level,
                  disabled: saving === `${model.id}#reasoningEfforts`,
                  title: t('reasoningLevel'),
                  onChange: (e) => setEntry(index, e.target.value, wire),
                }, levelOptions.map((option) => h('option', {
                  value: option,
                  key: option,
                  // A level another row already uses cannot be picked again: two rows
                  // for one level would collapse into one key on save.
                  disabled: option !== level && entries.some(([used]) => used === option),
                }, option))),
                h('input', {
                  className: 'ocl_inputSm',
                  value: wire ?? '',
                  disabled: saving === `${model.id}#reasoningEfforts`,
                  placeholder: t('reasoningValueHint'),
                  title: t('reasoningValue'),
                  onChange: (e) => setEntry(index, level, e.target.value),
                }),
                h('button', {
                  className: 'ocl_mini',
                  disabled: saving === `${model.id}#reasoningEfforts`,
                  title: t('reasoningRemove'),
                  onClick: () => removeEntry(index),
                }, '×'),
              )))
            : null,
          isDeclared
            ? h('div', { className: 'ocl_row' },
              h('button', {
                className: 'ocl_btn',
                disabled: saving === `${model.id}#reasoningEfforts` || available.length === 0,
                onClick: addEntry,
              }, t('reasoningAdd')),
              entries.length > 0 && entries.length < 2
                ? h('span', { className: 'ocl_legacy' }, t('reasoningNeedsTwo'))
                : null,
            )
            : null,
        ),
      )
    }

    /**
     * The value a level sends when nobody has said otherwise.
     *
     * Mirrors `defaultWireFor` in `lib/effort.js` for the one case that matters here:
     * our `off` sends nothing, so it previews as an empty box rather than as "off",
     * which is a value only the OpenAI family accepts.
     */
    function defaultWire(level) {
      return level === 'off' ? null : level
    }

    async function call(path, options) {
      // A request that never settles would leave the page on "reading…" forever
      // with every control disabled — indistinguishable from a broken plugin. A
      // bounded wait turns that into a message naming the endpoint.
      const timeout = options?.timeoutMs ?? 20000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const res = await fetch(`${API}${path}`, {
          headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
          method: options?.method ?? 'GET',
          ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        })
        const text = await res.text()
        let payload
        try { payload = text === '' ? undefined : JSON.parse(text) }
        catch { throw new Error(text.slice(0, 200)) }
        if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`)
        return payload
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error(`${API}${path} 在 ${timeout}ms 内没有响应`)
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    // ── page ──────────────────────────────────────────────────────────────────

    function SettingsPage(props) {
      const { t } = props
      const [view, setView] = useState(undefined)
      const [failure, setFailure] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState({})
      const [query, setQuery] = useState('')
      const [saving, setSaving] = useState('')
      // Which model rows are expanded. A Set rather than one "open row" id: the
      // official page lets several stay open, and comparing two models' ladders is
      // exactly the moment a person wants that.
      const [expanded, setExpanded] = useState(() => new Set())

      const load = async () => {
        try {
          setView(await call('/view'))
          setFailure('')
        } catch (error) {
          setView(null)
          setFailure(String(error?.message ?? error))
        }
      }

      useEffect(() => { void load() }, [])

      const edit = (key, value) => setDraft(current => ({ ...current, [key]: value }))
      const value = key => (key in draft ? draft[key] : view?.[key])

      const save = async () => {
        setBusy('save')
        setFailure('')
        setNotice('')
        try {
          const patch = { ...draft }
          const next = await call('/update', { method: 'POST', body: patch })
          setView(next)
          setEditing(false)
          setDraft({})
          setNotice(patch.apiKey ? t('keySaved') : t('saved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setBusy('') }
      }

      const reset = async () => {
        setBusy('reset')
        setFailure('')
        setNotice('')
        try {
          setView(await call('/reset', { method: 'POST' }))
          setNotice(t('resetDone'))
          setEditing(false)
          setDraft({})
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setBusy('') }
      }

      const refresh = async () => {
        setBusy('refresh')
        setFailure('')
        setNotice('')
        try {
          const report = await call('/refresh', { method: 'POST' })
          if (report.view) setView(report.view)
          if (report.ok === false) setFailure(report.message)
          else setNotice(report.message)
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setBusy('') }
      }

      const test = async () => {
        setBusy('test')
        setFailure('')
        setNotice('')
        try {
          const result = await call('/probe', { method: 'POST', body: { model: view?.models?.[0]?.id } })
          if (result.ok) setNotice(`${t('test')}: ${result.message}`)
          else setFailure(`${t('err')}: ${result.message}`)
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setBusy('') }
      }

      const field = (label, node) => h(React.Fragment, null,
        h('span', { className: 'ocl_key' }, label),
        node,
      )

      /**
       * Why the page cannot be edited right now, or null when it can.
       *
       * A disabled Edit button with no explanation is the worst possible state:
       * it looks like a broken page rather than like "the view has not arrived".
       * This renders the distinction, and names the likely cause when the fetch
       * itself failed.
       */
      const blockedReason = () => {
        if (view === undefined) return t('loading')
        if (view === null) {
          return failure !== '' ? `${t('absent')}: ${failure}` : t('absent')
        }
        return null
      }

      const shownValue = key => {
        if (view === undefined || view === null) return '—'
        return String(view[key] ?? '—')
      }

      const editableField = (key, label, placeholder) => field(label,
        editing
          ? h('input', {
            className: 'ocl_input',
            value: value(key) ?? '',
            placeholder,
            onChange: e => edit(key, e.target.value),
          })
          : h('span', { className: 'ocl_val' }, shownValue(key)),
      )

      const keyRow = () => field(t('keyTitle'),
        h('div', { className: 'ocl_row' },
          h('span', { className: 'ocl_pill' },
            h('span', { className: `ocl_dot ${view?.credential?.configured ? '' : 'ocl_dotBad'}` }),
            view?.credential?.configured ? t('keySet') : t('keyUnset')),
          h('span', { className: 'ocl_val' }, (view?.credential?.refs ?? []).join('  →  ') || '—'),
          editing
            ? h('button', {
              className: 'ocl_btn ocl_btnDanger',
              onClick: () => edit('apiKey', ''),
            }, t('keyClear'))
            : null,
        ),
      )

      /**
       * Remember one model's dialect.
       *
       * Saved immediately on change rather than through the page's edit mode: the
       * choice is one field per model, and making a user enter edit mode, change a
       * dropdown and press save — for each of 37 rows — would be a worse surface
       * than the problem it describes.
       */
      const chooseProtocol = async (modelId, dialect) => {
        // `null`, not omitted: the server merges the table, so a missing key would
        // read as "no change" and the choice could never be cleared.
        const pick = dialect === '' ? null : dialect
        setSaving(modelId)
        setFailure('')
        setNotice('')
        try {
          const patch = { modelProtocols: { [modelId]: pick } }
          const next = await call('/update', { method: 'POST', body: patch })
          setView(next)
          setNotice(t('protocolSaved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setSaving('') }
      }

      /**
       * Set whether one model accepts images.
       *
       * Three states, because "no opinion" is a real answer: the gateway's listing has
       * no modality field, so the fallback is a table of measured models, and a user
       * who has not looked should leave the row on `auto` rather than assert either
       * way.
       */
      const chooseVision = async (modelId, choice) => {
        const value = choice === '' ? null : choice === 'yes'
        setSaving(`${modelId}#vision`)
        setFailure('')
        setNotice('')
        try {
          const next = await call('/update', { method: 'POST', body: { modelVision: { [modelId]: value } } })
          setView(next)
          setNotice(t('visionSaved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setSaving('') }
      }

      /**
       * Show or hide one model.
       *
       * Saving immediately, for the same reason the protocol picker does: a
       * checklist behind an edit mode would need a save button per row's worth of
       * intent, and the intent is already unambiguous on click.
       *
       * The full catalogue is sent as the next visibility list, because the server
       * stores what it is given — a partial list would hide everything the page did
       * not mention.
       */
      const toggleVisible = async (modelId, visible) => {
        const catalogue = view?.catalogue ?? []
        const current = view?.visibilityChosen === true
          ? new Set(catalogue.filter(m => m.visible).map(m => m.id))
          : new Set(catalogue.map(m => m.id))
        if (visible) current.add(modelId)
        else current.delete(modelId)
        setSaving(modelId)
        setFailure('')
        setNotice('')
        try {
          const next = await call('/update', { method: 'POST', body: { visibleModels: [...current] } })
          setView(next)
          setNotice(t('visibilitySaved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setSaving('') }
      }

      /** Zen 免费模型车道的专属操作 */
      const refreshZen = async () => {
        setBusy('refreshZen')
        setFailure('')
        setNotice('')
        try {
          const res = await call('/refresh-zen', { method: 'POST' })
          if (res?.view) setView(res.view)
          setNotice(res?.message ?? t('ready'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setBusy('') }
      }

      const toggleZenEnabled = async (enabled) => {
        setSaving('zen#enabled')
        setFailure('')
        setNotice('')
        try {
          const next = await call('/update', { method: 'POST', body: { zen: { enabled } } })
          setView(next)
          setNotice(t('saved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setSaving('') }
      }

      const toggleZenVisible = async (modelId, visible) => {
        const catalogue = view?.zen?.catalogue ?? []
        const current = view?.zen?.visibilityChosen === true
          ? new Set(catalogue.filter(m => m.visible).map(m => m.id))
          : new Set(catalogue.map(m => m.id))
        if (visible) current.add(modelId)
        else current.delete(modelId)
        setSaving(`zen#${modelId}`)
        setFailure('')
        setNotice('')
        try {
          const next = await call('/update', { method: 'POST', body: { zen: { visibleModels: [...current] } } })
          setView(next)
          setNotice(t('visibilitySaved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setSaving('') }
      }

      /** Open or close one model's advanced panel. */
      const toggleExpanded = (modelId) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(modelId)) next.delete(modelId)
          else next.add(modelId)
          return next
        })
      }

      /**
       * Save one field of one model's advanced panel.
       *
       * `null` clears the field, which is how the panel spells "back to inherited";
       * the server distinguishes that from "a value that happens to equal the
       * inherited one", so a deliberate choice is never silently dropped.
       */
      const saveSetting = async (modelId, field, value) => {
        setSaving(`${modelId}#${field}`)
        setFailure('')
        setNotice('')
        try {
          const next = await call('/update', {
            method: 'POST',
            body: { modelSettings: { [modelId]: { [field]: value } } },
          })
          setView(next)
          setNotice(t('advancedSaved'))
        } catch (error) {
          setFailure(`${t('err')}: ${String(error?.message ?? error)}`)
        } finally { setSaving('') }
      }

      /** Show every model the gateway listed, in one action. */
      const showAll = () => {
        const ids = (view?.catalogue ?? []).map(m => m.id)
        setSaving('__all__')
        setFailure('')
        call('/update', { method: 'POST', body: { visibleModels: ids } })
          .then((next) => { setView(next); setNotice(t('visibilitySaved')) })
          .catch((error) => setFailure(`${t('err')}: ${String(error?.message ?? error)}`))
          .finally(() => setSaving(''))
      }

      /** Hide every model, deliberately. */
      const hideAll = () => {
        setSaving('__all__')
        setFailure('')
        call('/update', { method: 'POST', body: { visibleModels: [] } })
          .then((next) => { setView(next); setNotice(t('visibilitySaved')) })
          .catch((error) => setFailure(`${t('err')}: ${String(error?.message ?? error)}`))
          .finally(() => setSaving(''))
      }

      /**
       * The expanded detail panel for one model.
       *
       * Rendered through a stable module-scope component so the capacity fields keep
       * what the user is typing: a component created inside this render would be a
       * new type on every pass, and React would remount it on each keystroke.
       */
      const advancedPanel = (model) => h(AdvancedPanel, {
        key: `${model.id}-advanced`,
        model,
        t,
        saving,
        levels: view?.effortLevels,
        choices: view?.protocols ?? ['chat-completions', 'responses', 'anthropic-messages'],
        onProtocol: chooseProtocol,
        onSave: saveSetting,
      })

      const modelRows = () => {
        // The checklist is the full catalogue, not the served subset: hiding a model
        // must remain undoable from this same list.
        const catalogue = view?.catalogue ?? []
        if (view === undefined || view === null) return h('div', { className: 'ocl_empty' }, t('modelsLoading'))
        if (catalogue.length === 0) return h('div', { className: 'ocl_empty' }, t('modelsEmpty'))

        // Chosen models float to the top, so the roster a user actually configured is
        // the part they see first; the rest follows in the gateway's order. The sort
        // is stable by id within each group so a checkbox toggle does not reshuffle
        // rows the user is not looking at.
        const ordered = [...catalogue].sort((left, right) => {
          if (left.visible !== right.visible) return left.visible ? -1 : 1
          return 0
        })

        const needle = query.trim().toLowerCase()
        const shown = needle === '' ? ordered : ordered.filter(m => m.id.toLowerCase().includes(needle))
        if (shown.length === 0) return h('div', { className: 'ocl_empty' }, t('noMatch'))
        const choices = view?.protocols ?? ['chat-completions', 'responses', 'anthropic-messages']
        const visibleCount = catalogue.filter(m => m.visible).length
        // A divider between the two groups, drawn only when both are present and the
        // search box is not narrowing the list (where a header would be misleading).
        const showDivider = needle === '' && visibleCount > 0 && visibleCount < ordered.length
        return h(React.Fragment, null,
          h('div', { className: 'ocl_row ocl_rowTight' },
            h('span', { className: 'ocl_count' }, t('visibleCount', { n: visibleCount, total: catalogue.length })),
            h('button', { className: 'ocl_btn', disabled: saving !== '', onClick: showAll }, t('showAll')),
            h('button', { className: 'ocl_btn', disabled: saving !== '', onClick: hideAll }, t('hideAll')),
          ),
          h('div', { className: 'ocl_list' }, shown.map((model, index) => h(React.Fragment, { key: model.id },
            showDivider && index === visibleCount
              ? h('div', { className: 'ocl_divider', key: `${model.id}-divider` }, t('hiddenGroup'))
              : null,
            h('div', {
              className: `ocl_rowItem ${model.visible ? '' : 'ocl_rowItemHidden'} ${expanded.has(model.id) ? 'ocl_rowItemExpanded' : ''}`,
            },
            h('div', { className: 'ocl_rowMain' },
              h('label', { className: 'ocl_check' },
                h('input', {
                  type: 'checkbox',
                  checked: model.visible,
                  disabled: saving === model.id || saving === '__all__',
                  onChange: e => { void toggleVisible(model.id, e.target.checked) },
                }),
                h('span', { className: 'ocl_rowId' }, model.id),
              ),
              h('button', {
                className: 'ocl_disclose',
                title: t('advanced'),
                'aria-expanded': expanded.has(model.id) ? 'true' : 'false',
                onClick: () => toggleExpanded(model.id),
              }, expanded.has(model.id) ? '−' : '+'),
              h('span', { className: `ocl_tag ${model.visible ? (model.protocol ? 'ocl_tagOk' : 'ocl_tagWarn') : ''}` },
                model.visible ? (model.protocol ? t('chosen') : t('notChosen')) : t('hidden')),
            ),
            expanded.has(model.id) ? advancedPanel(model) : null,
            ),
          ))),
        )
      }

      const lastRefreshText = () => {
        const last = view?.lastRefresh
        if (!last || !last.at) return t('never')
        const when = new Date(last.at).toLocaleTimeString()
        return `${when} · ${last.ok ? (last.message ?? '') : `${t('err')}: ${last.message}`}`
      }

      // Where the `auto` capacity numbers came from. Reading "200000" without
      // knowing the offline snapshot was in use would be misleading — the
      // snapshot can be a day old or simply wrong for a model it predates.
      const capacitySourceText = () => {
        const cat = view?.lastCatalogue
        if (!cat || cat.source === 'none' || !cat.at) return t('capacityNone')
        const when = new Date(cat.at).toLocaleString()
        const label = cat.source === 'network' ? t('capacityNetwork') : t('capacityCache')
        return `${label} · ${when}`
      }

      return h('div', { className: 'ocl_root' },
        h('div', { className: 'ocl_hero' },
          h('div', { className: 'ocl_heroTitle' }, t('title')),
          h('div', { className: 'ocl_heroSub' }, t('subtitle')),
        ),

        // The state line comes first: it explains every disabled control below.
        blockedReason() === null
          ? null
          : h('p', { className: 'ocl_body' }, blockedReason()),

        h('div', { className: 'ocl_card' },
          h('div', { className: 'ocl_cardTitle' }, t('whyTitle')),
          h('p', { className: 'ocl_body' }, t('whyBody')),
        ),

        // Route + credential, editable in place.
        h('div', { className: 'ocl_card' },
          h('div', { className: 'ocl_cardTitle' }, t('routeTitle')),
          h('div', { className: 'ocl_grid' },
            field(t('routeId'), h('span', { className: 'ocl_val' }, view?.route ?? '—')),
            editableField('displayName', t('routeName'), t('nameHint')),
            editableField('baseURL', t('routeBase'), t('baseHint')),
            field(t('routeModels'), h('span', { className: 'ocl_val' }, view?.endpoint?.models ?? '—')),
            field(t('routeChat'), h('span', { className: 'ocl_val' }, view?.endpoint?.chat ?? '—')),
            keyRow(),
          ),
          editing
            ? h('div', { className: 'ocl_grid' },
                field(t('keyTitle'), h('input', {
                  className: 'ocl_input',
                  type: 'password',
                  value: draft.apiKey ?? '',
                  placeholder: t('keyPlaceholder'),
                  onChange: e => edit('apiKey', e.target.value),
                })),
                field(t('autoRefresh'), h('input', {
                  className: 'ocl_input',
                  type: 'number',
                  min: 0,
                  value: value('autoRefreshMinutes') ?? 0,
                  onChange: e => edit('autoRefreshMinutes', Number(e.target.value)),
                })),
              )
            : null,
          h('p', { className: 'ocl_note' }, t('keyHint')),
          h('p', { className: 'ocl_note' }, t('liveHint')),
          h('div', { className: 'ocl_row' },
            editing
              ? h(React.Fragment, null,
                  h('button', { className: 'ocl_btn ocl_btnPrimary', disabled: busy !== '', onClick: save },
                    busy === 'save' ? t('saving') : t('save')),
                  h('button', { className: 'ocl_btn', onClick: () => { setEditing(false); setDraft({}) } }, t('cancel')),
                )
              : h('button', {
                className: 'ocl_btn',
                disabled: view === undefined || view === null,
                onClick: () => { setEditing(true); setDraft({}) },
              }, t('edit')),
            h('button', { className: 'ocl_btn', disabled: busy !== '', onClick: test },
              busy === 'test' ? t('testing') : t('test')),
            h('button', { className: 'ocl_btn', disabled: editing || busy !== '', onClick: reset }, t('reset')),
          ),
        ),

        // The catalogue and the visibility checklist.
        h('div', { className: 'ocl_card' },
          h('div', { className: 'ocl_cardTitle' },
            t('modelsTitle'),
            h('span', { className: 'ocl_tag' },
              t('modelsCount', { n: view?.catalogue?.length ?? 0 })),
          ),
          h('p', { className: 'ocl_note' }, `${t('lastRefresh')}: ${lastRefreshText()}`),
          h('p', { className: 'ocl_note' }, `${t('capacitySource')}: ${capacitySourceText()} · ${t('capacityHint')}`),
          h('div', { className: 'ocl_row' },
            h('input', {
              className: 'ocl_input',
              style: { maxWidth: '260px' },
              value: query,
              placeholder: t('search'),
              onChange: e => setQuery(e.target.value),
            }),
            h('button', { className: 'ocl_btn ocl_btnPrimary', disabled: busy !== '', onClick: refresh },
              busy === 'refresh' ? t('refreshing') : t('refreshBtn')),
          ),
          h('p', { className: 'ocl_note' }, t('refreshHint')),
          h('p', { className: 'ocl_note' }, t('visibilityHint')),
          h('p', { className: 'ocl_note' }, t('protocolHint')),
          modelRows(),
        ),

        // Zen 免费模型车道卡片
        h('div', { className: 'ocl_card' },
          h('div', { className: 'ocl_cardTitle' },
            h('label', { className: 'ocl_switch' },
              h('input', {
                type: 'checkbox',
                checked: view?.zen?.enabled ?? true,
                disabled: saving === 'zen#enabled',
                onChange: (e) => toggleZenEnabled(e.target.checked),
              }),
            ),
            t('zenTitle'),
            h('span', { className: 'ocl_tag ocl_tagOk' },
              t('zenModelsCount', { n: view?.zen?.catalogue?.length ?? 0 })),
          ),
          h('p', { className: 'ocl_body' }, t('zenSubtitle')),
          h('p', { className: 'ocl_note' }, t('zenNotice')),
          h('div', { className: 'ocl_grid' },
            field(t('zenRouteId'), h('span', { className: 'ocl_val' }, view?.zen?.route ?? 'opencode-zen-free')),
            field(t('zenRouteName'), h('span', { className: 'ocl_val' }, view?.zen?.displayName ?? 'OpenCode Zen 免费模型')),
            field(t('zenRouteBase'), h('span', { className: 'ocl_val' }, view?.zen?.baseURL ?? 'https://opencode.ai/inference/v1')),
            field(t('keyTitle'), h('span', { className: 'ocl_val' }, view?.zen?.apiKey ?? 'public')),
          ),
          h('div', { className: 'ocl_row' },
            h('button', {
              className: 'ocl_btn ocl_btnPrimary',
              disabled: busy !== '' || view?.zen?.enabled === false,
              onClick: refreshZen,
            }, busy === 'refreshZen' ? t('refreshing') : t('zenRefreshBtn')),
          ),
          h('div', { className: 'ocl_list' }, (view?.zen?.catalogue ?? []).map((model) => h('div', {
            className: `ocl_rowItem ${model.visible ? '' : 'ocl_rowItemHidden'}`,
            key: `zen-${model.id}`,
          },
          h('div', { className: 'ocl_rowMain' },
            h('label', { className: 'ocl_check' },
              h('input', {
                type: 'checkbox',
                checked: model.visible,
                disabled: saving === `zen#${model.id}`,
                onChange: (e) => toggleZenVisible(model.id, e.target.checked),
              }),
              h('span', { className: 'ocl_rowId' }, model.id),
            ),
            h('span', { className: 'ocl_tag ocl_tagOk' }, 'chat-completions'),
            model.vision ? h('span', { className: 'ocl_tag' }, t('inputImage')) : null,
          )))),
        ),

        failure !== '' ? h('p', { className: 'ocl_body ocl_err' }, failure) : null,
        notice !== '' ? h('p', { className: 'ocl_body ocl_ok' }, notice) : null,

        view?.storePath
          ? h('p', { className: 'ocl_note' }, t('storeHint', { path: view.storePath }))
          : null,
      )
    }

    // ── registration ──────────────────────────────────────────────────────────

    function apply(ctx) {
      const bound = ctx.locale.bind(NS)
      const t = (key, vars) => {
        const text = bound(key)
        if (vars === undefined) return text
        return Object.entries(vars).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(value)), text)
      }
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'opencode-live: dictionaries')

      ctx.effect(() => {
        const style = globalThis.document.createElement('style')
        style.textContent = CSS
        globalThis.document.head.appendChild(style)
        return () => style.remove()
      }, 'opencode-live: styles')

      // The standalone nav section: where someone looks for "this route".
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'opencode-live',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, ctx, t })))

      // And a tab under Plugins, which is where someone goes looking for "where do
      // I edit this plugin". That page only auto-renders a form for the official
      // namespaces it names itself, so a third-party fiber registers its own tab.
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'opencode-live',
        order: 21,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, ctx, t })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-opencode-live'
    return module.exports
  },
})
