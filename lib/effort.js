/**
 * Per-model thinking-effort ladders.
 *
 * The harness shows a thinking-strength control for a model only when the adapter
 * advertises a ladder, and it treats the level ids as opaque strings — so the ids
 * here are *our* vocabulary, while {@link wireEffort} later translates them into
 * what each model actually accepts.
 *
 * Every ladder below comes from that vendor's own documentation (read 2026-10-21),
 * not from probing the gateway. The important consequence: a single global ladder
 * is wrong, because these models disagree about both the set and the meaning:
 *
 *   - MiniMax M3/M3.1 accepts `low medium high xhigh max` and **cannot disable
 *     thinking**; the docs say `effort: "none"` returns 400, and omitted effort
 *     means `max`.
 *   - Kimi K3 accepts only `low high max` (default `max`) and always reasons.
 *   - DeepSeek V4 accepts `minimal low medium high xhigh max ultra`, but collapses
 *     several of them (`medium`→high, `xhigh`→high, `ultra`→max), so offering all
 *     seven would show the user controls that do nothing distinct.
 *   - GLM-5.3 / 5.3-Flash force thinking on; `low` and below do not exist.
 *   - Grok 4.6/4.7 accepts `low medium high xhigh`, defaulting to `high`.
 *   - GPT-5.6 accepts the full OpenAI set including `none`.
 *   - Qwen3.x uses a boolean `enable_thinking` plus an optional token budget, so
 *     its "ladder" is really on/off.
 *   - Claude takes `output_config.effort` and defaults to `high` when omitted.
 *
 * A model that is not in this table advertises **no** ladder. That is deliberate:
 * inventing a control that the model may reject is worse than showing none.
 *
 * @module effort
 */

/**
 * Level definitions, keyed by our stable level id.
 *
 * `name` is capitalised English, matching what the built-in pi-ai adapter reports
 * (`High`, `Medium`, …): the harness renders that string verbatim, and hand-written
 * Chinese names made the control inconsistent with every other provider's.
 *
 * `off` and `none` are **not** synonyms, and the distinction is load-bearing:
 *
 *   - `off` sends *no* thinking control at all. It is accepted by every model, but
 *     what it means depends on the vendor's default — "as little as possible" for
 *     OpenAI, but *maximum* for MiniMax, whose documented default is `max`. It is
 *     therefore labelled `Default`, not "off", because for half these families it
 *     turns thinking all the way *up*.
 *   - `none` sends the literal string `none`, which is a real request value that
 *     genuinely disables thinking — and which only the OpenAI family accepts.
 *     MiniMax and Grok answer `400 … requires adaptive thinking` to it.
 *
 * `wire.openai` is the value for `reasoning_effort` / `reasoning.effort` on the
 * OpenAI-shaped dialects. `wire.anthropic` is the value for `output_config.effort`.
 * `null` means "omit the field".
 */
const LEVELS = {
  off: { name: 'Default', description: '不发送思考参数，由模型按自己的默认值决定', wire: { openai: null } },
  none: { name: 'None', description: '显式关闭思考（仅 OpenAI 系接受）', wire: { openai: 'none' } },
  minimal: { name: 'Minimal', description: '最少思考', wire: { openai: 'minimal' } },
  low: { name: 'Low', description: '轻量思考', wire: { openai: 'low' } },
  medium: { name: 'Medium', description: '平衡', wire: { openai: 'medium' } },
  high: { name: 'High', description: '深度思考', wire: { openai: 'high' } },
  xhigh: { name: 'XHigh', description: '深度研究级思考', wire: { openai: 'xhigh' } },
  max: { name: 'Max', description: '该模型支持的思考上限', wire: { openai: 'max' } },
}

/**
 * Per-vendor ladders, matched by model-id prefix.
 *
 * Order matters: the table is scanned top to bottom and the first matching
 * `match` wins, so a specific family must precede a broader one.
 *
 * @type {{ match: RegExp, levels: string[], default: string|null, source: string }[]}
 */
const FAMILIES = [
  {
    // MiniMax: five levels, thinking cannot be disabled, omitted means max.
    match: /^minimax-/,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    default: 'max',
    source: 'platform.minimax.io — effort: low/medium/high/xhigh/max, default max, cannot disable',
  },
  {
    // Kimi K3 always reasons and offers three levels.
    match: /^kimi-k3/,
    levels: ['low', 'high', 'max'],
    default: 'max',
    source: 'platform.kimi.ai — kimi-k3: reasoning_effort low/high/max, default max',
  },
  {
    // Kimi K2.7-code always reasons; K2.6 is a plain on/off switch.
    match: /^kimi-k2\.7/,
    levels: ['off'],
    default: 'off',
    source: 'platform.kimi.ai — kimi-k2.7-code: thinking always on, no effort control',
  },
  {
    match: /^kimi-/,
    levels: ['off', 'medium'],
    default: 'medium',
    source: 'platform.kimi.ai — kimi-k2.6: thinking.type enabled/disabled only',
  },
  {
    // GLM-5.3 and 5.3-Flash force thinking on; the rest of the 5.x line is hybrid.
    match: /^glm-5\.3/,
    levels: ['low', 'high', 'max'],
    default: 'max',
    source: 'docs.z.ai — GLM-5.3 / 5.3-FLASH use forced thinking, low/high/max',
  },
  {
    match: /^glm-/,
    levels: ['off', 'low', 'high', 'max'],
    default: 'high',
    source: 'docs.z.ai — GLM-5.x hybrid thinking, low/high/max',
  },
  {
    // DeepSeek publishes seven request values that collapse onto three real ones;
    // offering all seven would show controls that behave identically.
    match: /^deepseek-/,
    levels: ['off', 'low', 'high', 'max'],
    default: 'high',
    source: 'api-docs.deepseek.com — minimal/low→low, medium/high/xhigh→high, max/ultra→max, default high',
  },
  {
    // Grok: four levels, default high.
    match: /^grok-/,
    levels: ['low', 'medium', 'high', 'xhigh'],
    default: 'high',
    source: 'docs.x.ai — reasoning.effort low/medium/high/xhigh, default high',
  },
  {
    // OpenAI: the only family here that can genuinely turn thinking off.
    match: /^gpt-/,
    levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    default: 'medium',
    source: 'developers.openai.com — reasoning_effort none/minimal/low/medium/high/xhigh/max',
  },
  {
    // Claude takes output_config.effort; omitting it means high.
    match: /^claude-/,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    default: 'high',
    source: 'docs.anthropic.com — output_config.effort low/medium/high/xhigh/max, default high',
  },
  {
    // Qwen3.x is a boolean switch plus an optional budget, not a level ladder.
    match: /^qwen/,
    levels: ['off', 'medium'],
    default: 'medium',
    source: 'help.aliyun.com — enable_thinking true/false, optional thinking_budget',
  },
  {
    // StepFun documents three levels.
    match: /^step-/,
    levels: ['low', 'medium', 'high'],
    default: 'medium',
    source: 'platform.stepfun.ai — three levels of reasoning effort',
  },
]

/**
 * The ladder for one model, or `undefined` when the family is unknown.
 *
 * @param {string} modelId
 * @returns {{ efforts: {id: string, name: string, description: string}[], defaultEffort: string|undefined, source: string }|undefined}
 */
export function ladderFor(modelId) {
  const id = typeof modelId === 'string' ? modelId.trim().toLowerCase() : ''
  if (id === '') return undefined
  for (const family of FAMILIES) {
    if (!family.match.test(id)) continue
    const efforts = family.levels.map((level) => ({ id: level, ...LEVELS[level] })).filter((effort) => effort.name !== undefined)
    // A single fixed level is not a choice. The harness needs at least one entry, and
    // showing one greyed-out rung for a model whose thinking cannot be adjusted is
    // pure noise — so such a family gets no `reasoning` field at all.
    if (efforts.length < 2) return undefined
    return {
      efforts,
      defaultEffort: family.levels.includes(family.default ?? '') ? family.default : efforts[0].id,
      source: family.source,
    }
  }
  return undefined
}

/**
 * The request value for one level on one dialect.
 *
 * Returns `undefined` for "send no thinking control", which is how {@link LEVELS}
 * spells `off` — and is the only spelling every model in the table accepts.
 *
 * @param {string} level - our stable level id.
 * @param {'openai'|'anthropic'} dialect
 * @returns {string|undefined}
 */
export function wireEffort(level, dialect = 'openai') {
  if (typeof level !== 'string' || level === '') return undefined
  const definition = LEVELS[level]
  if (definition === undefined) {
    // An unknown id is passed through unchanged: a deployment may name its own
    // level, and the gateway is the better judge of whether it is valid.
    return level
  }
  const wire = definition.wire[dialect] ?? definition.wire.openai
  return wire === null || wire === undefined ? undefined : wire
}

/**
 * The display name for a level id.
 *
 * A level the table does not know is capitalised from its own id, because a user
 * on the settings page may declare a level we have never seen (a vendor adds one,
 * or they are dialling a model through our route that this table predates). The
 * harness renders this string verbatim, so it must never be empty.
 *
 * @param {string} level
 * @returns {string}
 */
export function levelName(level) {
  const definition = LEVELS[level]
  if (definition !== undefined) return definition.name
  const text = typeof level === 'string' ? level.trim() : ''
  if (text === '') return 'Default'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The description shown beside a level, or a generic one for an unknown id. */
export function levelDescription(level) {
  return LEVELS[level]?.description ?? '自定义档位'
}

/**
 * Every level id this module knows, for tests and for validation.
 *
 * This is what the settings page offers in the level dropdown, in the order a
 * vendor's docs tend to list them (off first, then increasing effort).
 */
export const LEVEL_IDS = Object.freeze(Object.keys(LEVELS))

/**
 * Build a ladder from a user-declared level table.
 *
 * Shape mirrors {@link ladderFor} so the adapter can return either without the
 * harness seeing a difference. The wire value is **not** used here: the adapter
 * reports the ladder (ids and names) to the harness, while the request value is
 * resolved separately by {@link resolveWire}.
 *
 * A table with fewer than two rungs is refused — one fixed level is not a choice,
 * and the harness would render a lone greyed control.
 *
 * @param {Record<string, unknown>} declared - `{ levelId: wireValue }`.
 * @returns {{ efforts: {id: string, name: string, description: string}[], defaultEffort: string|undefined, source: string }|undefined}
 */
export function ladderFromDeclared(declared) {
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return undefined
  const entries = Object.entries(declared).filter(([level, wire]) => typeof level === 'string' && level !== '' && (typeof wire === 'string' || wire === null))
  if (entries.length < 2) return undefined
  const efforts = entries.map(([id]) => ({ id, name: levelName(id), description: levelDescription(id) }))
  // The first declared rung is the default: the page writes them in the order the
  // user arranged, so the first one is their stated preference.
  return { efforts, defaultEffort: efforts[0].id, source: '用户自定义' }
}

/**
 * The request value one level sends, honouring a user-declared table first.
 *
 * `null` means "send no thinking control" — the same spelling {@link LEVELS}
 * uses for `off`, and the reason this returns `undefined` rather than `null`.
 *
 * @param {string} level - the level id the harness selected.
 * @param {Record<string, unknown>|undefined} declared - the user's table, if any.
 * @returns {string|undefined}
 */
export function resolveWire(level, declared) {
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared) && level in declared) {
    const wire = declared[level]
    if (wire === null) return undefined
    if (typeof wire === 'string') return wire === '' ? undefined : wire
    return undefined
  }
  return wireEffort(level)
}

/**
 * The value a freshly added rung starts with, matching the official editor: the
 * level's own name, except `off`, which sends nothing.
 *
 * @param {string} level
 * @returns {string|null}
 */
export function defaultWireFor(level) {
  if (level === 'off') return null
  return wireEffort(level) ?? level
}

/** The families table, exposed read-only for tests. */
export const EFFORT_FAMILIES = Object.freeze(FAMILIES.map((family) => ({
  match: family.match,
  levels: Object.freeze([...family.levels]),
  default: family.default,
  source: family.source,
})))
