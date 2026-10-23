/**
 * OpenCode Zen 免费模型上游线协议与门禁指纹。
 *
 * 参考自 dsh-our-free-model 与官方 OpenCode v2.0.26 CLI 实测：
 * 1. 接入端点：https://opencode.ai/inference/v1
 * 2. 认证凭证：Authorization: Bearer public（免密公共池）或用户自定义 Key
 * 3. 会话 ID 格式：时间倒序 hex 编码 ses_${hex12}${base62_14}，counter 在 1-63 范围
 * 4. 请求头指纹：
 *    - user-agent: opencode/latest/2.0.26/cli（必须整串匹配）
 *    - x-opencode-client: cli
 *    - x-opencode-project: global
 *    - x-opencode-session / x-opencode-session-id / x-session-affinity / x-session-id
 *    - 绝不下发 x-opencode-request（v1 专用头，下发即 403）
 * 5. 工具门禁：
 *    - 请求体 tools 必须包含官方 CLI 逐字一致的 read 与 shell 定义
 *    - 系统提示词补全占位说明以防模型误调桩工具
 *    - 绝不下发 tool_choice: 'none'（v2 见到即 403 FreeTierError）
 * 6. 传输模式：
 *    - 免费端点必须 stream: true（stream: false 会返回 403 FreeTierError）
 *
 * @module lib/zen-wire.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ZEN_DEFAULT_BASE_URL = 'https://opencode.ai/inference/v1'
export const ZEN_CLIENT_UA = 'opencode/latest/2.0.26/cli'
export const ZEN_POOLED_KEY = 'public'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

let lastStamp = 0
let seq = 0

/**
 * 铸造符合上游时间倒序校验的 session id。
 * 布局：ses_ + 12位十六进制倒序时间戳（低12位落入 0xfc0-0xfff 范围，counter 1-63）+ 14位 base62 随机串。
 *
 * @param {number} [timestamp]
 * @returns {string}
 */
export function mintZenSessionId(timestamp = Date.now()) {
  if (timestamp !== lastStamp) {
    lastStamp = timestamp
    seq = 0
  }
  seq = (seq % 63) + 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq))
  let hex = ''
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  return `ses_${hex}${base62From(crypto.randomBytes(14))}`
}

export const ZEN_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * 校验 session id 是否具备上游接受的倒序编码格式。
 *
 * @param {any} id
 * @returns {boolean}
 */
export function isCanonicalZenSession(id) {
  if (typeof id !== 'string' || !ZEN_SESSION_RE.test(id)) return false
  const hex = id.slice(4, 16)
  const low3 = Number.parseInt(hex.slice(-3), 16)
  return low3 >= 0xfc0 && low3 <= 0xfff
}

/** 内存会话映射表，确保同一对话在整个生命周期内复用同一上游 session，避免频繁新建触发限额。 */
const sessionMap = new Map()

/**
 * 为对话获取或创建稳定的 session id。
 *
 * @param {string} [seed]
 * @returns {string}
 */
export function zenSessionForConversation(seed) {
  if (typeof seed === 'string' && isCanonicalZenSession(seed)) return seed.trim()
  const key = typeof seed === 'string' && seed.trim() ? seed.trim() : 'global'
  const existing = sessionMap.get(key)
  if (existing !== undefined && isCanonicalZenSession(existing)) return existing
  const minted = mintZenSessionId()
  sessionMap.set(key, minted)
  return minted
}

/**
 * 官方 OpenCode v2.0.26 CLI 逐字一致的工具定义。
 * ⚠️ 上游对 description 与 parameters 严格比对，不可随意精简。
 */
export const ZEN_FINGERPRINT_TOOLS = Object.freeze({
  read: {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory to read',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'The line or directory entry to start reading from (1-based)',
          },
          limit: {
            type: 'integer',
            minimum: 0,
            description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  shell: {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command string to execute',
          },
          workdir: {
            type: 'string',
            description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.',
          },
          timeout: {
            type: 'integer',
            minimum: 0,
            description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.',
          },
          background: {
            type: 'boolean',
            description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
})

const ZEN_PLACEHOLDER_WARNING = 'Do not call the `read` or `shell` tools; they are placeholders that do nothing. Use the other tools you have been given instead.'

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

/**
 * 为请求体应用 OpenCode 免费车道门禁指纹。
 * 1. 注入 read 和 shell 官方工具声明；
 * 2. 避免 tool_choice: 'none'；
 * 3. 强制 stream: true；
 * 4. 补齐系统提示词说明。
 *
 * @param {object} body
 * @returns {Set<string>} names of the decoys this call added, so the caller can
 *   tell an injected placeholder apart from the caller's own tool of the same
 *   name. A name the request already declared is never in this set.
 */
export function applyZenFingerprint(body) {
  body.stream = true

  const tools = Array.isArray(body.tools) ? [...body.tools] : []
  const existingNames = new Set(tools.map(toolNameOf).filter((name) => name !== ''))

  const injected = new Set()
  if (!existingNames.has('read')) {
    tools.push(ZEN_FINGERPRINT_TOOLS.read)
    injected.add('read')
  }
  if (!existingNames.has('shell')) {
    tools.push(ZEN_FINGERPRINT_TOOLS.shell)
    injected.add('shell')
  }
  body.tools = tools

  // 必须清除 none
  if (body.tool_choice === 'none' || (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.type === 'none')) {
    delete body.tool_choice
  }

  // 若注入了占位工具，且提示词中尚未警告，添加说明
  if (injected.size > 0) {
    if (Array.isArray(body.messages)) {
      const hasWarning = body.messages.some((m) => typeof m.content === 'string' && m.content.includes(ZEN_PLACEHOLDER_WARNING))
      if (!hasWarning) {
        body.messages = [
          { role: 'system', content: ZEN_PLACEHOLDER_WARNING },
          ...body.messages,
        ]
      }
    }
  }

  return injected
}

/**
 * 组装满足 v2 门禁的全部请求头。
 *
 * @param {object} options
 * @param {string} options.session
 * @param {string} [options.apiKey]
 * @param {boolean} [options.stream=true]
 * @param {string} [options.accept]
 * @returns {Record<string, string>}
 */
export function zenGatewayHeaders({ session, apiKey, stream = true, accept }) {
  const token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : ZEN_POOLED_KEY
  const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`

  return {
    'content-type': 'application/json',
    'authorization': authHeader,
    'user-agent': ZEN_CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': 'global',
    'accept': accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
}

/**
 * 判断一个模型 ID 是否属于 OpenCode Zen 的免费模型。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isZenFreeModel(id) {
  if (typeof id !== 'string') return false
  const lower = id.toLowerCase()
  return lower.endsWith('-free') || lower === 'big-pickle' || lower.includes('/free')
}

/**
 * 容量未知时的保守回退值。
 *
 * 取自 opencode CLI 自己的 `Model.Info` 默认值（`{ context: 200000, output: 32000 }`），
 * 而不是随手编一个「大方」的数字：报大了会让调用方把超长提示送进上游，
 * 换来一个 400，而不是在本地就被截断。真实容量由 `zen-catalogue.js` 从官方目录
 * 取，这里只负责「目录里查不到」的那一格。
 */
export const ZEN_CAPACITY_FALLBACK = Object.freeze({
  contextWindow: 200000,
  maxTokens: 32000,
})

/**
 * 免费模型的离线元数据快照。
 *
 * ⚠️ 这只是**目录取不到时的降级表**，不是真值来源。数值抄自
 * `https://models.dev/api.json` 的 `opencode` provider（2026-10-23 抓取），
 * 运行时优先使用 `zen-catalogue.js` 解析出来的在线目录。
 *
 * 历史教训：本表曾把 Go 车道的容量（1M 上下文 / 384k 输出）当成免费模型的容量，
 * 而免费模型实际只有 200k / 32k —— 两者相差一个数量级，界面上的数字因此全是错的。
 *
 * `jev-1.13-free` 在官方目录里没有条目（网关列表有、目录未收录），故此处不给数字，
 * 让它走 {@link ZEN_CAPACITY_FALLBACK}，而不是替它编一个。
 */
export const ZEN_FREE_PRESETS = Object.freeze({
  'deepseek-v4.1-flash-free': {
    name: 'DeepSeek V4.1 Flash Free',
    contextWindow: 200000,
    maxTokens: 32000,
    vision: true,
  },
  'glm-5.3-flash-free': {
    name: 'GLM-5.3-Flash Free',
    contextWindow: 200000,
    maxTokens: 32000,
    vision: true,
  },
  'nemotron-3.5-super-vl-free': {
    name: 'Nemotron 3.5 Super VL Free',
    contextWindow: 1048576,
    maxTokens: 131072,
    vision: true,
  },
  'nemotron-3.5-lightning-free': {
    name: 'Nemotron 3.5 Lightning Free',
    contextWindow: 262144,
    maxTokens: 262144,
    vision: false,
  },
  'mimo-v2.6-flash-free': {
    name: 'MiMo-V2.6-Flash Free',
    contextWindow: 200000,
    maxTokens: 32000,
    vision: true,
  },
  'big-pickle': {
    // 目录声明 context=200000 / input=160000；可用提示长度以更紧的 input 为准。
    name: 'Big Pickle',
    contextWindow: 160000,
    maxTokens: 32000,
    vision: false,
  },
  'flint-40b-free': {
    name: 'Flint 40B Free',
    contextWindow: 262144,
    maxTokens: 65536,
    vision: false,
  },
  'beam-free': {
    name: 'Beam Free',
    contextWindow: 1048576,
    maxTokens: 131072,
    vision: false,
  },
})
