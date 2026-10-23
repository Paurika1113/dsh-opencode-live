/**
 * Per-model input capabilities.
 *
 * The gateway's `/models` listing carries no modality field — measured 2026-10-22,
 * it returns only `id`, `object`, `created` and `owned_by` — so image support cannot
 * be discovered, only declared. Two things declare it:
 *
 *   1. **The user's own choice**, stored per model on the settings page. This always
 *      wins, because the user is the one who finds out what actually works.
 *   2. **The table below**, which is measured rather than assumed.
 *
 * Anything absent from both starts as text-only. Guessing "vision" for an unknown
 * model would offer it an image it answers with 400; starting text-only only hides
 * a capability the user can turn back on with one click.
 *
 * @module capability
 */

/**
 * Models measured to genuinely read an image, not merely accept the request.
 *
 * The test is a control pair (`_probe/vision-catalogue.mjs`): the same question
 * against a solid-red and a solid-blue PNG. A `200` alone proves nothing — a model
 * that drops the image field still returns `200` — so a model only qualifies when it
 * answers "Red" to one and "Blue" to the other.
 *
 * Measured 2026-10-22 across all 37 models the gateway lists. Sixteen passed:
 * thirteen on the first pass, plus three that came back inconclusive at a small
 * token budget and passed on retry with 1200 (`_probe/vision-retry.mjs`).
 * `minimax-m3` is included on that retry's evidence: its earlier two "Red" answers
 * were empty `<think>` replies truncated by `max_tokens: 200`, not blindness.
 */
export const VERIFIED_VISION = Object.freeze(new Set([
  'claude-haiku-5-5',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'grok-4.6',
  'grok-4.7',
  'kimi-k2.7-code',
  'kimi-k3',
  'mimo-v2.5',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'minimax-m3',
  // Not in the pi-ai catalog snapshot at all — this is one of the models the whole
  // plugin exists to surface — but it reads images on both dialects.
  'minimax-m3.1-flash',
  'minimax-m3.1-flash-free',
  'qwen3.7-plus',
  'qwen3.8-flash',
  'qwen3.8-max',
]))

/**
 * Deliberately *not* listed, and why — so nobody re-adds them by reading the catalog.
 *
 * The pi-ai snapshot (`generatedAt: 2026-10-07T22:01:28.515Z`) claims all of these
 * take `["text", "image"]`. None could be measured from this machine, so none is
 * enabled by default; every one of them is also unusable here for an unrelated
 * reason, which is why the gap was never closed:
 *
 *   - `gpt-5.6-luna`, `gpt-6-luna`: 403 "Country, region, or territory not supported"
 *   - `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`: 403 "This model is
 *     not available in your country"
 *   - `longcat-2.5-preview-free`: 402 "Upstream request failed: Endpoint is
 *     unavailable." (needs credits)
 *
 * `minimax-m2.7` is the interesting exclusion: the catalog does *not* claim image
 * support, and the model confirms it — asked to look at a picture it answers "I'm
 * sorry, but I can't see the image". The chat-completions dialect rejects the
 * request outright with 400 "Model does not support this".
 *
 * @type {readonly string[]}
 */
export const EXCLUDED_UNVERIFIED = Object.freeze([
  'gpt-5.6-luna',
  'gpt-6-luna',
  'longcat-2.5-preview-free',
  'muse-spark-1.2-contributor',
  'muse-spark-1.3-contributor',
])

/**
 * Whether a model accepts images.
 *
 * @param {string} modelId
 * @param {Record<string, boolean>} overrides - the user's per-model choices.
 * @returns {boolean}
 */
export function visionFor(modelId, overrides = {}) {
  const id = typeof modelId === 'string' ? modelId.trim() : ''
  if (id === '') return false
  const chosen = overrides[id]
  if (typeof chosen === 'boolean') return chosen
  return VERIFIED_VISION.has(id)
}

/**
 * The `inputModalities` array the harness reads.
 *
 * @param {string} modelId
 * @param {Record<string, boolean>} overrides
 * @returns {string[]}
 */
export function inputModalitiesFor(modelId, overrides = {}) {
  return visionFor(modelId, overrides) ? ['text', 'image'] : ['text']
}

/** Every modality the harness understands, in the order a checkbox list shows them. */
export const MODALITIES = Object.freeze(['text', 'image'])

/**
 * The input modalities for one model, reading the full configuration.
 *
 * Two stored shapes mean the same thing and both must keep working, because the
 * older one is what an existing override file already contains:
 *
 *   - `modelSettings[id].inputModalities` — the newer, explicit checkbox list from
 *     the advanced panel. Present means the user stated the whole set, so it is
 *     obeyed verbatim (including "text only, even though the table says image").
 *   - `modelVision[id]` — the older boolean. Still honoured so a saved `false` is
 *     not silently forgotten when the newer panel appears.
 *
 * With neither, the measured table decides.
 *
 * @param {string} modelId
 * @param {{ modelVision?: Record<string, boolean>, modelSettings?: Record<string, { inputModalities?: string[] }> }} config
 * @returns {string[]}
 */
export function modalitiesFrom(modelId, config = {}) {
  const id = typeof modelId === 'string' ? modelId.trim() : ''
  if (id === '') return ['text']
  const declared = config?.modelSettings?.[id]?.inputModalities
  if (Array.isArray(declared) && declared.length > 0) {
    return MODALITIES.filter((name) => declared.includes(name))
  }
  return inputModalitiesFor(id, config?.modelVision ?? {})
}
