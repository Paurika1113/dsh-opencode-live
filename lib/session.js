/**
 * Stable per-conversation identifiers for the OpenCode gateway.
 *
 * The gateway requires `x-opencode-session` to carry one stable id per
 * conversation so it can route a turn to the backend holding that conversation's
 * prefix. Two properties matter, and they pull in opposite directions:
 *
 *   - stable across every request of one conversation, and across restarts, so
 *     the prompt cache is genuinely reused;
 *   - different for every conversation, so one conversation's routing and quota
 *     do not entangle with another's.
 *
 * A hard-coded profile header (the zero-code workaround) satisfies neither: it
 * is stable but globally shared. This module derives the value from the harness
 * session id, which is already exactly "one id per conversation", and shapes it
 * as a UUID — the form every verified live probe reported as accepted.
 *
 * Deriving rather than forwarding also keeps the conversation id from leaving
 * the machine.
 *
 * @module dsh-opencode-live/session
 */

import crypto from 'node:crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A well-formed RFC 4122 version 5 UUID, the shape this module produces. */
export const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Gateway-shaped request id: `msg_` + 12 hex + 14 base62. */
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * Domain separators. Scoping each digest to this plugin keeps derived ids from
 * colliding with the same seed digested by any other component on the same
 * machine (including the sibling `dsh-opencode-session` route, which derives an
 * id from the same conversation).
 */
const SESSION_NS = 'dsh-opencode-live'
const REQUEST_NS = 'dsh-opencode-live-req'

/** The seed used when the harness supplies no session identity at all. */
const GLOBAL_SEED = 'global'

/** One process-wide fallback id, for requests that carry no session identity. */
let anonymousSession = null

function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

/** 12 hex characters of time-derived prefix, matching the gateway's own shape. */
function timePrefix(timestamp = Date.now()) {
  const value = ~(BigInt(timestamp) * 0x1000n)
  let hex = ''
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Render 16 digest bytes as a name-based (version 5) UUID.
 *
 * The version and variant nibbles are set so the value is a well-formed UUID
 * rather than 32 hex characters that merely look like one — a gateway that
 * parses this header would then report a different failure from a merely
 * unrecognized id.
 *
 * @param {Buffer} bytes - at least 16 bytes of digest.
 * @returns {string}
 */
function uuidFrom(bytes) {
  const b = Buffer.from(bytes.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function derive(seed) {
  return uuidFrom(crypto.createHash('sha256').update(`${SESSION_NS}\0${seed}`).digest())
}

/**
 * Map one harness conversation onto one stable upstream session id.
 *
 * A pure function of the conversation id, so the same conversation always
 * yields the same id — in this process and the next one.
 *
 * @param {unknown} sessionId - `GenerateOptions.sessionId` for the request.
 * @returns {string} a stable UUID.
 */
export function sessionForConversation(sessionId) {
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : GLOBAL_SEED
  if (seed === GLOBAL_SEED) return (anonymousSession ??= derive(GLOBAL_SEED))
  return derive(seed)
}

/**
 * Mint a request id for one turn.
 *
 * A fresh id per user message, reused across retries of that turn, so the
 * gateway can collapse a retry onto the request it already saw. Passing
 * `turnSeed` (the user message id) makes that guarantee hold; omitting it falls
 * back to a time-derived id.
 *
 * @param {unknown} sessionId - the conversation's session id.
 * @param {unknown} [turnSeed] - a stable token for this turn.
 * @returns {string} a gateway-shaped `msg_` id.
 */
export function requestIdFor(sessionId, turnSeed) {
  if (typeof turnSeed !== 'string' || turnSeed === '') {
    return `msg_${timePrefix()}${base62From(crypto.randomBytes(14))}`
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${REQUEST_NS}\0${String(sessionId ?? '')}\0${turnSeed}`)
    .digest()
  return `msg_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
}
