# 这个仓库是怎么发出去的

记录已经做过的事，以及将来更新插件时要遵守的规则。

**现状**：仓库在 <https://github.com/Paurika1113/dsh-opencode-live>，`main` 分支，公开，topic 已设。

---

## 已经完成的步骤（供以后重做时参考）

### 1. 远端与推送

```powershell
cd D:\AIzy\杂\plugins\dsh-opencode-live
git remote add origin https://github.com/Paurika1113/dsh-opencode-live.git
git push -u origin main
```

### 2. ⚠️ 代理端口：`7897` 不通，要用 `7890`

这是本次唯一卡住的地方，记下来省得下次再踩：

- 全局 git 配置里写的是 `http.proxy = http://127.0.0.1:7897`
- 但本机实际监听的是 **7890**（`7897` 连不上，报 `Failed to connect to github.com:443 over proxy`）
- 修法是**只给本仓库**覆盖，不动全局配置：

```powershell
git config --local http.proxy http://127.0.0.1:7890
git config --local https.proxy http://127.0.0.1:7890
```

`Invoke-RestMethod` / `Invoke-WebRequest` 调 GitHub API 时同理，要带 `-Proxy 'http://127.0.0.1:7890'`。

### 3. 凭据本来就有

一开始判断「本机没有 GitHub 凭据」是错的——**凭据一直在 Windows 凭据管理器里**（`git:https://github.com`），Git Credential Manager 也在 `C:\Program Files\Git\mingw64\bin\git-credential-manager.exe`。之前 `ls-remote` 失败纯粹是代理端口的问题。

取凭据做 API 调用（不打印内容）：

```powershell
$raw = "protocol=https`nhost=github.com`n`n" | & 'C:\Program Files\Git\mingw64\bin\git-credential-manager.exe' get 2>$null
$pw  = (($raw | Select-String '^password=').Line) -replace '^password=',''
```

### 4. Topic（「挂标签」）

通过 API 设置，已生效：

```powershell
$body = @{ names = @('dsh','dsh-plugin','dsh-bundle','cordis','opencode','opencode-zen','deepseek','llm','agent','ai') } | ConvertTo-Json
Invoke-RestMethod -Method Put `
  -Uri 'https://api.github.com/repos/Paurika1113/dsh-opencode-live/topics' `
  -Headers @{ Authorization = "Bearer $pw"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'dsh-opencode-live' } `
  -Body $body -ContentType 'application/json' -Proxy 'http://127.0.0.1:7890'
```

`dsh-plugin` 和 `dsh-bundle` 是最有用的两个 —— 别人按这个搜就能找到。

> **重要**：DSH 自己**不读** GitHub topic。我查过整个 `dsh-plugin-market` 包，没有任何代码去访问 GitHub；它的配置项就是 `indexes: string[]`，每一项是一个指向格式 1 JSON 的 `http(s)` URL。topic 只帮人搜索，不帮机器发现。要塞进市场只能靠索引 JSON，见下一节。

---

## 插件市场索引

`market/index.json` 是**格式 1 索引**，raw URL：

```
https://raw.githubusercontent.com/Paurika1113/dsh-opencode-live/main/market/index.json
```

在 DSH 设置 → 插件市场里填这个 URL 即可。

### 验证状态

不是照着文档抄的，是跑出来的：

1. 从 `app.asar` 里抽出 `@deepseek-ai/dsh-plugin-market-index` 连同它依赖的 `semver`，离线执行真实的 `parseMarketIndex`
2. 本地文件 → `VALID`
3. **远端 raw URL 拉下来的文件 → 也 `VALID`**（HTTP 200）
4. 把索引喂给 `marketInstallTarget`，产出 `git+https://github.com/Paurika1113/dsh-opencode-live.git#0951b70…`，且该提交用 `git branch -r --contains` 确认是 `origin/main` 的祖先 —— 即远端真实存在，装得上
5. 另做 8 个反例（ISO 字符串时间戳、`source` 分层错误、缺 `commit`、`commit` 大写、`title` 缺 `en`、`format` 改 2、`version` 写 `^0.2.0`、`repository` 写成字符串），**8 个全部被拒**，报错都带精确 JSON 路径

### 字段规则（实测，非抄文档）

| 字段 | 真实要求 |
|------|----------|
| `title` | 本地化对象或纯字符串；写成对象时**必须含 `en`**，其余键必须是小写语言 id |
| `publishTimestamp` | **整数 Unix 秒**，不是 ISO 字符串，范围 `[0, 10^11)` |
| `source` | 放在**每个版本**上，不是插件级；`type` 只能是 `"npm"` 或 `"git"` |
| `source.commit`（git） | **必填**，小写 40 位十六进制 SHA —— 这就是「钉版本」 |
| `source.url`（git） | `https:` 绝对 URL、**无 query/fragment**、路径至少两段、不能是 `.tgz` |
| `source.path`（git） | 可选，包不在仓库根时指向子目录 |
| `icon` | 可选；相对引用按索引 URL 解析，只允许 https 或同源；内联 `data:` 上限解码后 32 KiB |
| `repository` | 结构是 `{ "url": ..., "directory"?: ... }`，**不是字符串** |
| 未定义字段 | **被静默丢弃**，不报错——写错名字就只是没生效 |

### 更新版本时的规矩

索引钉的是具体 commit，所以**每次发新版都要改 `market/index.json`**：

1. 跑测试：`node scripts/selftest.mjs` 等六个
2. 改 `package.json` 的 `version`
3. 提交并推送
4. 用**这次推送后的真实 SHA** 回填 `market/index.json` 的 `commit`，并更新 `publishTimestamp` 为同一提交的 Unix 秒
5. 再提交推送一次

第 4 步不是循环依赖：钉住的提交只要是**远端历史中的祖先**就合法，哪怕它里面的索引文件指向更早的 SHA。

顺带：`.gitattributes` 里已经把行尾统一成 LF了，Windows 上 checkout 不会把每个文件显示成已修改。
