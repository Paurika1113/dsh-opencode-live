# 发布到 GitHub 的步骤

本仓库的 Git 历史已经就绪（`main` 分支，一次初始提交）。剩下的是**只有你能做**的部分：创建远端、推送、设置 topic。

## 1. 创建远端仓库并推送

先在 GitHub 网页上建一个**空**仓库（不要勾选初始化 README / .gitignore / LICENSE，否则首次推送会冲突），然后：

```powershell
cd D:\AIzy\杂\plugins\dsh-opencode-live

# 用你自己的用户名替换 YOUR_GITHUB_USERNAME
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/dsh-opencode-live.git
git push -u origin main
```

推送要凭据。本机当前没有可用的 GitHub 凭据（SSH key 不被 GitHub 接受、没有 `gh` CLI、没有 `~/.git-credentials`），任选一种：

| 方式 | 做法 |
|------|------|
| **Personal Access Token（最省事）** | GitHub → Settings → Developer settings → Personal access tokens → 生成一个带 `repo` 权限的 token，推送时把 token 当密码填（用户名填 GitHub 用户名） |
| **Git Credential Manager** | 推送时若弹出浏览器登录窗口，直接登录即可，凭据会存进 Windows 凭据管理器 |
| **SSH** | 把 `~/.ssh/id_ed25519.pub` 加到 GitHub → Settings → SSH and GPG keys，再 `git remote set-url origin git@github.com:YOUR_GITHUB_USERNAME/dsh-opencode-live.git` |

## 2. 把 package.json 里的占位符换成真实地址

`package.json` 里现在写的是 `YOUR_GITHUB_USERNAME`。推送后执行（把用户名换成你的）：

```powershell
cd D:\AIzy\杂\plugins\dsh-opencode-live
(Get-Content package.json -Raw).Replace('YOUR_GITHUB_USERNAME', '你的GitHub用户名') | Set-Content package.json -NoNewline
git add package.json
git commit -m "chore: point repository metadata at the real URL"
git push
```

## 3. 设置 GitHub topic（这就是「挂标签」）

topic 不在 git 里，只能通过网页或 API 设置。仓库页面右上角 **⚙️ (About) → Topics**，填入下面这些：

```
dsh
dsh-plugin
dsh-bundle
cordis
opencode
opencode-zen
deepseek
llm
agent
```

或者用一次 API 调用（需要带 `repo` 权限的 token）：

```powershell
$token = '你的 PAT'
$body = @{ names = @('dsh','dsh-plugin','dsh-bundle','cordis','opencode','opencode-zen','deepseek','llm','agent') } | ConvertTo-Json
Invoke-RestMethod -Method Put `
  -Uri 'https://api.github.com/repos/YOUR_GITHUB_USERNAME/dsh-opencode-live/topics' `
  -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' } `
  -Body $body -ContentType 'application/json'
```

`dsh-plugin` 和 `dsh-bundle` 是最有用的两个 —— 别人按这个搜就能找到。

> **注意**：DSH 自己**不读** GitHub topic。它的插件市场读的是用户手动配置的索引 JSON（格式 1）。topic 只是方便人搜索。如果你想让插件出现在市场里，需要额外做一份索引 JSON，见下一节。

## 4. （可选）做一份插件市场索引

DSH 的市场（`plugin_market` 工具 / 发现页）读的是索引 JSON（格式 1）。真实的校验规则在安装包的 `@deepseek-ai/dsh-plugin-market-index` 里，我读了它的源码，下面这份示例是逐条对齐过的：

```jsonc
{
  "format": 1,
  "title": { "en": "Paurika's DSH plugins", "zh": "Paurika 的 DSH 插件" },
  "description": { "en": "Plugins I maintain for the DSH desktop app." },
  "plugins": [
    {
      "name": "dsh-opencode-live",
      "title": { "en": "OpenCode Go live route", "zh": "OpenCode Go 实时路由" },
      "description": {
        "en": "One DSH route backed by the live gateway model roster.",
        "zh": "一个由网关实时模型清单驱动的 DSH 路由。"
      },
      "author": "Paurika",
      "homepage": "https://github.com/YOUR_GITHUB_USERNAME/dsh-opencode-live#readme",
      "repository": { "url": "https://github.com/YOUR_GITHUB_USERNAME/dsh-opencode-live" },
      "versions": [
        {
          "version": "0.2.0",
          "publishTimestamp": 1792747182,
          "source": {
            "type": "git",
            "url": "https://github.com/YOUR_GITHUB_USERNAME/dsh-opencode-live",
            "commit": "4c2916443dc4f264defceb1e18c731ffaa9de44f"
          },
          "engines": { "dsh": ">=0.2.1-rc.2" }
        }
      ]
    }
  ]
}
```

**几个最容易写错的地方**（都会直接抛出 `MarketIndexError`）：

| 字段 | 真实要求 |
|------|----------|
| `title` | 是**本地化对象或纯字符串**，不是插件列表里的 `metadata`；写成 `{"en": ...}` 时必须含 `en` 键，其余键必须是小写语言 id（`zh`、`zh-hant`、`pt-br` 都行） |
| `publishTimestamp` | **整数 Unix 秒**，不是 ISO 字符串，取值 `[0, 10^11)` |
| `source` | 每**版本**一个 `source`，不是插件级；`type` 只能是 `"npm"` 或 `"git"` |
| `source.commit`（git） | **必填**，小写 40 位十六进制 SHA —— 这就是「钉版本」 |
| `source.url`（git） | `https:` 绝对 URL、**无 query/fragment**、路径至少两段、不能是 `.tgz` 链接 |
| `source.path`（git） | 可选，包不在仓库根时指向子目录 |
| `icon` | 可选；相对引用会按索引 URL 解析，只允许 https 或同源；内联 `data:` 上限 32 KiB 解码后 |
| `repository` | 结构是 `{ "url": ..., "directory"?: ... }`，不是字符串 |
| 未定义字段 | **被静默丢弃**，不会报错——写错了名字就只是没生效 |

我把上面每一条都做成反例实跑了一遍：把 `publishTimestamp` 改成 ISO 字符串、把 `source` 挪到插件级、删掉 `commit`、把 `commit` 改大写、`title` 去掉 `en`、`format` 改成 2、`version` 写成 `^0.2.0`、`repository` 写成字符串——**8 个全部被拒**，报错带精确 JSON 路径。所以这份表格不是抄文档抄来的，是跑出来的。

改好后把文件放到仓库里（例如 `market/index.json`），在 DSH 设置 → 插件市场里填该文件的 raw URL。

`market/index.json` 里已经放了一份完整可用的样例（把 `YOUR_GITHUB_USERNAME` 和 `commit` 换成真实的即可）。**这份样例是用真实的 `parseMarketIndex` 实跑验证过的**——我从 `app.asar` 里把 `@deepseek-ai/dsh-plugin-market-index` 和它的 `semver` 依赖一起抽出来离线执行，输出 `VALID`，所以字段名和类型可以放心照抄。
