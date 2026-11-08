/**
 * Optional proxy egress for the requests this plugin dials directly.
 *
 * The gateway sits behind a region check: an unproxied dial from a CN address
 * answers `403 This model is not available in your country` no matter how
 * correct the request is. `config.proxyUrl` points the plugin's gateway traffic
 * (listing, both chat lanes) at an HTTP proxy — in this deployment, the clash
 * instance on the NAS — while everything else keeps dialling direct.
 *
 * The dispatcher is undici's {@link ProxyAgent}; the plain global `fetch` honours
 * a `dispatcher` in its init, so the streaming call sites keep one response
 * shape whether or not a proxy is in play. undici resolves lazily: the plugin
 * runs either from the profile's node_modules (where undici lives) or, under
 * HMR, straight from the source tree (where it does not), and a deployment with
 * no proxy configured must not pay for resolving it at all.
 *
 * @module dsh-opencode-live/proxy
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolved undici module (or null), shared by every caller. */
let undiciPromise = null

/** ProxyAgent per proxy URL — reconnecting sockets should not be re-paid. */
const agents = new Map()

/** proxy URLs already complained about, so the warning fires once, not per request. */
const warned = new Set()

/** Where the last undici resolution ended up, for the /view diagnostic. */
export const undiciState = { status: 'unresolved', from: '', errors: [] }

/**
 * The directories whose `node_modules` may hold undici, in preference order.
 *
 * The plugin's own up-chain is hopeless in every mount shape: the junction into
 * the profile's node_modules is realpathed away by Node's ESM resolution, so
 * bare `import('undici')` walks up from the *source tree*, which has no
 * node_modules at all. The profile directories are where the harness itself
 * keeps undici — hence these explicit candidates. `DSH_PROFILE_DIR` names the
 * active profile when the host exports it; the well-known ones cover the rest.
 */
function profileCandidates() {
  return [
    process.env.DSH_PROFILE_DIR,
    join(homedir(), '.dsh', 'profiles', 'desktop'),
    join(homedir(), '.dsh', 'profiles', 'web'),
    join(homedir(), '.dsh', 'profiles', 'headless'),
  ].filter(Boolean)
}

/**
 * Resolve the undici module once.
 *
 * `import('undici')` answers when this file is loaded from somewhere with a
 * node_modules up-chain (rare); otherwise resolution walks the profile
 * candidates. `null` means no proxy support — direct dialling still works.
 *
 * @returns {Promise<object|null>}
 */
function loadUndici() {
  if (undiciPromise === null) {
    undiciPromise = (async () => {
      const errors = []
      try {
        const mod = await import('undici')
        undiciState.status = 'ok'
        undiciState.from = 'bare import'
        undiciState.errors = []
        return mod
      } catch (error) {
        errors.push(`bare import: ${String(error?.message ?? error)}`)
      }
      for (const profile of profileCandidates()) {
        try {
          const resolved = createRequire(join(profile, 'package.json')).resolve('undici')
          // Windows 的 ESM loader 只收 file:// URL，绝对路径会以 protocol 'c:' 被拒。
          const mod = await import(pathToFileURL(resolved).href)
          undiciState.status = 'ok'
          undiciState.from = profile
          undiciState.errors = errors
          return mod
        } catch (error) {
          errors.push(`${profile}: ${String(error?.message ?? error)}`)
        }
      }
      undiciState.status = 'missing'
      undiciState.from = ''
      undiciState.errors = errors
      return null
    })()
  }
  return undiciPromise
}

/**
 * The dispatcher for one proxy URL, or null when proxies are unavailable.
 *
 * Agents are cached per URL: a proxy change costs one new agent, an unchanged
 * one reuses its pooled sockets.
 *
 * @param {string} proxyUrl - the configured proxy, already normalized.
 * @param {object} [undiciMod] - injectable undici, for tests.
 * @returns {Promise<object|null>}
 */
export async function dispatcherFor(proxyUrl, undiciMod = null) {
  const mod = undiciMod ?? await loadUndici()
  if (!mod || typeof mod.ProxyAgent !== 'function') return null
  let agent = agents.get(proxyUrl)
  if (agent === undefined) {
    agent = new mod.ProxyAgent(proxyUrl)
    agents.set(proxyUrl, agent)
  }
  return agent
}

/**
 * One request's init, routed through the proxy when one is configured.
 *
 * An empty `proxyUrl` returns the init untouched — the no-proxy path must not
 * grow a `dispatcher` key, so callers cannot accidentally dial through a stale
 * agent. A configured proxy with no resolvable undici degrades to direct
 * dialling with one warning, because a failed to fetch models listing is
 * recoverable while a thrown one takes the whole route down.
 *
 * @param {string} proxyUrl - the configured proxy, or '' for direct.
 * @param {RequestInit} [init]
 * @param {{ undiciMod?: object, log?: (...args: unknown[]) => void }} [opts]
 * @returns {Promise<RequestInit>}
 */
export async function egressInit(proxyUrl, init = {}, opts = {}) {
  const url = String(proxyUrl ?? '').trim()
  if (url === '') return init
  const dispatcher = await dispatcherFor(url, opts.undiciMod)
  if (dispatcher === null) {
    if (!warned.has(url)) {
      warned.add(url)
      opts.log?.('[opencode-live] 代理 %s 不可用（找不到 undici/ProxyAgent），退回直连', url)
    }
    return init
  }
  return { ...init, dispatcher }
}

/**
 * `fetch` with the plugin's proxy egress applied.
 *
 * Drop-in for the call sites' bare `fetch(endpoint, init)`: same response
 * object, same streaming body, plus the dispatcher when a proxy is set. The
 * injectable `fetchImpl` keeps tests offline.
 *
 * 注：曾试过"用 dispatcher 所属的那份 undici 自己的 fetch 拨号"以求版本一致，
 * 实测流式输出变成出一段就停（2026-11-07），已回退到全局 fetch + dispatcher
 * 的混用形态——这是唯一验证过整段流式能完整吐字的方式；偶发的 terminated
 * 由 adapter 侧的 cause 链负责定位。
 *
 * @param {string} proxyUrl
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ fetchImpl?: typeof fetch, log?: (...args: unknown[]) => void, undiciMod?: object }} [opts]
 * @returns {Promise<Response>}
 */
export async function egressFetch(proxyUrl, url, init = {}, opts = {}) {
  return (opts.fetchImpl ?? fetch)(url, await egressInit(proxyUrl, init, opts))
}

/**
 * The most specific reason a `fetch` rejection carries, as one readable string.
 *
 * undici wraps every connection-level failure in a `TypeError: fetch failed` whose
 * own message names nothing — the actual fault sits on `cause`, one or more levels
 * down (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`, `CERT_HAS_EXPIRED`, …). A
 * proxy failure nests deeper still: `fetch failed` → the proxy's own status → the
 * real connect error.
 *
 * Without it the reader gets "fetch failed" and cannot tell a dead proxy port from
 * a missing DNS record or an expired certificate — the exact ambiguity that made
 * one real outage take a full investigation to attribute. Lives here, beside the
 * egress that produces these errors, so both the streaming adapter and the model
 * listing describe a failure the same way instead of each keeping its own copy.
 *
 * @param {unknown} error
 * @returns {string} e.g. `ECONNREFUSED 127.0.0.1:7890`, or '' when nothing is known.
 */
export function causeChainOf(error) {
  const parts = []
  const seen = new Set()
  let node = /** @type {any} */ (error)?.cause
  // Bounded: a self-referential or very deep chain must not hang a failed request.
  for (let depth = 0; node !== undefined && node !== null && depth < 5; depth += 1) {
    if (typeof node !== 'object' || seen.has(node)) break
    seen.add(node)
    const text = [node.code, node.message]
      .filter((part) => typeof part === 'string' && part !== '')
      // undici's own placeholder ("fetch failed") tells the reader nothing; the
      // deeper link is the one worth printing.
      .filter((part) => part !== 'fetch failed')
      .join(' ')
    if (text !== '') parts.push(text)
    node = node.cause
  }
  return parts.join(' ← ')
}

/**
 * In-process egress self-test, served on `/egress-selftest`.
 *
 * Answers whether the proxy actually carries a listing and a live SSE stream
 * *from inside this runtime* — the thing a curl from the same machine cannot
 * prove, because the failure mode was version skew between the runtime's
 * global fetch and the plugin's dispatcher, not the network path.
 *
 * @param {string} proxyUrl
 * @param {{ apiKey?: string, proxyEnabled?: boolean }} [opts]
 * @returns {Promise<object>} one result row per probe, including a mixed-dial
 *   (global fetch + this dispatcher) row kept deliberately for comparison.
 */
export async function egressSelftest(proxyUrl, { apiKey = 'public', proxyEnabled = true } = {}) {
  const proxy = String(proxyUrl ?? '').trim()
  // 开关关掉时 `active` 本来就是 ''，但原因不同：不是"没配地址"，是"用户关了"。
  // 两种都答 skipped，理由必须分开，否则页面会把用户的动作读成配置缺失。
  if (proxyEnabled === false) {
    return { skipped: true, reason: '代理开关已关闭（直连模式，无需自检）', proxyEnabled: false }
  }
  if (proxy === '') return { skipped: true, reason: 'proxyUrl 为空（直连模式，无需自检）' }
  const mod = await loadUndici()
  if (!mod || typeof mod.ProxyAgent !== 'function') {
    return { skipped: true, reason: 'undici 不可用', undiciState }
  }
  const dispatcher = await dispatcherFor(proxy, mod)
  const results = []

  const listing = (label, dial) => async () => {
    try {
      const resp = await dial('https://opencode.ai/zen/go/v1/models', {
        dispatcher,
        headers: { authorization: `Bearer ${apiKey}` },
      })
      const text = await resp.text()
      results.push({ test: label, status: resp.status, bytes: text.length, ok: resp.status === 200 })
    } catch (error) {
      results.push({ test: label, error: String(error?.message ?? error), cause: String(error?.cause?.message ?? '') })
    }
  }
  await listing('undici.fetch GET /models（版本一致）', mod.fetch)()
  await listing('global fetch GET /models（混用宿主 undici）', fetch)()

  try {
    const t0 = Date.now()
    const resp = await mod.fetch('https://opencode.ai/zen/go/v1/chat/completions', {
      dispatcher,
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-opencode-session': 'e2e-selftest-0000-4000-8000-000000000000',
      },
      body: JSON.stringify({
        model: 'crouton-alpha-free',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    if (resp.status !== 200) {
      const text = await resp.text()
      results.push({ test: 'undici.fetch POST chat (SSE)', status: resp.status, body: text.slice(0, 200), ok: false })
    } else {
      let events = 0
      let bytes = 0
      try {
        for await (const chunk of resp.body) {
          bytes += chunk.length
          events += (String(chunk).match(/\n\n/g) ?? []).length
        }
        results.push({ test: 'undici.fetch POST chat (SSE)', status: 200, bytes, events, ms: Date.now() - t0, ok: true })
      } catch (error) {
        results.push({
          test: 'undici.fetch POST chat (SSE)',
          status: 200,
          bytes,
          events,
          terminated: true,
          error: String(error?.message ?? error),
          cause: String(error?.cause?.message ?? error?.cause?.code ?? ''),
          ok: false,
        })
      }
    }
  } catch (error) {
    results.push({ test: 'undici.fetch POST chat (SSE)', error: String(error?.message ?? error) })
  }

  return { proxyUrl: proxy, undiciFrom: undiciState.from, results }
}
