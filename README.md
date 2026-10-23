# dsh-opencode-live

给 DSH 一条「模型清单以网关实时列表为准」的 OpenCode Go 路由，并为每个模型用它真正支持的那套线路协议拨号。

## 为什么需要它

OpenCode Go 网关上了新模型，官方 `opencode-go` 路由却看不到，这不是配置错误，而是三层结构性问题：

1. **发现路径短路。** `@deepseek-ai/dsh-llm-pi-ai` 的 `discoverModels()` 对 pi-ai 目录内已知的 provider **直接返回构建期快照，一次网络请求都不发**：

   ```ts
   if (request.provider !== undefined) {
     const installed = catalogModels(request.provider)
     if (installed.size > 0) return [...installed.values()].map(...)   // ← 命中即返回
   }
   ```

   快照是打进包里的 JSON（`@earendil-works/pi-ai/dist/providers/data/opencode-go.json`，`generatedAt` 记录生成时间），没有 TTL、不会刷新。上游 2026-08-04 的 `ffd2f188` 引入这一行为，动机是"省一次网络往返 + 拿到 listing 不披露的 contextWindow/maxTokens"；原始实现（同日更早的 `ecee93ec`）是无条件发请求的。

2. **手工添加也过不去。** 该目录横跨三种协议，`sharedCatalogApi()` 因此返回 `undefined`，手填新 id 会以 `needs an api` 被驳回；而设置页只对 pi-ai **不认识**的路由提供协议下拉框。

3. **声明 `api:` 会让 session 头消失。** `buildProvider()` 在 `spec.api === undefined` 时复用目录 provider（带 pi-ai 的 `withOpenCodeSessionHeader` 包装器），否则用 `PROTOCOLS` 里的**裸 api** 重建 —— 网关随即回 400 `MissingSessionID`。

第 1 条是无条件的，配置层碰不到。所以本插件自己拥有一条路由，把这三件事都自己回答。

## 它做什么

| 能力 | 做法 |
|------|------|
| **实时模型列表** | 自己 `GET {prefix}/v1/models`，注册在自己的 settings 命名空间下，与 pi-ai 目录无关。**一次请求，约 1 秒** |
| **勾选要显示的模型** | 每个模型一个复选框；列表始终展示网关完整目录，取消勾选只是隐藏，随时可勾回 |
| **选中的排在最前** | 已勾选的模型浮到列表顶部，下方分出一条「未显示的模型」；组内保持网关原顺序 |
| **协议由你选择** | `/models` 只给 id 不给协议；设置页为每个模型提供下拉框，选中即保存 |
| **图片输入由你选择** | `/models` 也不含模态字段；默认按实测表，每行一个下拉框可覆盖 |
| **思考档位按厂商表** | 按模型家族给出该厂商文档里真正存在的档位；不认识的家族**不显示**档位 |
| **按对话派生 session** | `sha256("dsh-opencode-live\0" + 会话ID)` → UUID v5，同一对话稳定、不同对话不同 |
| **失败保留上次列表** | 网络抖动不清空目录；保存的显示/协议选择不依赖网络，立即生效 |
| **独立设置页** | 侧边栏与插件页各一个入口：改 key、网关、显隐、每个模型的协议与图片能力 |

### 为什么协议要手动选

网关的 `/models` 只返回 id 和 `owned_by`，不含协议。而**同一路由下不同模型接受的协议不同**（2026-10-21 实测 37 个模型）：

| 模型 | chat-completions | responses | anthropic-messages |
|------|:---:|:---:|:---:|
| `minimax-m3.1-flash-free` | ✅ | ✅ | ✅ |
| `grok-4.6` / `grok-4.7` | ❌ | ✅ | ❌ |
| `claude-haiku-5-5` | ❌ | ❌ | ✅ |
| `minimax-m2.7` | ❌ | ❌ | ✅ |
| `glm-*` / `kimi-*` / `qwen-*` | ✅ | ✅ | ❌ |

试过自动探测：37 × 3 = 111 个请求，并发 6 也要 **42 秒**。放在启动路径上会让模型列表整整 42 秒为空——比"手动选一次"糟糕得多。所以**刷新只拉列表**，协议由用户在页面上选，没选的默认 `chat-completions`。

**认证头也不同**：`anthropic-messages` 用 `x-api-key`（实测 Bearer 会 401），两种 OpenAI 方言用 `authorization: Bearer`。

### 图片输入同样要手动选

`/models` 的每一项只有 `id`、`object`、`created`、`owned_by`（2026-10-22 实测），**没有任何模态字段**，所以「这个模型能不能看图」无法被查出来，只能被测出来或被告知。

插件内置一张实测表：用同一句提问分别发纯红与纯蓝的 PNG，只有两次都答对颜色才算「真能看图」。只返回 200 不算——把图片字段整个忽略掉的模型也照样返回 200。2026-10-22 对网关全部 37 个模型跑完，16 个通过（`_probe/vision-catalogue.mjs`、`_probe/vision-retry.mjs`）。另外 4 个是 403 地区封锁、3 个报错/欠费，剩下的是确实读不了图。

表外的模型默认**按纯文本**处理：猜「能看图」会让模型收到一张它回 400 的图，猜「纯文本」只是藏起一个一键就能打开的能力。每行一个下拉框可覆盖实测结果，三个状态：

- `自动（实测：支持/不支持）` —— 用内置表，标签直接写明它会解析成什么
- `支持图片` / `仅文本` —— 你的选择，永久优先于内置表
- 回到 `自动` 即清除覆盖，回落到实测值

### 思考档位来自厂商文档，不是猜的

`lib/effort.js` 按模型 id 前缀匹配家族（顺序敏感：`kimi-k3` 必须先于 `kimi-`，`glm-5.3` 先于 `glm-`），每个家族带上厂商公开文档里真实存在的档位与默认值。**不认识的家族直接不返回 `reasoning` 字段**——猜一个档位表会让好几个厂商直接回 400。

`off` 与 `none` 严格区分，两者**不是同义词**：

| 档位 | 发出的参数 | 含义 |
|------|-----------|------|
| `Default`（内部 id `off`） | 什么都不发 | 由模型按自己的默认值决定。对 OpenAI 系是最少思考，但对 MiniMax 是**最大**思考 |
| `None` | 字面量 `"none"` | 真正关闭思考，**仅 OpenAI 系接受**；MiniMax 与 Grok 回 400 |

所以 `Default` 不叫「关闭」——对一半的家族它反而把思考开到最大。

## 安装

DSH 没有「扫描目录自动加载插件」。插件是 profile 包的 pnpm 依赖，`dsh.profile.bundles` 决定哪些依赖被挂载。

把本仓库 clone 到任意目录，然后把它作为依赖挂进 profile。

### 1. 取得代码

```powershell
git clone <本仓库地址> dsh-opencode-live
```

### 2. 挂进 profile

`~/.dsh/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": {
    // 换成你 clone 到的绝对路径
    "dsh-opencode-live": "link:<clone 到的绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-opencode-live"
      ]
    }
  }
}
```

```powershell
cd C:\Users\<你>\.dsh\profiles\<profile>
pnpm install
```

> 本插件的 profile 使用 `nodeLinker: hoisted` + `autoInstallPeers: false`，插件自己的 `peerDependencies` 不会被自动安装 —— 保持不声明即可，宿主提供这些包。

### 2. 在 cordis.patch.yml 里配置

fiber 本体由插件自带的 `cordis.patch.yml` 创建，你只需覆写它的 `config`：

```yaml
- id: opencode-live
  config:
    baseURL: https://opencode.ai/zen/go/v1     # 前缀；填完整端点也会被归一化
    apiKeyEnv: OPENCODE_GO_API_KEY
```

### 3. 重启 DSH，在模型选择器里选「OpenCode Go · 实时目录」下的模型

## 配置项

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 关闭后不注册任何路由 |
| `route` | `opencode-live` | 注册的路由 ID。**不能是 `opencode-go`**（已归 pi-ai 适配器） |
| `displayName` | `OpenCode Go · 实时目录` | 选择器里显示的名称 |
| `baseURL` | `https://opencode.ai/zen/go` | 网关**前缀**。`/v1` 会补齐；完整端点（`…/chat/completions`）会被裁掉；前后空格会被清掉 |
| `apiKey` | `''` | 填了就一定用它，优先于凭据库 |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 凭据库引用名 |
| `credentialRefs` | `[]` | 按顺序尝试的引用名 |
| `apiKeyHeader` | `authorization` | 密钥放在哪个请求头 |
| `apiKeyPrefix` | `Bearer ` | 密钥前缀；留空表示原样发送 |
| `fingerprint` | `false` | 是否补齐 `bash/glob/grep/read` 四件套。**Go 订阅通道实测不需要**（免费通道才校验） |
| `headers` | `{}` | 附加静态头。**`x-opencode-session` 会被丢弃** |
| `discoveryTimeoutMs` | `15000` | 拉列表超时 |
| `autoRefreshMinutes` | `0` | 自动刷新间隔，`0` 关闭 |
| `models` | `[]` | 手工声明的模型（带 `protocol` 时优先于页面选择） |

### 为什么默认 `models` 是空的

这条路由的前提就是「网关说了算」。内置一份清单等于把那份会过期的快照搬进来，正是本插件要消除的东西。若想在首次刷新前就能用，手工声明即可。

### 为什么 `fingerprint` 默认关

2026-10-21 实测，`minimax-m3.1-flash-free` 在 Go 订阅通道上带不带四件套工具都是 200。四件套是**免密 free 通道**的门，不是这条通道的。把它开着会让每个模型都收到四个自称不可用的诱饵工具。

## 三种线路协议

网关的 `/v1/models` 只给 id，不给协议。而同一路由下不同模型接受的协议完全不同（2026-10-21 实测 37 个模型）：

| 模型 | chat-completions | responses | anthropic-messages |
|------|:---:|:---:|:---:|
| `minimax-m3.1-flash-free` | ✅ | ✅ | ✅ |
| `deepseek-v4.1-flash` | ✅ | ✅ | ✅ |
| `grok-4.6` / `grok-4.7` | ❌ | ✅ | ❌ |
| `claude-haiku-5-5` | ❌ | ❌ | ✅ |
| `minimax-m2.7` | ❌ | ❌ | ✅ |
| `glm-*` / `kimi-*` / `qwen-*` | ✅ | ✅ | ❌ |
| `beam-free` / `muse-spark-*` | 区域封锁 | 区域封锁 | 区域封锁 |

所以协议是**按模型**的属性，不是按路由的。设置页为每个模型提供一个下拉框，选中即存进 `~/.dsh/opencode-live/config.json` 的 `modelProtocols`。

**认证头也不同**：`anthropic-messages` 用 `x-api-key`（实测 Bearer 会 401），两种 OpenAI 方言用 `authorization: Bearer`。

## 每个模型的详细设置

每行右侧有个 `+`，展开后是这个模型自己的四项设置。它们和协议下拉框一样，都是**用户说了算**——插件不猜，也不在后台测。

| 设置 | 存进 | 不设置时 |
|------|------|----------|
| 上下文窗口 | `modelSettings[id].contextWindow` | 平台默认 204800 |
| 最大输出 token | `modelSettings[id].maxTokens` | 平台默认 131072，且永远不超过上下文窗口 |
| 输入类型（文本/图片） | `modelSettings[id].inputModalities` | 回落到图片实测表（`modelVision` 布尔仍生效） |
| 思考档位 | `modelSettings[id].reasoningEfforts` | 回落到按模型家族匹配的厂商文档表 |

容量输入接受 `128K` / `1M` / `200000` 三种写法，留空就是继承。输入类型至少要留一种——取消最后一个勾选框是禁用状态，因为「不给模型任何输入方式」不是配置。

**思考档位是一张「档位 → 实际发送值」的表**，和官方模型编辑器同形。`null` 值有确切含义：该档**不发任何思考参数**（官方叫 `off`，这里叫「默认」）。这不是「关闭思考」——对 MiniMax 来说不发参数就是它文档里的 `max`。要真正关掉思考得用字面量 `none`，而只有 OpenAI 系模型接受它。

**零档位也是合法指令**：声明一个空表等于要求「这个模型不要显示思考控件」，插件照办，不回落文档表。但如果你输入的全是非法的值（空串、数字），那不是「我要零档」，插件会整条丢弃——否则一次打字错误就会静默关掉一个控件。

## 设置页接口

挂在 `/api/opencode-live`：

| 路径 | 方法 | 作用 |
|------|------|------|
| `/view` | GET | 当前状态、完整目录（含每行的协议/图片/容量/档位与它们的继承值）、上次刷新结果 |
| `/refresh` | POST | 重新拉列表，只拉列表，不探测任何协议 |
| `/update` | POST | 合并写入配置：`modelProtocols`、`modelVision`、`modelSettings`、`visibleModels` 与标量字段 |
| `/probe` | POST | 对某个模型发一个最小请求（`{"model":"..."}`） |
| `/health` | GET | 存活检查 |

`/update` 的四张表都是**合并**语义，删一个键要显式传 `null`：

```json
{ "modelProtocols": { "grok-4.7": "responses" }, "modelVision": { "minimax-m3": null } }
```

`modelVision` 只接受 `true`/`false`；`null` 表示「清除这个模型的覆盖，回落实测表」——注意它**不等于** `false`。

`modelSettings` 有三层清空语义，因为界面能表达三种不同的意图：

```json
{ "modelSettings": { "m": null } }                      // 忘掉这个模型的全部设置
{ "modelSettings": { "m": { "maxTokens": null } } }      // 只清这一个字段，其余留着
{ "modelSettings": { "m": { "reasoningEfforts": {} } } } // 零档位，这是真实指令
```

## 测试

```bash
npm test          # 227 项离线：配置归一化、会话派生、三方言请求体/帧、工具配对、档位表、图片能力、挂载、设置页、Zen 门禁、宿主契约
npm run probe     # 联网：实时列表 + 三种方言端到端（消耗少量 token）
npm run probe:quick  # 联网：只验列表与一次对话
```

离线套件不联网、不需要凭据：

```text
scripts/selftest.mjs          119 项  纯函数与解析
scripts/stream-test.mjs        13 项  对一个假网关驱动三方言（含工具调用组装、错误分类、中止）
scripts/mount-test.mjs         49 项  fiber 挂载、路由注册、发现回调、卸载释放、设置页接口、可见性、图片能力、详细设置
scripts/client-test.mjs        27 项  浏览器半边的槽位、词典、渲染与展开面板
scripts/zen-test.mjs            9 项  Zen 会话、门禁指纹、头指纹、模型识别
scripts/host-contract-test.mjs  10 项  真实宿主累积器对两条车道每个流事件契约校验
```

### 宿主契约测试为什么单独存在

其余套件只断言「适配器产出了什么事件」。`host-contract-test.mjs` 断言的是「**宿主**接受这些事件」：它把每条 chunk 交付给真实的 `AssistantStreamAccumulator` 与 `BlockAssembler`，再读回最终块、结束原因与用量，并校验耐久回放重建的块一致。

这条契约无法靠形状自检覆盖。一个自定义事件在自己的事件数组里看起来完全正常，进入累积器后却会抛 `unreachable variant` —— 免费车道曾因此每次产生内容就整轮失败，而当时的 200 多项测试全绿。

宿主模块只存在于桌面版的 `app.asar` 内（profile 用 junction 装载插件，静态 `@deepseek-ai/*` 解析不到），所以该测试从归档里解包 `dsh-llm` 与 `dsh-util-values` 并就地求值，**跑的是已安装的宿主**而非手写替身。找不到归档时它会以非零码退出并打印 `SKIP`，不会假装通过；用 `DSH_ASAR` 指向其它构建。

### 异步测试的等待

`selftest.mjs` 与 `zen-test.mjs` 的 `test()` 会收集返回 Promise 的用例，在汇总前 `await Promise.all`。此前异步用例的断言在 `ok` 打印之后才执行，失败会变成未处理拒绝而不是受控失败。

## 代码结构

| 文件 | 职责 |
|------|------|
| `lib/index.js` | fiber：Config schema、挂载、刷新编排、设置页接口 |
| `lib/config.js` | 归一化与校验（**baseURL 前缀归一化**在这里） |
| `lib/discovery.js` | 实时 `/models` 读取 |
| `lib/protocol.js` | 三种方言的请求体、认证头、帧解析 |
| `lib/session.js` | 会话 ID 与请求 ID 派生 |
| `lib/capability.js` | 图片输入实测表（红/蓝对照）与用户覆盖 |
| `lib/effort.js` | 每个模型家族的思考档位表（厂商文档）与用户自定义表 |
| `lib/adapter.js` | 流式适配器：块记账、错误分类 |
| `client.js` | 浏览器半边：两个设置槽位、中英词典、每行下拉框与展开面板 |

## 打包约定

本插件**不静态 import 任何 `@deepseek-ai/*`**。原因是 profile 用 junction 装载本地包，静态说明符解析不到宿主依赖。`schemastery` 走 `loadSchemastery()` 路径查找；唯一的宿主类 `LlmError` 是**惰性**动态 import，带同形状字面量兜底。

## 与其它方案的关系

| 方案 | 定位 |
|------|------|
| 改官方 `opencode-go` 配置 | 能让请求发出去（`baseURL` 改前缀 + 静态 `headers` 补 session），但**探测仍然看不到新模型**，且一条路由只能一个协议 |
| `dsh-model-sync` | 用 `settings.mutate` 把 live id 写回，解决"列表陈旧"；不解决"声明 api 会丢 session" |
| `dsh-opencode-session` | 单路由 + 会话头；本插件的 session/protocol 层与之同源 |
| **本插件** | 发现 + 协议 + 会话三者都在自己手里 |
