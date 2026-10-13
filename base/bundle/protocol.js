/**
 * protocol.js — 编程模式的协议文本（纯函数，零依赖，可单测）。
 *
 * 只做一件事：把「配置 + 当前阶段」渲染成注入给模型的提示段。
 * 不持有状态、不碰 I/O，方便 node --test 直接断言。
 *
 * 设计依据（来自实测与调研）：
 *   - 模型无法自路由，模式在首个请求就"路径承诺"锁定 → 分类与人格必须外部注入。
 *   - 反刍（反复怀疑自己）可靠"反跑题锚"压到思考 token 的 0.0–0.3%。
 *   - 深度与任务复杂度必须匹配 → 简单任务走快收敛，复杂任务走决策闭合。
 *
 * 分档：只有 **flash / pro** 两档，名字固定、模型自配（设置页可改 provider/model/推理强度）。
 *
 * 注意：本协议**不含长期记忆**。把任务写进长期记忆属于作弊，一律不做。
 */

/** 两个档位（名字固定，模型由用户在设置里配置）。 */
export const TIERS = Object.freeze(['flash', 'pro'])

/**
 * 按**推理强度档位**裁剪流程。
 *
 * 依据（ARES, arXiv:2603.07915, ICML 2026）：强度不是线性资源 ——
 * 恒定低强度会掉 20% 准确率，而**过度思考真实存在**（TAU-Airline 上高强度 38.0%
 * 反而低于中强度 42.0%）。所以低档位不该跑"审查 + 发散"这些高成本步骤：
 * 它们要多次派子代理，而低强度下这些子代理本身也推不动。
 *
 * 四个可裁剪的重型步骤（其余为**基础章节，任何档位都保留**）：
 *   发散  —— 派 2~3 个子代理各起一稿（最贵）
 *   跨验  —— 派 1 个子代理复现结论
 *   红队  —— 派 1 个子代理反对你
 *   收敛  —— 验收逐条核对 + 不许提前结束（纯文本，零 token）
 *
 * 基础章节（始终保留）：思考纪律 · 0 对齐 · 2 计划锁定 · 3 执行 · 4-1 自验。
 * 这些是"能用"的底线：去掉会退化成瞎猜、不问歧义、不用 edit、声称完成无证据。
 *
 * ⚠️ 键是**目录里的档位 id**（DSH 封闭集合）。用户要的 `ultra` 无法作为档位名，
 * 实际以 `max` 为 id、线上发 ultra，故这里 `max` 与 `ultra` 都给完整流程。
 */
export const FLOW_BY_TIER = Object.freeze({
  // 无/极简思考：不派任何子代理，也不强制收敛
  off: Object.freeze({ diverge: false, cross: false, red: false, converge: false }),
  minimal: Object.freeze({ diverge: false, cross: false, red: false, converge: false }),
  low: Object.freeze({ diverge: false, cross: false, red: false, converge: false }),
  // 中档：只保留收敛（从重型步骤里唯一的零成本项）
  medium: Object.freeze({ diverge: false, cross: false, red: false, converge: true }),
  // 高档：去掉发散（省 2~3 个子代理），但保留双重审查
  high: Object.freeze({ diverge: false, cross: true, red: true, converge: true }),
  // 极高 / 最强：完整流程
  xhigh: Object.freeze({ diverge: true, cross: true, red: true, converge: true }),
  max: Object.freeze({ diverge: true, cross: true, red: true, converge: true }),
  ultra: Object.freeze({ diverge: true, cross: true, red: true, converge: true }),
})

/** 读一个档位的流程能力；未知/缺失时退回**完整流程**（宁多不少，避免静默降级）。 */
export function flowForTier(tier, overrides) {
  const key = typeof tier === 'string' ? tier.trim().toLowerCase() : ''
  // 用户配置优先（设置页可为任意档位/任意模型改流程，不限于内置那 7 个档位名）
  if (overrides && typeof overrides === 'object' && Object.hasOwn(overrides, key)) return overrides[key]
  return FLOW_BY_TIER[key] ?? FLOW_BY_TIER.max
}

/**
 * 解析用户配置的**档位 → 流程**覆盖串。
 *
 * 为什么用紧凑字符串而不是对象：DSH 的设置页表单只支持标量字段，对象/数组会让
 * schemastery 的 volatile dict 行为变得难以预测；而且紧凑串在 YAML 里更好读好改。
 *
 * 语法（`;` 分档位，`,` 分能力）：
 *
 *     low=;medium=converge;high=cross,red,converge;xhigh=all;max=all
 *
 * - 能力名：`diverge`(发散) / `cross`(跨验) / `red`(红队) / `converge`(收敛)
 * - `all` = 四项全开；等号右边留空 = 四项全关
 * - 未列出的档位沿用内置默认（**不静默降级**）
 * - 无法识别的能力名**整条忽略**（宁可不改，也不要猜错）
 *
 * @param {unknown} raw 用户输入
 * @returns {Record<string, {diverge:boolean,cross:boolean,red:boolean,converge:boolean}>} 覆盖表（可能为空）
 */
export function parseFlowOverrides(raw) {
  const out = {}
  if (typeof raw !== 'string' || raw.trim() === '') return out
  const CAPS = ['diverge', 'cross', 'red', 'converge']
  for (const clause of raw.split(';')) {
    const eq = clause.indexOf('=')
    if (eq < 0) continue
    const tier = clause.slice(0, eq).trim().toLowerCase()
    const body = clause.slice(eq + 1).trim().toLowerCase()
    if (!tier) continue
    if (body === '' ) {
      out[tier] = { diverge: false, cross: false, red: false, converge: false }
      continue
    }
    if (body === 'all') {
      out[tier] = { diverge: true, cross: true, red: true, converge: true }
      continue
    }
    const want = new Set(body.split(',').map((s) => s.trim()).filter(Boolean))
    if ([...want].some((w) => !CAPS.includes(w))) continue
    out[tier] = {
      diverge: want.has('diverge'),
      cross: want.has('cross'),
      red: want.has('red'),
      converge: want.has('converge'),
    }
  }
  return out
}

/** 档位的用途说明（渲染进协议，告诉模型什么时候用哪档）。 */
const TIER_LABEL = {
  flash: '日常档：写码、跑命令、批量改动、搜索读码、常规验证',
  pro: '加强档：规划、架构决策、难题攻坚、红队复核与裁决',
}

/**
 * `reasoning_effort` 的**实际可用取值** —— 必须以实测为准，不能照抄适配器 schema。
 *
 * ⚠️ 刻意**不含 `off`**：DSH 适配器的 schema 里写了 `off`，但官方 API 对
 * `reasoning_effort=off` 直接回 422（实测）。照 schema 列清单等于教模型发一个
 * 必然被拒的值 —— 清单错了比没有清单更糟。
 */
export const REASONING_EFFORT_CHOICES = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
])

/** 合法的推理强度策略：`auto` = 模型按任务自选；`fixed` = 用配置里的固定值。 */
export const EFFORT_POLICIES = Object.freeze(['auto', 'fixed'])

/**
 * 主会话档位 → 子代理**推荐强度区间**。
 *
 * 用户要求（原话）："模型思考强度选择要根据我开局的思考强度决定，
 * 我档位设置的越高，那么模型选择子代理是也会偏向选更稳妥的选择
 * （比如用稍微高的思考强度），我选择档位低，子代理也就没必要开那么高，
 * 就默认偏向节省 token 的选择。"
 *
 * 为什么用"推荐区间"而不是**硬写死一个值**：
 *   ① `effortPolicy = auto` 的立命之本就是"让模型按任务难度自己选"。
 *      插件若直接覆盖成固定值，模型的选择会被静默吃掉（源码已确证
 *      `resolveChildAgentOptions` 里模型的值优先，我们只能在
 *      `agent/request` 里覆盖，覆盖了就等于废掉 auto）。
 *   ② 子代理的活儿难度**互不相同**：同一次任务里可能既有"跑个测试"也有
 *      "重写并发模型"。用区间表达"偏好"，让模型在区间内按难度落点，
 *      既贯彻了主档位的基调，又不丢掉按任务微调的能力。
 *
 * 落点方向：高档位 → 整体上移（偏稳妥、宁愿多花）；低档位 → 整体下移
 * （偏省 token，不要为了小事顶格）。
 * 依据：ARES（arXiv:2603.07915）证明"恒定低强度"会掉 20% 准确率，
 * 而"过度思考"同样真实存在 —— 所以既要随主档位上移，也要有上限。
 */
export const SUBAGENT_EFFORT_BAND = Object.freeze({
  // 主档位很低：小事别开高，默认往省里选
  off: Object.freeze({ prefer: 'low', floor: 'none', ceil: 'medium' }),
  minimal: Object.freeze({ prefer: 'low', floor: 'none', ceil: 'medium' }),
  low: Object.freeze({ prefer: 'low', floor: 'none', ceil: 'medium' }),
  // 主档位中：常规实现按 medium 落，难才上浮
  medium: Object.freeze({ prefer: 'medium', floor: 'low', ceil: 'high' }),
  // 主档位高：偏稳妥，但**不顶格**（顶格实测会挤掉收敛）
  high: Object.freeze({ prefer: 'high', floor: 'medium', ceil: 'xhigh' }),
  // 主档位极高：下沿提到 high，上界到 xhigh
  xhigh: Object.freeze({ prefer: 'high', floor: 'high', ceil: 'xhigh' }),
  // 主档位最强（ultra）：允许探到 max（=线上 ultra），与 xhigh 明确区分开
  max: Object.freeze({ prefer: 'xhigh', floor: 'xhigh', ceil: 'max' }),
  ultra: Object.freeze({ prefer: 'xhigh', floor: 'xhigh', ceil: 'max' }),
})

/**
 * 读一个主档位对应的子代理推荐区间。
 *
 * 读不到档位时退回**中间偏省**（medium 区间）而不是最高档：
 * 主档位未知说明这次判不出来，此时"多花"没有依据，而"少花"只会略降质量。
 * 这与协议裁剪的取向刻意相反 —— 那里读不到就**给完整流程**，
 * 因为流程是零成本文本；这里读不到**不能顶格**，因为强度是真金白银。
 * @param {string} tier 主会话当前档位（目录里的 id）
 */
export function subagentEffortBand(tier, overrides) {
  const key = typeof tier === 'string' ? tier.trim().toLowerCase() : ''
  if (overrides && typeof overrides === 'object' && Object.hasOwn(overrides, key)) return overrides[key]
  return SUBAGENT_EFFORT_BAND[key] ?? SUBAGENT_EFFORT_BAND.medium
}

/**
 * 解析用户配置的**档位 → 子代理强度区间**覆盖串。
 *
 * 语法（`;` 分档位，`浮~顶@起手`）：
 *
 *     low=none~medium@low;medium=low~high@medium;high=medium~xhigh@high
 *
 * - `~` 左边是下沿、右边是上界；`@` 后是起手档（可省略，默认取下沿与上界的中间偏下）
 * - 档位名与强度名都不做白名单校验：**别的模型可能有 DS 没有的档位名**，
 *   而用户明确要求"其他模型不用适配，让用户在设置里调就行" —— 所以我们只透传，
 *   由用户按自己渠道的实际档位填写。这也是"有什么适配什么"的落地方式：
 *   **不强行改名，而是让用户按实际档位声明**。
 * - 语法坏的整条忽略（宁可不改，也不要猜错）
 *
 * @param {unknown} raw
 * @returns {Record<string, {floor:string,ceil:string,prefer:string}>}
 */
export function parseEffortBandOverrides(raw) {
  const out = {}
  if (typeof raw !== 'string' || raw.trim() === '') return out
  for (const clause of raw.split(';')) {
    const eq = clause.indexOf('=')
    if (eq < 0) continue
    const tier = clause.slice(0, eq).trim().toLowerCase()
    const body = clause.slice(eq + 1).trim()
    if (!tier || !body) continue
    const at = body.indexOf('@')
    const range = (at >= 0 ? body.slice(0, at) : body).trim()
    const preferRaw = at >= 0 ? body.slice(at + 1).trim() : ''
    const tilde = range.indexOf('~')
    if (tilde < 0) continue
    const floor = range.slice(0, tilde).trim().toLowerCase()
    const ceil = range.slice(tilde + 1).trim().toLowerCase()
    if (!floor || !ceil) continue
    out[tier] = { floor, ceil, prefer: preferRaw ? preferRaw.toLowerCase() : floor }
  }
  return out
}

/**
 * 把 `effortPolicy` 规整成两个合法值之一。
 *
 * **非法值一律退回 `auto`**（与 `tierPolicy` 同样的取舍）：配置是用户手写的文本，
 * 写错一个字母时退回 auto 最多是"没强制固定值"，比抛错或强制一个错的强度便宜得多。
 * 导出它是为了让 Host / preset 两个半侧与协议用**同一把尺**，避免三处口径分叉。
 * @param {any} value
 * @returns {'auto'|'fixed'}
 */
export function resolveEffortPolicy(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return EFFORT_POLICIES.includes(raw) ? raw : 'auto'
}

/**
 * 把档位配置渲染成一行路由描述；缺配置时明确写"未配置"，不静默省略。
 *
 * 两档行为**刻意不同**，因为它们是两种策略：
 *   - `fixed`：写出配置里的固定强度，模型直接照用（既有行为，一字不改）；
 *   - `auto`：**不写任何固定值**，改成让模型自己按任务难度选，并附上可选值清单。
 *     为什么不能既写固定值又说"自选"：那样模型会照抄固定值，"自选"形同虚设 ——
 *     这正是本项要修的问题。
 * @param {string} tier
 * @param {{provider?:string, model?:string, reasoningEffort?:string}} [route]
 * @param {'auto'|'fixed'} [effortPolicy]
 */
function tierLine(tier, route, effortPolicy) {
  const label = TIER_LABEL[tier] || tier
  const provider = route && route.provider ? String(route.provider).trim() : ''
  const model = route && route.model ? String(route.model).trim() : ''
  const effort = route && route.reasoningEffort ? String(route.reasoningEffort).trim() : ''
  if (!provider || !model) return `- **${tier}**（${label}）→ （未配置：请到设置页填写 provider 与 model）`
  if (effortPolicy === 'auto') {
    const choices = REASONING_EFFORT_CHOICES.join('/')
    return `- **${tier}**（${label}）→ provider=\`${provider}\`，model=\`${model}\`，`
      + `reasoning_effort=**由你按任务难度自选**（可选：${choices}）`
  }
  const effortPart = effort ? `，reasoning_effort=\`${effort}\`` : ''
  return `- **${tier}**（${label}）→ provider=\`${provider}\`，model=\`${model}\`${effortPart}`
}

/**
 * `auto` 模式下的选档指引（中文，简洁）。
 *
 * 两条设计意图：
 *   1. **给出具体档位到任务类型的映射**，否则"自选"等于把难题推给模型的直觉；
 *   2. 明确写"不确定就选中间档"。实测顶格会烧预算且会**挤掉收敛**
 *      （想得越久越容易反复怀疑自己），所以必须反向提醒，不能只说"选高的准没错"。
 */
function effortAutoGuide(tier, bandOverrides) {
  const band = subagentEffortBand(tier, bandOverrides)
  const from = typeof tier === 'string' && tier ? `（你本次开局的强度是 \`${tier}\`）` : ''
  return `

**推理强度怎么选**${from}

本次**建议区间：\`${band.floor}\` ~ \`${band.ceil}\`，按任务难度落点，常规从 \`${band.prefer}\` 起手**。
区间由"你开局选的档位"决定：开局档位高 → 整体偏稳妥；开局档位低 → 整体偏省 token。
**不要一律顶格** —— 顶格既烧预算，实测还会挤掉收敛（想得越久越容易反复怀疑自己）。

区间内怎么落：
- 简单任务（改字符串、加一行日志、跑命令）→ 取区间下沿
- 常规实现 → 取区间中点附近
- 架构、并发、迁移、难题攻坚、红队复核 → 取区间上沿`
}

/**
 * 任务分类：把首条真实用户消息映射到执行形态。
 * 纯字符串启发式——不调用模型，零延迟、零成本、可单测。
 * @param {string} text 首条真实用户消息
 * @returns {{form: 'build'|'fix'|'explore'|'ambiguous', complex: boolean, reason: string}}
 */
/**
 * 复杂度启发式：**长度 或 架构类关键词**。
 *
 * 为什么单独导出：子代理自动分档（preset.js）与任务分类必须用**同一把尺**，
 * 否则"主会话判为复杂、子代理却按简单分档"这种自相矛盾会出现。
 *
 * 注意：`220` 这个长度阈值是既有实测口径，改动会让 protocol.test.mjs 的
 * 「长文本判为复杂任务」用例口径漂移，改前请先跑一遍单测。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isComplexTask(text) {
  const t = typeof text === 'string' ? text.trim() : ''
  return t.length >= 220 || ARCH_RE.test(t)
}

/** 架构/系统性关键词 → 判为复杂任务。非 /g 正则：`test()` 不会改 lastIndex。 */
const ARCH_RE =
  /架构|重构|设计|迁移|升级|集成|协议|系统|性能|并发|安全|architect|refactor|migrat|design|integrat|protocol|concurren|securit/i

/**
 * 故障信号表（修复重心 → 先读后改）。
 *
 * 用 /g 是为了**计数**：只有"哪边信号多"才是可信判据，单纯 `test()` 无法
 * 区分"一个 bug 词"和"通篇都在讲报错"。计数法是 routing-suite 实测出来的
 * 口径（REACT_RE / SPEC_RE 计数对比），比"命中即定档"稳。
 */
const FIX_RE =
  /修复|修一下|报错|错误|失败|崩溃|不生效|异常|回归|坏了|bug|fix|error|fail|crash|broken|regress|stack ?trace/gi

/** 构建信号表（新建/实现 → 直接产出）。同样用计数法。 */
const BUILD_RE =
  /新增|添加|实现|写一个|做一个|开发|搭建|创建|生成|建一个|add|implement|create|build|write|make|scaffold|generate/gi

/** 数一个 /g 正则在一段文本里命中多少次（`matchAll` 不会污染 lastIndex）。 */
function countHits(regex, text) {
  let n = 0
  for (const _hit of text.matchAll(regex)) n += 1
  return n
}

/**
 * 任务分类：把首条真实用户消息映射到执行形态。
 * 纯字符串启发式——不调用模型，零延迟、零成本、可单测。
 *
 * 判据顺序（与既有行为保持一致的硬约束）：
 *   1. 故障信号 ≥ 构建信号且 >0 → `fix`（"实现的功能报错了"重心是修，不是建）
 *   2. 构建信号更多 → `build`
 *   3. 太短（<12 字）又没有动词 → `ambiguous`（弱带，交给"先分类再行动"指令）
 *   4. 其余 → `explore`
 *
 * @param {string} text 首条真实用户消息
 * @returns {{form: 'build'|'fix'|'explore'|'ambiguous', complex: boolean, reason: string}}
 */
export function classifyTask(text) {
  const t = typeof text === 'string' ? text.trim() : ''
  const complex = isComplexTask(t)

  const fixHits = countHits(FIX_RE, t)
  const buildHits = countHits(BUILD_RE, t)

  let form
  if (fixHits > 0 && fixHits >= buildHits) form = 'fix'
  else if (buildHits > fixHits) form = 'build'
  else if (t.length < 12) form = 'ambiguous'
  else form = 'explore'

  return {
    form,
    complex,
    reason: `form=${form} complex=${complex} len=${t.length} fix=${fixHits} build=${buildHits}`,
  }
}

/**
 * 渲染编程模式的常驻协议段。
 * @param {object} opts
 * @param {Record<string, {provider?:string, model?:string, reasoningEffort?:string}>} [opts.tiers] 档位 → 路由
 * @param {boolean} [opts.planGate] 是否启用计划门禁（强制拦截 write/edit）
 * @param {boolean} [opts.loopGuard] 是否启用循环守护
 * @param {string} [opts.taskEcho] 本轮任务回显（段尾）。默认空 = 不渲染这一块
 * @param {string} [opts.stageText] 当前阶段指引（段尾）。默认空 = 不渲染这一块
 * @param {string} [opts.statsFooter] 会话统计摘要（**最尾**，受独立开关 statsFooter 控制）
 * @param {'auto'|'fixed'} [opts.effortPolicy] 推理强度策略。
 *   **默认 `fixed`**：这是**纯函数级的兼容默认**，刻意与配置级默认（`auto`）不同 ——
 *   既有调用方（含不可改的 `protocol.test.mjs`）不传这个参数时，必须继续得到
 *   "写出配置固定强度"的旧文本，否则一批既有用例会因默认值漂移而变红。
 *   生产路径上 `preset.js` **总是显式传入**当前配置值，所以用户在设置页看到的
 *   默认行为仍然是 `auto`（模型自选）。
 * @returns {string}
 */
export function buildProtocol({
  tiers = {},
  planGate = true,
  loopGuard = true,
  taskEcho = '',
  stageText = '',
  statsFooter = '',
  effortPolicy = 'fixed',
  tier = '',
  // 用户可配置的档位映射（设置页里填）。空串/坏语法 → 全用内置默认，
  // 这样"不配置"的行为与加这个功能之前**逐字相同**。
  // 这是"其他模型不用适配、让用户自己调"的落地方式：插件只透传，不做白名单。
  flowByTier = '',
  effortByTier = '',
} = {}) {
  // 按档位裁剪流程：低强度下不派子代理做发散/跨验/红队（详见 FLOW_BY_TIER）。
  const flow = flowForTier(tier, parseFlowOverrides(flowByTier))
  const tierBlock = TIERS.map((t) => tierLine(t, tiers[t], effortPolicy)).join('\n')

  // auto / fixed 的差异**只**落在这两处（引导句 + 选档指引），其余协议正文逐字相同。
  // 这样"改成 auto"不会顺带改掉别的段落，回归面最小。
  const isAuto = effortPolicy === 'auto'
  const effortLead = isAuto
    ? '派发子代理时按档位传 `provider` + `model`（两者必须成对传），'
      + '**`reasoning_effort` 由你按任务难度自己选**（不要照抄某个固定值）：'
    : '派发子代理时按档位传 `provider` + `model`（两者必须成对传），需要时再传 `reasoning_effort`：'
  const effortGuide = isAuto ? effortAutoGuide(tier, parseEffortBandOverrides(effortByTier)) : ''

  // 易变内容（任务回显 / 阶段指引 / 统计摘要）**一律放段尾**：提示缓存按 token 前缀命中，
  // 把每轮都可能变的文字放在前面，会把整段静态协议一起顶出缓存。
  // 顺序即成本 —— 这条不是排版偏好，是钱。
  //
  // 统计摘要排在**最后**：它是三者里变化最频繁的（次数每次渲染都涨），
  // 放在最尾可让"顶出缓存"的代价只落在它自己这一小段上。
  const tail = [taskEcho, stageText, statsFooter].filter((s) => typeof s === 'string' && s.length > 0)
  const tailBlock = tail.length > 0 ? `\n\n${tail.join('\n\n')}` : ''

  return `## 编程模式

你处于**编程模式**。按下面的协议工作，不要跳步。协议的目的是消除三类常见失效：
想得太久（深度与任务不匹配）、反复怀疑自己（反刍）、只走一条思路（缺发散）。

### 思考纪律（省时间、反刍、防跑偏）

- **环境事实只能靠工具获取**，禁止靠推理猜目录、猜依赖、猜报错。要事实就调工具。
- 不要在推理里反复确认同一个决定；**信息够了就产出**。
- 每个推理块以**一个决定**或**一个待获取的信息**结尾。
- **深度匹配任务**：改字符串/加一行日志这类小事不要做架构推演；
  架构、并发、迁移、协议这类大事才深想边界与集成点。
- 拒绝"我好像做完了"式的收尾：完成必须有**命令输出或文件内容**当证据。
- **用简体中文回复用户**；代码、命令、文件路径、报错原文保持原样不翻译。

### 0 · 对齐

- 需求有歧义 → 先用 \`ask_user_question\` 问清，**不要猜**。
- 多步任务 → 先用 \`todo_write\` 外化计划。

${flow.diverge
    ? `### 1 · 发散（动手前，缺了这一步就会"上限不够高"）

非平凡任务必须**从至少两个独立角度各起一稿**，再比较取舍：

- **保守解**：最小改动，不动现有结构；
- **激进解**：更彻底的抽象或重写；
- **最简解**：能删就删，能不加就不加。

各稿要**在独立上下文的子代理里起草**（互不影响，避免互相污染），然后把结论收回来比较。
只采纳能对另外两稿说清"为什么不选你"的那个方案。`
    : `### 1 · 直奔方案（当前档位不做发散）

直接从最符合现有结构的那一个方案下手，不要为此另起多稿。`}

### 2 · 计划锁定（门禁）

计划必须写清四件事：**目标 / 验收标准（可测量）/ 步骤 / 风险**。

${
  planGate
    ? '> **门禁已强制生效**：用户处于计划模式时，`write` / `edit` 会被插件**直接拒绝**（不是提醒，是真拦截）。\n> 先用 `exit_plan_mode` 把计划交给用户确认；用户确认后门禁自动解除，这时才动手。'
    : '> （计划门禁当前已关闭：可以直接动手。）'
}

### 3 · 执行

- 每步只做一件事，**做完立刻验证**（跑命令 / 读回文件），不要攒一大坨再验。
- **改已有文件一律用 \`edit\`（str_replace，精确替换），不要用 \`write\` 整文件覆盖。**
  \`write\` 只用于**新建**文件，或整个文件确实要重写。
  理由（有实测依据，不是风格偏好）：arXiv:2607.21674 的 3 模型 × 3 输出格式 × 6 任务
  × 20 次重复实验（4,013 次运行）发现 **DeepSeek 在 unified diff 上通过率 66%，
  显著高于整文件替换**，且"把一行修改写成整文件替换"是它识别出的主要失败机制之一
  （诊断为小改、执行成大改）。
  附带好处：精确替换只改上下文的一小段 → 前缀更稳、更省 token。
- 破坏性或不可逆操作（删文件、改配置、推远端）**先确认**。

### 4 · 验证${flow.cross || flow.red ? '（三重，别只信自己）' : '（自验）'}

1. **自验**：每步跑命令看真实输出，禁止"应该没问题"。${flow.cross
    ? `
2. **跨验**：关键结论交给独立子代理**重新复现一遍**，不要复用你自己刚跑过的结论。`
    : ''}${flow.red
    ? `
3. **红队**：交付前，让子代理**反对你一次**——找反例、边界、回归。`
    : ''}

${flow.converge
    ? `### 5 · 收敛

- **验收标准逐条核对**之后才算完成；有未达标项必须说清并继续。
${loopGuard ? '- 未达标且仍有余量时**不许结束回合**，继续推进；到达轮次上限要如实报告未完成的部分。' : ''}`
    : `### 5 · 收尾

- 做完当前这一步就如实汇报结果，不要额外展开验收仪式。`}

### 工程卫生（写代码/改插件时的额外约束）

这几条在**改插件、改配置、装/卸插件**时特别容易踩，所以写在这里而不是全局 AGENTS.md ——
它们只在编码场景成立，别的模式背它们纯属浪费上下文。

- **改插件、改插件配置、装/卸插件、改 profile 补丁 —— 一律另开会话做**，不要在你正在
  干活的长会话里做。理由：这些操作会**改动系统提示词或工具面**，而前缀缓存按最长匹配前缀
  命中；在长会话中途改动，等于让本会话已缓存的前缀失效一次，代价与上下文体积成正比
  （实测 275K 时 $0.083、414K 时 $0.124 一次全量未命中）。
- **不要在长会话中途换模型**（换模型 = 换缓存域），要换就开新会话。
- **改动 profile / 插件后必须完全重启 DSH 才生效**，并告诉用户这件事；不要声称"已生效"。

### 档位（派发子代理时怎么选）

${effortLead}

${tierBlock}${effortGuide}

### 子代理工具怎么选（\`subagent\` vs \`subagent_fork\`）

**这是有确定的成本差异的，别随便选。** 两个工具的关键区别是**子代理能不能看到本会话**：

| | \`subagent\`（spawn） | \`subagent_fork\`（fork） |
|---|---|---|
| 上下文 | **全新**，看不到本会话 | **继承本会话已完成的所有轮次** |
| 前缀缓存 | 自己的新缓存域 | **复用本会话已缓存的前缀** |
| 何时用 | 任务**自包含**，不需要本会话的来龙去脉 | 任务**依赖本会话的上下文**（复核、续写、基于已讨论结论的分析） |

**选择规则**：
- 任务能在**一段话里说清**、不需要本会话背景 → 用 \`subagent\`（便宜、干净）。
- 任务**必须知道我们前面聊了什么**才能做 → 用 \`subagent_fork\`。
  它继承前缀，比"把上下文重新粘贴进 \`subagent\`"便宜得多；反过来，**只为了一个自包含任务去 fork，等于把整段对话重发一遍**。
- ⚠️ **fork 不能选模型**（DSH 硬约束：fork 继承父的 provider/model，为的是让复制过来的前缀**仍然命中缓存**）。所以 **fork 子代理跑的就是你现在的档**，不要试图给它传 provider/model。
- 需要**换档**（例如红队要用 pro）时 → 只能用 \`subagent\`。
- 需要**真正独立**的复核（跨验要求"不要复用你自己的结论"）→ 用 \`subagent\`，因为 fork 会继承你的判断，独立性更弱。

约束：
- **默认用 flash 档**。只有规划、架构、难题、红队这类"想清楚一次就值回票价"的步骤才切 pro 档。
- **图像/截图/视觉核对必须用支持图像的模型**（本环境中 pro 档若配的是纯文本模型则读不了图，务必用 flash 档或其它多模态模型）。
- 同一个子任务不要反复换档重试；换阶段（规划→执行→验证）才换档。
- 档位对应哪个模型由用户在设置里配置；上面写的就是当前生效值，直接照用。${tailBlock}`
}

/**
 * 渲染"近场引导"——与用户消息同请求注入，用于近距离纠偏。
 * @param {object} opts
 * @param {string} opts.form 任务形态
 * @param {boolean} opts.complex 是否复杂任务
 * @returns {string}
 */
export function buildNearFieldGuide({ form, complex }) {
  const head = '【编程模式 · 近距离引导】'
  if (!complex) {
    return `${head}简单任务：**一步到位**，不要展开长篇推演；做完立刻验证并收尾。`
  }
  const byForm = {
    fix: '先定位真实根因（读日志/复现），再改；改完必须复现一次证明修好了。',
    build: '先确认接口与落点，再动手；写完立刻跑一次真实调用验证。',
    explore: '先摸清现状（读码/列目录），再给判断；不要凭文件名猜内容。',
    ambiguous: '需求还不清：先问清再动手。',
  }
  return `${head}复杂任务：深入想**架构、边界、集成点**；不要把推理花在环境与工具上；信息齐了就产出；每个推理块以一个决定或一个信息需求结尾。${byForm[form] || ''}`
}

/* ---------------- 任务回显 / 首轮 persona / 阶段指引 ---------------- */

/** 任务回显的截断长度。太短说不清在做什么，太长会把段尾撑成本体。 */
export const TASK_ECHO_LIMIT = 160

/**
 * 渲染「本轮任务回显」——把首条真实用户任务文本挂进协议段尾。
 *
 * 为什么要回显：长会话里模型会逐渐被中间过程带跑（越走越偏），每轮都能看到
 * "在为哪件事工作"是最便宜的反跑题锚。用引用块，和工具输出在视觉上分开。
 *
 * @param {string} task 首条真实用户消息原文
 * @param {number} [limit] 截断长度，默认 {@link TASK_ECHO_LIMIT}
 * @returns {string} 空任务返回空串（= 不渲染这一块）
 */
export function buildTaskEcho(task, limit = TASK_ECHO_LIMIT) {
  const t = typeof task === 'string' ? task.replace(/\s+/g, ' ').trim() : ''
  if (!t) return ''
  const bound = Number.isFinite(limit) && limit > 0 ? limit : TASK_ECHO_LIMIT
  const shown = t.length > bound ? `${t.slice(0, bound)}…` : t
  return `### 本轮任务（每轮对照，不要跑题）\n\n> ${shown}`
}

/* ---------------- 会话统计摘要（C 项：让统计"看得见"） ---------------- */

/**
 * 统计摘要的长度上限（字符）。
 *
 * 为什么必须有上限：它挂在**系统提示**的段尾，而系统提示是最贵的一段上下文。
 * 数字会随会话变长而变宽（`9` → `1234`），没有上限的话一个长跑进程能把段尾撑到几百字符，
 * 白付 token。这里用"从后往前丢最不重要的字段"来裁剪，而不是硬截断 ——
 * 硬截断会留下半句话（`……门禁拦截 1`），比不显示更糟。
 */
export const STATS_FOOTER_LIMIT = 120

/**
 * 渲染「本次统计摘要」——把宿主侧的计数器折成一行 HTML 注释，附在协议段最尾。
 *
 * 为什么要塞进协议段：客户端**读不到**宿主服务（`ctx.remote` 的命名空间是 typert codegen
 * 编译期封闭的），所以计数器在设置页永远显示"不可读"。但模型**读得到**系统提示 ——
 * 把摘要写进协议段，用户问模型"插件统计怎么样"就有答案，这是当下唯一真正可行的通路。
 *
 * 取舍（必须写明）：这一行每次渲染都可能不同，会顶掉它自己之后的前缀命中。
 * 所以它由**独立开关 `statsFooter` 控制且默认关闭** —— 它是实验期观测工具，不该默认让所有人多付 token。
 *
 * 三条硬约束：
 *   1. **全零就不渲染**（返回空串）：没有数据时白占 token 是纯浪费；
 *   2. 总长 ≤ {@link STATS_FOOTER_LIMIT}：超了就从后往前丢字段（先丢最不重要的）；
 *   3. 不抛：任何畸形输入都退化成"不渲染"。
 *
 * @param {object} [stats] `codingModeSettings.stats()` 的快照（形状见 index.js）
 * @param {object} [opts]
 * @param {number} [opts.stage] 当前会话阶段 0..3（拿不到时不写这一段）
 * @returns {string} 空串 = 不渲染
 */
export function buildStatsFooter(stats, { stage } = {}) {
  try {
    const s = stats && typeof stats === 'object' ? stats : {}
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
    const tier = s.tierRouted && typeof s.tierRouted === 'object' ? s.tierRouted : {}

    const protocolRendered = num(s.protocolRendered)
    const guideInjected = num(s.guideInjected)
    const gateDenials = num(s.gateDenials)
    const flash = num(tier.flash)
    const pro = num(tier.pro)

    // 门禁驳回/放弃驳回也纳入"有数据"的判据：只有它们在涨时同样该让用户看得见。
    const deliveryBlocked = num(s.deliveryBlocked)
    const deliveryGiveUp = num(s.deliveryGiveUp)
    // 硬流程门（flowGate）驳回"跳过流程"的次数 —— 同样是"门真的动了"的证据。
    const flowBlocked = num(s.flowBlocked)

    const allZero =
      protocolRendered === 0 &&
      guideInjected === 0 &&
      gateDenials === 0 &&
      flash === 0 &&
      pro === 0 &&
      deliveryBlocked === 0 &&
      deliveryGiveUp === 0 &&
      flowBlocked === 0
    // 约束 1：全零就不追加（阶段本身不算"有数据"——它初始就是 0）
    if (allZero) return ''

    // 顺序即优先级：越靠前越重要，裁剪时从**后**往前丢。
    const parts = []
    parts.push(`协议渲染 ${protocolRendered} 次`)
    if (guideInjected > 0) parts.push(`引导 ${guideInjected} 次`)
    if (gateDenials > 0) parts.push(`门禁拦截 ${gateDenials} 次`)
    if (deliveryBlocked > 0) parts.push(`交付驳回 ${deliveryBlocked} 次`)
    if (deliveryGiveUp > 0) parts.push(`放弃驳回 ${deliveryGiveUp} 次`)
    if (flowBlocked > 0) parts.push(`流程门驳回 ${flowBlocked} 次`)
    if (Number.isInteger(stage) && stage >= 0) parts.push(`当前阶段 ${stage}`)
    if (flash > 0 || pro > 0) parts.push(`子代理分档 flash=${flash} pro=${pro}`)

    const head = '<!-- 本次会话统计：'
    const tail = ' -->'
    // 约束 2：超长就从后往前丢（保留最前面的"协议渲染"，它保证这一行永远非空且有意义）
    let kept = parts
    while (kept.length > 1 && (head + kept.join(' · ') + tail).length > STATS_FOOTER_LIMIT) {
      kept = kept.slice(0, -1)
    }
    return head + kept.join(' · ') + tail
  } catch {
    // 约束 3：统计是观测，绝不能因为渲染它把请求带崩
    return ''
  }
}

/**
 * 首轮 persona（按模型选型，不是按喜好选型）。
 *
 * 依据 routing-suite 的关键实测结论（P11 / P24，n=2~3）：
 *   - **弱带**（无法从文本判断任务类型）最优 persona 是**模型相关**的：
 *     `pro` → 规格句 + "先分类再行动"；`flash` → 中性身份 + "先分类再行动"
 *     ＋回顾已完成 / 别重复 / 别跑环境自检这类锚点（锚点对 flash 有正收益）。
 *   - **规格句在 flash 上会反向路由**（planGreen > 0）——所以绝不能把同一段
 *     文本无差别发给两档。
 *   - 对 `pro` 堆锚点反而有害（P24：suite-full 83% < naked 87.5%，而只加
 *     分类指引是 100%）——所以 pro 分支**刻意保持短**。
 *
 * 两档都带"先分类再行动"：这是弱带的核心指令，也是"模型无法自路由、
 * 分类必须外部注入"这条结论的落地。
 *
 * @param {object} opts
 * @param {'build'|'fix'|'explore'|'ambiguous'} [opts.form] 分类结果
 * @param {boolean} [opts.complex] 是否复杂任务
 * @param {string} [opts.model] 当前会话模型 id（用来判 flash 家族）
 * @returns {string}
 */
export function buildPersona({ form = 'explore', complex = false, model = '' } = {}) {
  const modelId = typeof model === 'string' ? model : ''
  // flash 家族判定：模型 id 里带 flash 即认为走 flash 最优型 persona。
  // 判不出来（空串/自定义名）时**按 flash 分支走**——它是更中性的那一版，
  // 而规格句错发给 flash 是实测有负收益的，宁可少要收益也不要引入损失。
  const isFlash = !/pro/i.test(modelId)

  const head = [
    '【编程模式 · 首轮策略】',
    '',
    isFlash
      ? '你是一名务实的软件工程师。**动手前先判定任务类型**（构建 / 修复 / 探索），再采用对应做法：构建 → 直接产出可运行的东西；修复 → 先查清再动手。'
      : '你是一名务实的软件工程师。**动手前先判定任务类型**（构建 / 修复 / 探索），再采用对应做法：构建 → 直接产出；修复 → 先读后改。',
  ]

  if (isFlash) {
    // flash 专属锚点：实测对 flash 提完成率有效；对 pro 有害，所以只在这一支出现。
    head.push(
      '',
      '- 先简要回顾本会话**已经做完哪几步**，从断点接着做，**不要重复已完成的工作**。',
      '- 不要跑环境自检（`echo` / `whoami` / `uname` / `node --version` / `date`），也不要为了"了解环境"做穷举式 `grep`/`glob` 扫描。',
      '- 想清楚再产出：先把结论想明白，再一次性写下来。',
    )
  }

  const byForm = {
    fix: '本次是**修复**：先复现、先定位真实根因（读日志/读码），再改；改完必须再复现一次证明修好了。',
    build: '本次是**构建**：先确认接口与落点（谁调用、放哪、怎么验），再动手；写完立刻跑一次真实调用。',
    explore: '本次是**探索**：先摸清现状（读码/列目录/查依赖），再给判断；不要凭文件名猜内容。',
    ambiguous:
      '本次任务信息不足：**先判定任务类型**（构建 / 修复 / 探索）并说明依据；判定不了就问清，不要猜着开工。',
  }

  const lines = [...head, '', `- ${byForm[form] || byForm.explore}`]
  if (complex) {
    lines.push(
      '- 这是**复杂任务**：深入想架构、边界、集成点；每个推理块以**一个决定**或**一个待获取的信息**结尾，信息齐了就产出。',
    )
  }
  return lines.join('\n')
}

/* ---------------- 阶段（文本指引，不用 ctx.tools.restrict） ---------------- */

/**
 * 四个阶段的名字。顺序即推进方向，**只前进不后退**。
 * 与阶段指引一起渲染进协议段。
 */
export const STAGE_NAMES = Object.freeze(['了解/对齐', '拟合方案', '开发', '验证/交付'])

/** 阶段总数（0..3）。 */
export const STAGE_COUNT = STAGE_NAMES.length

/**
 * 每个阶段的**完成信号**——阶段推进只认这些工具，不认"感觉做得差不多了"。
 * 与 {@link advanceStage} 是同一份口径，导出便于单测与自证。
 *
 * 只有 0/1/2 有信号：**3 是终态**（验证/交付之后没有下一阶段），所以没有键 3。
 * 取不到信号的阶段（含终态）按"无信号"处理，不能直接把 undefined 当数组用。
 */
export const STAGE_SIGNALS = Object.freeze({
  0: Object.freeze(['ask_user_question', 'todo_write']),
  1: Object.freeze(['todo_write', 'exit_plan_mode']),
  2: Object.freeze(['write', 'edit']),
})

/**
 * 阶段指引正文（**中文，刻意比 routing-suite 的 STAGE_GUIDES 短一个数量级**）。
 *
 * 为什么不照抄它们的长度：那边每段两三千字，是把工具解锁清单、记忆操作、
 * 注意力回收、并行隔离全塞进同一段的结果。我们不锁工具（见下），也没有记忆
 * 操作，塞那么长只会稀释真正要强调的东西。
 */
const STAGE_GUIDES = Object.freeze([
  // 0 · 了解/对齐
  '**做什么**：先把事实拿到手（读码 / 列目录 / 看日志），再把需求拆成维度，'
    + '找出**真正会改变产出**的歧义。\n'
    + '- 能合理推断的：用一句话写明假设后继续（让用户有机会纠正）。\n'
    + '- 两种解释会实质改变结果的：用 `ask_user_question` 问**一个**聚焦问题，给出具体选项。\n'
    + '- 别欠问（全都自己假设），也别过问（无关紧要的也问）。\n'
    + '**完成标准**：假设已声明，或关键歧义已澄清；复杂任务用 `todo_write` 记下计划。',
  // 1 · 拟合方案
  '**做什么**：把做法定下来——覆盖边界情况，写清"做完"的标准与**验收口径**，'
    + '而不只是罗列步骤。非平凡任务**从至少两个角度各起一稿**再取舍（保守解 / 激进解 / 最简解）。\n'
    + '**完成标准**：方案已**决策闭合**（做什么 / 怎么落 / 怎么算成功），用 `todo_write` 外化；'
    + '需要用户拍板的，用 `exit_plan_mode` 交出去确认。',
  // 2 · 开发
  '**做什么**：每步只做一件事，**做完立刻验证**（跑命令 / 读回文件），不要攒一大坨再验。\n'
    + '- 只改必须改的地方，不要顺手重构无关代码。\n'
    + '- 破坏性或不可逆操作（删文件、改配置、推远端）**先确认**。\n'
    + '**完成标准**：改动已落盘，主路径能真实跑通。',
  // 3 · 验证/交付
  '**做什么**：把验收标准**逐条核对**，并且每一条都要有证据。\n'
    + '**交付门（硬要求，不是建议）**：任何"完成了 / 修好了"的声明都必须**附可核验的证据**——'
    + '文件确实存在（附路径）、命令确实跑过（附输出）、数值确实达标（附断言）。'
    + '**没有证据的完成声明一律视为未完成**，禁止"应该没问题""理论上可以"。\n'
    + '**红队要求**：交付前必须让**独立子代理反对你一次**——找反例、找边界、找回归，'
    + '不要复用你自己刚跑出来的结论。独立子代理要**真的派**（`subagent`，按档位选模型），不要自己脑内模拟。\n'
    + '**完成标准**：验收标准逐条有证据地核过；有未达标项必须说清并继续，不许藏。',
])

/**
 * 渲染「当前阶段指引」。
 *
 * **这里刻意不做工具门控**：routing-suite 用 `ctx.tools.restrict` 按阶段裁剪
 * 工具面，我们不复制这个代价 —— restrict 会改变工具 schema 集合，等于改变
 * 请求前缀，直接击穿 prompt 前缀缓存。本项目实测**缓存失效占全部花费的 63%**，
 * 单次失效 $0.08–0.12，比"少几个工具"贵得多。所以阶段只做**文本指引**，
 * 工具面全程保持不变。
 *
 * @param {number} stage 阶段序号 0..3
 * @param {object} [opts]
 * @param {'build'|'fix'|'explore'|'ambiguous'} [opts.form] 任务形态（影响措辞）
 * @returns {string}
 */
export function buildStageText(stage, { form } = {}) {
  const idx = Number.isInteger(stage) ? Math.min(Math.max(stage, 0), STAGE_COUNT - 1) : 0
  const name = STAGE_NAMES[idx]
  const guide = STAGE_GUIDES[idx]
  // 终态（idx 3）没有完成信号 —— 这里必须容错，否则最后一个阶段的指引整段渲染不出来
  // （而渲染失败会被上层"绝不抛"的兜底吞掉，表现成"阶段 3 没有指引"这种难查的静默降级）。
  const signals = STAGE_SIGNALS[idx] ?? []
  const next = idx + 1

  const signalList = signals.map((s) => '`' + s + '`').join(' 或 ')
  const advanceLine =
    idx >= STAGE_COUNT - 1
      ? '**这是最后一个阶段**：验收标准逐条有证据地核完之后才算完成。'
      : '**推进方式**：调用 ' + signalList + ' 即视为本阶段完成信号，会自动进入阶段 '
        + next + ' · ' + STAGE_NAMES[next] + '。**没有完成信号就不会推进**——'
        + '阶段是自路由状态，光"用了工具"不算，必须给出完成信号。'

  const formLine =
    form && form !== 'explore' && idx === 0 ? `\n> 本会话首轮判定的任务形态：**${form}**。` : ''

  return `### 当前阶段：${idx} · ${name}${formLine}\n\n${guide}\n\n${advanceLine}`
}

/**
 * 阶段推进（纯函数，单步、幂等、只前进）。
 *
 * 完成信号驱动（与 routing-suite 的 `autoAdvance` 同思路，但 2→3 改用它没用的
 * "首次真实写盘成功"）：
 *   0→1：`ask_user_question`（已澄清）或 `todo_write`（已外化计划）
 *   1→2：`todo_write`（计划已记录）或 `exit_plan_mode`（计划已交用户拍板）
 *   2→3：首次 `write` / `edit` **成功**
 *
 * **一次调用最多推进一级**：同一个 `todo_write` 不能把 0 直接顶到 2。
 * 这样重放会话事件能得到与首次执行完全一致的结果（resume-safe 的前提）。
 *
 * ⚠️ **`ok` 对每一级都生效，不只 write/edit**（流程完整性，Task A2）：
 * 一条**报错**的命令什么都没完成，不该被当成"这一步做完了"。
 * 早期版本只让 2→3 看 `ok`，于是"跑了个报错的 todo_write 也算规划完了"——
 * 那会让流程在报错时静默跳步。
 *
 * @param {number} stage 当前阶段
 * @param {string} toolName 本次完成信号所属工具名
 * @param {boolean} [ok] 该调用是否成功（**所有**推进都要看这个）
 * @returns {number} 推进后的阶段（不会后退，也不会越级）
 */
export function advanceStage(stage, toolName, ok = true) {
  const s = Number.isInteger(stage) ? stage : 0
  if (s < 0 || s >= STAGE_COUNT - 1) return s

  const name = typeof toolName === 'string' ? toolName : ''
  if (!name) return s

  // 失败即"没有完成信号"：报错不得推进任何一级。
  if (ok === false) return s

  if (s === 0 && (name === 'ask_user_question' || name === 'todo_write')) return 1
  if (s === 1 && (name === 'todo_write' || name === 'exit_plan_mode')) return 2
  if (s === 2 && (name === 'write' || name === 'edit')) return 3
  return s
}

/* ---------------- 计划门禁判定（纯函数，便于单测） ---------------- */

/** 门禁默认拦截的工具：只拦真正的写操作，不拦 bash（计划期还要读日志/列目录）。 */
export const GATED_TOOLS = Object.freeze(['write', 'edit'])

/** 被拦截时返回给模型的理由。 */
export const GATE_REASON =
  '计划模式生效中（编程模式门禁）：先写清目标 / 验收标准（可测量）/ 步骤 / 风险，' +
  '用 exit_plan_mode 交给用户确认；用户确认前不允许 write / edit。'

/**
 * 计划门禁判定。
 *
 * 返回字符串 = 拒绝该次工具调用，字符串就是给模型的理由；返回 undefined = 放行。
 *
 * 关键取舍：**失败开放**。只有确定「门禁开着」且「计划模式确实生效」才拦截；
 * 任何一环不可判定（读不到 planMode 服务、读状态抛错）都放行，
 * 宁可少拦一次，也不能因为门禁读不到状态而把用户的工作卡死。
 *
 * @param {object} opts
 * @param {boolean} opts.planGate 门禁总开关
 * @param {string} [opts.toolName] 本次调用的工具名
 * @param {boolean|undefined} opts.planActive 计划模式是否生效（undefined = 不可判定）
 * @param {readonly string[]} [opts.gatedTools] 要拦的工具名
 * @returns {string|undefined}
 */
export function planGateDecision({ planGate, toolName, planActive, gatedTools = GATED_TOOLS }) {
  if (planGate !== true) return undefined
  if (typeof toolName !== 'string' || !gatedTools.includes(toolName)) return undefined
  if (planActive !== true) return undefined
  return GATE_REASON
}
