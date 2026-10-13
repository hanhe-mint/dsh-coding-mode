/**
 * dsh-coding-mode — 编程模式 **Host 半侧**（顶层可寻址条目）。
 *
 * 为什么要有这一半：DSH 设置页的表单只认「可独立寻址的 profile 条目」
 * （`dsh-settings` 原话：Forms expose only volatile fields from active, uniquely
 * addressed profile entries）。插件一旦嵌在 preset 的 `plugins` 列表里，就不是这样的
 * 条目，它的 Config 在设置页永远看不到。所以配置搬到这里：
 *
 *   - **本文件（Host 半侧）**：由 bundle 补丁以顶层行插入，持有 16 个 `.volatile()`
 *     配置字段，并把当前生效值经 `codingModeSettings` 服务暴露出去。
 *     不注入提示段、不做门禁 —— 那件事在 preset 半侧做。
 *   - **`preset.js`（preset 半侧）**：preset 的 `plugins` 列表里的 `coding-mode` 行，
 *     注入协议段 + 计划门禁，通过 `ctx.get('codingModeSettings')` 读本文件的配置。
 *
 * 服务契约（两边靠这个字符串握手，改名字要同时改 `preset.js`）：
 *   ctx.get('codingModeSettings').read()
 *     → { tiers: { flash: {provider, model, reasoningEffort}, pro: {...} },
 *         planGate: boolean, loopGuard: boolean,
 *         stageGuide: boolean, taskEcho: boolean,
 *         nearFieldGuide: boolean, tierSubagents: boolean,
 *         protocolSection: boolean, tierPolicy: 'auto'|'flash'|'pro',
 *         statsFooter: boolean, stageRestrict: boolean }
 *   `read()` 每次调用都重新求值，所以设置页改完，下一个请求就是新值。
 *
 *   可观测性（本次新增，供 preset 半侧高频调用）：
 *     bump(key, by = 1)   计数白名单内的 key；未列出的静默忽略
 *     bumpClass(form)     'build' | 'fix' | 'explore' | 'ambiguous'
 *     setStage(sid, st)   阶段 0..3
 *     bumpTier(tier)      'flash' | 'pro'
 *     stats()             深拷贝快照（冻结），调用方改它污染不到内部状态
 *   这五个方法**绝不抛**、不做任何 I/O：preset 半侧在请求热路径上调它们，
 *   统计出错绝不能把请求带崩，所以非法输入一律静默丢弃。
 *
 * 设计边界（刻意的）：
 *   - **不注册任何模型可见的工具**，不给工具面增加负担。
 *   - **不做长期记忆**。把任务写进记忆文件属于作弊，一律不提供该功能。
 *   - 不做 persona 切换（模式在首个请求就路径承诺锁定，中途切换只会作废前缀缓存）。
 *   - 不追加自定义 session 事件（会话加载器只认白名单 type，未知 type 会让会话无法重开）。
 *   - 不落盘插件自有状态。
 *
 * 分档设计：只有 **flash / pro** 两档。档位名固定，**模型与推理强度全部由用户在设置页配置**
 * （provider / model / reasoningEffort 三项都是 .volatile()，改完下一个请求即生效）。
 */

import z from '@deepseek-ai/schemastery'
import { resolveEffortPolicy, TIERS } from './protocol.js'

export const name = 'dsh-coding-mode'

/**
 * Host 半侧不依赖任何必需服务。
 * 它只做两件自带兜底的加法：注册 `codingModeSettings` 服务、登记「本插件自带设置页」的策略。
 * `settings` 是可选依赖，走 `ctx.inject(['settings'], ...)` 子上下文，没有它插件照常工作。
 */
export const inject = []

/** Host 半侧注册的服务名（preset 半侧用同一个字符串读）。 */
export const SETTINGS_SERVICE = 'codingModeSettings'

/**
 * 设置页会编辑的 **18** 个字段名（顺序即展示顺序）。
 * 客户端页面用它来「结构识别」自己的配置命名空间，不靠硬编码 ns。
 *
 * ⚠️ 客户端 `client.js` 的 `IDENTITY_FIELDS` **刻意只取最早的 8 个**，不要跟着这张表扩：
 * 老 profile 补丁里只写了前 8 项，后 10 项靠 schema default 生效、不出现在补丁文本里；
 * 用 18 项去卡结构识别会让这类用户的 ns 识别失败（设置页报「找不到命名空间」）。
 */
export const SETTINGS_FIELDS = Object.freeze([
  'flashProvider',
  'flashModel',
  'flashReasoningEffort',
  'proProvider',
  'proModel',
  'proReasoningEffort',
  'planGate',
  'loopGuard',
  'stageGuide',
  'taskEcho',
  'nearFieldGuide',
  'tierSubagents',
  'protocolSection',
  'tierPolicy',
  'statsFooter',
  'stageRestrict',
  'flowGate',
  'effortPolicy',
  'flowByTier',
  'effortByTier',
])

/**
 * 配置。带 `.volatile()` 的字段会出现在设置页，可在线修改并持久化到 profile 补丁。
 *
 * 两档（flash / pro）各三项：provider、model、reasoningEffort。
 * 值用文本填写；可用值见 DSH 的模型选择器或 `list_subagent_models` 工具。
 * 留空 = 该项不下发给子代理（模型走默认）。
 */
export const Config = z.object({
  // ---- flash 档：日常写码 / 跑命令 / 批量改动 ----
  // 默认走**官方渠道**（`deepseek-official`）。实测官方前缀缓存稳定（8/8 不抖、
  // 命中率 88%~96%），中转站在带 tools 时 token 数会跳动导致缓存随机失效。
  // flash 档官方模型支持图像输入（inputModalities: text+image）。
  flashProvider: z.string().default('deepseek-official').volatile(),
  flashModel: z.string().default('deepseek-flash').volatile(),
  flashReasoningEffort: z.string().default('high').volatile(),

  // ---- pro 档：规划 / 架构 / 难题 / 红队 ----
  // ⚠️ 官方 `deepseek-v4-pro` **不支持图像输入**（inputModalities 默认只有 text），
  // 视觉类任务必须用 flash 档或其它多模态模型。
  // 它的缓存表现是四个模型里最好的（95%+）。
  proProvider: z.string().default('deepseek-official').volatile(),
  proModel: z.string().default('deepseek-v4-pro').volatile(),
  proReasoningEffort: z.string().default('high').volatile(),

  // ---- 行为开关 ----
  /** 计划门禁：计划模式下拒绝 write/edit。 */
  planGate: z.boolean().default(true).volatile(),
  /** 循环守护：把"未达标不结束回合"写进协议。 */
  loopGuard: z.boolean().default(true).volatile(),

  // ---- 提示段与路由开关（全部默认 true：默认行为＝全开，用户只做减法）----
  /** 阶段指引：在协议段里带上当前阶段（0..3）该做什么。 */
  stageGuide: z.boolean().default(true).volatile(),
  /** 任务回显：把首轮判定出的任务类型与阶段回显进上下文，避免中途跑偏。 */
  taskEcho: z.boolean().default(true).volatile(),
  /** 近场引导：只在最近几轮注入引导，避免长上下文里旧指引反向干扰。 */
  nearFieldGuide: z.boolean().default(true).volatile(),
  /** 子代理自动分档：按任务类型自动选 flash / pro，免去手工指定。 */
  tierSubagents: z.boolean().default(true).volatile(),

  // ---- A/B 实验开关（D 项：没有它就没法跑对照组）----
  /**
   * 协议段总开关。**关掉后完全不注入协议段**（对照组）。
   *
   * 关键：关掉它**不影响计划门禁** —— 门禁是 `tools.guard` 上的独立注册，
   * 与协议段是两条通路。所以可以「只关提示、留门禁」，正好用来做
   * 「协议段本身有没有用」的 A/B 对照。
   */
  protocolSection: z.boolean().default(true).volatile(),
  /**
   * 子代理分档策略。`auto` = 按任务复杂度自动判；`flash` / `pro` = **强制**所有子代理用这一档。
   *
   * 为什么用字符串而不是布尔：档位可能不止两档，用字符串描述"策略"不用改 schema
   * （加第三档时只需扩取值，不必新增字段）。非法值一律按 `auto` 处理。
   */
  tierPolicy: z.string().default('auto').volatile(),

  // ---- 实验期观测（C 项：默认关，开了才付 token）----
  /**
   * 会话统计摘要：把一行紧凑计数拼进协议段末尾，让**模型**能读到统计
   * （客户端读不到宿主服务，这是当下唯一可行的通路）。
   *
   * **默认 false**：它每次渲染都可能变，会顶掉自己之后的前缀命中；
   * 它是实验期观测工具，不该默认让所有人多付 token。
   */
  statsFooter: z.boolean().default(false).volatile(),

  // ---- 阶段硬门控（B 项：可选，默认关）----
  /**
   * 阶段硬门控：按当前阶段用 `tools.restrict` 裁剪工具面。
   *
   * **默认 false（保守）**：它会改变工具面（增删尾部工具只移动缓存边界，
   * 实测不击穿前缀，所以不再有"省缓存"的理由不启用）；之所以仍然默认关，
   * 是因为它多了一个**会变的状态源**（restrict 是交集语义，需要严格管理 disposer）
   * —— 这是复杂度取舍，不是性能取舍。
   */
  stageRestrict: z.boolean().default(false).volatile(),

  // ---- 硬流程门（B 项：可选，默认关）----
  /**
   * 硬流程门：把「流程」从文本指引变成**真门**。
   *
   * 打开后有三条硬约束（全部由 preset 半侧实现）：
   *   ① `tools.guard` 拒绝"没有计划信号之前的 write / edit"（计划前置门）；
   *   ② `tools.guard` 拒绝"阶段 3 且改完没验证时的 write / edit"（验证前置门）；
   *   ③ `agent/turn-stopping` 驳回"跳过阶段的收尾"（每会话有防死循环上限）。
   *
   * **默认 false（必须）**：它会拒绝工具调用、还会驳回轮次收尾 ——
   * 对已经跑顺的工作流是**打断式**的（老会话没有计划信号时，模型会突然写不了文件）。
   * 只有用户明确要"流程不许跳过"时才该打开。默认关 = 现有行为逐条不变。
   */
  flowGate: z.boolean().default(false).volatile(),

  // ---- 推理强度策略（C 项：新默认 = 模型自选）----
  /**
   * `reasoning_effort` 的来源策略：
   *   - `auto`（**新默认**）：协议里**不给固定强度**，改为列出可选值 + 选择指引，
   *     由**模型按任务难度自选**；子代理路由也不再覆盖模型选定的强度。
   *   - `fixed`：保持既有行为 —— 协议写出 `*ReasoningEffort` 的固定值，模型照抄，
   *     且子代理路由用该固定值覆盖继承来的强度。
   *
   * 为什么默认 auto：固定值会让"简单任务"和"难题"共用同一个强度（要么烧预算，
   * 要么深度不够），而实测顶格还会挤掉收敛。用字符串而不是布尔是为了将来能加第三档
   * （与 `tierPolicy` 同一取舍）。非法值一律按 `auto` 处理（见 `resolveEffortPolicy`）。
   */
  effortPolicy: z.string().default('auto').volatile(),

  /**
   * 档位 → **流程裁剪**的覆盖表。
   *
   * 格式（`;` 分档位，`,` 分能力）：
   *   `low=;medium=converge;high=cross,red,converge;xhigh=all;max=all`
   * 能力名：`diverge`(发散) / `cross`(跨验) / `red`(红队) / `converge`(收敛)；
   * `all` = 全开，等号右边留空 = 全关。**未列出的档位沿用内置默认。**
   *
   * 为什么做成可配置：用户明确要求"其他模型要和 DS 一样、不同档位有流程与强度的差异，
   * 差异和思考强度自己配置"。别的渠道可能有 DS 没有的档位名（例如只有 low/medium/high），
   * 所以这里**不做白名单校验**，只透传 —— 这才是"有什么适配什么"，
   * 而不是替用户把某个档位强行改名成另一个。
   *
   * 留空 = 与加这个字段之前的行为**逐字相同**。
   */
  flowByTier: z.string().default('').volatile(),

  /**
   * 档位 → **子代理强度区间**的覆盖表。
   *
   * 格式（`;` 分档位，`下沿~上界@起手`）：
   *   `low=none~medium@low;high=medium~xhigh@high;ultra=xhigh~max@xhigh`
   * `@` 可省略（默认起手 = 下沿）。同样不做档位名白名单 —— 见 `flowByTier` 的说明。
   *
   * ⚠️ 这里填的必须是**目标模型真实支持的档位**。若填了它没有的档位，
   * 提示词会建议模型用一个它发不出去的强度 —— 端点的表现可能是报错，也可能是
   * **静默忽略**（实测过某些中转站就是这样）。自查方法见 README。
   */
  effortByTier: z.string().default('').volatile(),
})

/**
 * 读一个配置值，兼容三种形态：可观察访问器 / 包装值 / 普通字面量。
 * volatile 字段在 apply 收到的 config 上是引用，用 `.get()` 读。
 * @param {any} cfg 配置对象
 * @param {string} key 字段名
 * @param {any} fallback 取不到时的兜底
 * @returns {any}
 */
function pick(cfg, key, fallback) {
  const raw = cfg?.[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'object') {
    if (typeof raw.get === 'function') {
      try {
        const v = raw.get()
        return v === undefined ? fallback : v
      } catch {
        /* 访问器读失败 → 落到 .value / fallback */
      }
    }
    if ('value' in raw) return raw.value === undefined ? fallback : raw.value
  }
  return raw
}

/** 从配置解析出两个档位的路由表。 */
function resolveTiers(cfg) {
  const tiers = {}
  for (const tier of TIERS) {
    tiers[tier] = {
      provider: String(pick(cfg, `${tier}Provider`, '') ?? '').trim(),
      model: String(pick(cfg, `${tier}Model`, '') ?? '').trim(),
      reasoningEffort: String(pick(cfg, `${tier}ReasoningEffort`, '') ?? '').trim(),
    }
  }
  return tiers
}

/** 合法的子代理分档策略（与 preset.js 的解释保持一致）。 */
const TIER_POLICIES = new Set(['auto', 'flash', 'pro'])

/**
 * 把 `tierPolicy` 规整成三个合法值之一。
 *
 * **非法值一律退回 `auto`**（而不是抛、也不是当成某一档）：
 * 配置是用户手写的文本，写错一个字母就强制所有子代理换成另一档，
 * 代价（贵模型烧钱 / 便宜模型做难题）远大于"忽略这个旋钮"。
 * @param {any} value
 * @returns {'auto'|'flash'|'pro'}
 */
function resolveTierPolicy(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return TIER_POLICIES.has(raw) ? raw : 'auto'
}

/** 当前生效配置快照。每次调用都重新读配置引用，所以永远是最新值。 */
function resolveSettings(cfg) {
  return {
    tiers: resolveTiers(cfg),
    // 布尔开关统一按「只有显式 false 才算关」求值：配置缺字段 / 读失败时退回默认开启。
    planGate: pick(cfg, 'planGate', true) !== false,
    loopGuard: pick(cfg, 'loopGuard', true) !== false,
    stageGuide: pick(cfg, 'stageGuide', true) !== false,
    taskEcho: pick(cfg, 'taskEcho', true) !== false,
    nearFieldGuide: pick(cfg, 'nearFieldGuide', true) !== false,
    tierSubagents: pick(cfg, 'tierSubagents', true) !== false,
    protocolSection: pick(cfg, 'protocolSection', true) !== false,
    tierPolicy: resolveTierPolicy(pick(cfg, 'tierPolicy', 'auto')),
    // 这两个开关**默认关**，所以判据必须是「只有显式 true 才算开」——
    // 与上面那组相反。读不到配置时退默认 false（实验工具不该默认生效）。
    statsFooter: pick(cfg, 'statsFooter', false) === true,
    stageRestrict: pick(cfg, 'stageRestrict', false) === true,
    // 硬流程门同样**默认关**（它会拒绝工具调用，默认开就是惊吓）：判据同样是「显式 true 才算开」。
    flowGate: pick(cfg, 'flowGate', false) === true,
    // 推理强度策略默认 auto（模型自选）。用 protocol.js 的同一个规整函数，
    // 保证 Host / preset / 协议三处口径一致。
    effortPolicy: resolveEffortPolicy(pick(cfg, 'effortPolicy', 'auto')),
  }
}

/* ────────────────────────── 运行统计（进程内内存，绝不落盘） ────────────────────────── */

/**
 * 计数白名单。
 * 用 Set 而不是数组：preset 半侧在请求热路径上高频调用 `bump`，
 * 而且**只认这些 key**——不在这张表里的 key 直接丢弃，避免拼错的名字把 stats 撑成脏字典。
 */
const COUNT_KEYS = new Set([
  'protocolRendered',
  'personaInjected',
  'guideInjected',
  'taskEchoed',
  'gateDenials',
  'gateAllows',
  'stageAdvances',
  // A 项：交付门从"提示"升级为"驳回"后新增的两个计数。
  // 二者互补：`deliveryBlocked` 记**真的驳回了**几次，
  // `deliveryGiveUp` 记**驳回到达上限后主动放行**了几次（防死循环的代价，必须可见）。
  'deliveryBlocked',
  'deliveryGiveUp',
  // B 项：硬流程门（flowGate）驳回"跳过流程"的次数。
  // 与 deliveryBlocked **分开计**：前者记"没计划就想收尾"，后者记"没验证就想交付"，
  // 两者口径不同；混在一起就看不出是哪一道门在起作用。
  'flowBlocked',
])

/** 任务分类的四个合法取值。 */
const CLASS_FORMS = new Set(['build', 'fix', 'explore', 'ambiguous'])

/** 分档的合法取值（与 protocol.js 的 TIERS 一致：只有两档）。 */
const TIER_KEYS = new Set(['flash', 'pro'])

/** 阶段取值范围 0..3（首轮判定 → 实现 → 验证 → 收尾）。 */
const STAGE_COUNT = 4

/**
 * `stageBySession` 的会话上限。
 * 这个 Map 的生命周期＝进程生命周期，而会话是无限的：不设上限就是一条缓慢的内存泄漏。
 * 200 足够覆盖「同时在跑的会话 + 刚跑完还在看的会话」，超出的按 LRU 丢掉。
 */
const MAX_TRACKED_SESSIONS = 200

/**
 * 造一个统计器。刻意做成闭包而非类：没有原型链、没有 `this`，
 * 方法可以被随便解构出去传给别人（preset 半侧就是这么用的）。
 * @returns 五个永不抛的方法
 */
function createStatsTracker() {
  const counters = Object.create(null)
  for (const key of COUNT_KEYS) counters[key] = 0
  const classified = { build: 0, fix: 0, explore: 0, ambiguous: 0 }
  const tierRouted = { flash: 0, pro: 0 }
  /** 会话 → 阶段。Map 保证插入顺序，正好用来实现「丢最旧」。 */
  const stageBySession = new Map()
  const startedAt = Date.now()

  /** 全零快照：`stats()` 自身出意外时的兜底，保证返回值形状永远一致。 */
  const zeroStats = () => ({
    protocolRendered: 0,
    classified: { build: 0, fix: 0, explore: 0, ambiguous: 0 },
    personaInjected: 0,
    guideInjected: 0,
    taskEchoed: 0,
    gateDenials: 0,
    gateAllows: 0,
    stageAdvances: 0,
    deliveryBlocked: 0,
    deliveryGiveUp: 0,
    flowBlocked: 0,
    stageBySession: {},
    tierRouted: { flash: 0, pro: 0 },
    startedAt,
  })

  return {
    /** 计数 +by（默认 1）。非白名单 key、非有限数一律静默忽略。 */
    bump(key, by) {
      try {
        if (!COUNT_KEYS.has(key)) return
        const step = by === undefined ? 1 : by
        if (typeof step !== 'number' || !Number.isFinite(step)) return
        const next = counters[key] + step
        // 夹在 0 以上：调用方万一传负数把计数减穿，也不该出现「-1 次渲染」这种荒谬读数。
        counters[key] = next > 0 ? next : 0
      } catch {
        /* 统计绝不能把请求带崩 */
      }
    },

    /** 任务分类计数。 */
    bumpClass(form) {
      try {
        if (!CLASS_FORMS.has(form)) return
        classified[form] += 1
      } catch {
        /* 同上 */
      }
    },

    /** 记录某会话当前阶段；stage 必须是 0..3 的整数。 */
    setStage(sessionId, stage) {
      try {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (!Number.isInteger(stage) || stage < 0 || stage >= STAGE_COUNT) return
        // 先删再插：把它移到 Map 末尾，于是淘汰的是**最久没更新**的会话（LRU），
        // 而不是「最早出现」的会话——长会话否则会因为开始得早就被丢掉。
        if (stageBySession.has(sessionId)) stageBySession.delete(sessionId)
        stageBySession.set(sessionId, stage)
        while (stageBySession.size > MAX_TRACKED_SESSIONS) {
          const oldest = stageBySession.keys().next()
          if (oldest.done) break
          stageBySession.delete(oldest.value)
        }
      } catch {
        /* 同上 */
      }
    },

    /** 分档路由计数。 */
    bumpTier(tier) {
      try {
        if (!TIER_KEYS.has(tier)) return
        tierRouted[tier] += 1
      } catch {
        /* 同上 */
      }
    },

    /**
     * 深拷贝 + 冻结快照。
     * 必须拷贝：调用方（设置页 / preset 半侧）拿到的是自己的副本，
     * 它怎么改都不会污染这里的计数器，也不会绕过白名单写入。
     * @returns 与契约一致的 stats 对象
     */
    snapshot() {
      try {
        const countersCopy = Object.create(null)
        for (const key of COUNT_KEYS) countersCopy[key] = counters[key]
        const stages = {}
        for (const [sessionId, stage] of stageBySession) stages[sessionId] = stage
        return Object.freeze({
          protocolRendered: countersCopy.protocolRendered,
          classified: Object.freeze({
            build: classified.build,
            fix: classified.fix,
            explore: classified.explore,
            ambiguous: classified.ambiguous,
          }),
          personaInjected: countersCopy.personaInjected,
          guideInjected: countersCopy.guideInjected,
          taskEchoed: countersCopy.taskEchoed,
          gateDenials: countersCopy.gateDenials,
          gateAllows: countersCopy.gateAllows,
          stageAdvances: countersCopy.stageAdvances,
          deliveryBlocked: countersCopy.deliveryBlocked,
          deliveryGiveUp: countersCopy.deliveryGiveUp,
          flowBlocked: countersCopy.flowBlocked,
          stageBySession: Object.freeze(stages),
          tierRouted: Object.freeze({ flash: tierRouted.flash, pro: tierRouted.pro }),
          startedAt,
        })
      } catch {
        return Object.freeze(zeroStats())
      }
    },
  }
}

/**
 * 插件入口（Host 半侧）。
 * @param {any} ctx
 * @param {any} config 该行的配置（结构见 Config）
 */
export function apply(ctx, config) {
  /**
   * 统计器在 `apply` 里建一次（一个插件实例 = 一份进程内计数）。
   * 刻意不落盘：这个插件不拥有任何磁盘状态，重启归零是设计选择，不是缺陷。
   */
  const tracker = createStatsTracker()

  /** 服务体：`read()` 每次重新求值 → 设置页改完，preset 半侧下一个请求就用新值。 */
  const service = Object.freeze({
    read: () => resolveSettings(config),
    fields: SETTINGS_FIELDS,
    // 计数接口。tracker 内部已经全程 try/catch，这里不再包一层：
    // 这几个方法在请求热路径上被高频调用，越薄越好。
    bump: (key, by) => tracker.bump(key, by),
    bumpClass: (form) => tracker.bumpClass(form),
    setStage: (sessionId, stage) => tracker.setStage(sessionId, stage),
    bumpTier: (tier) => tracker.bumpTier(tier),
    stats: () => tracker.snapshot(),
  })

  // ── ① 把配置暴露成服务（preset 子作用域通过作用域链读得到）──
  try {
    if (typeof ctx?.provide === 'function') {
      ctx.provide(SETTINGS_SERVICE, service)
    } else if (typeof ctx?.set === 'function') {
      // 兜底：老形态上下文（set 需要同名服务已 provide，失败也不影响插件）
      ctx.set(SETTINGS_SERVICE, service)
    }
  } catch {
    /* 提供失败不致命：preset 半侧会退回内置默认，插件照常工作 */
  }

  // ── ② 登记「本插件自带设置页」──
  // 官方 no-shipped-auto-renderer：autoGenerate 只对「按 schema 自动生成页面」的客户端有意义，
  // 我们自带可视化页面，所以按 dsh-settings README 的约定登记 auto:false。
  // 放在可选的 ctx.inject 子上下文里：没有 settings 服务时插件照常工作。
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['settings'], (child) => {
        child.effect(
          () => child.settings.configure({ auto: false }, ctx.fiber),
          'dsh-coding-mode: settings presentation policy',
        )
      })
    }
  } catch {
    /* 登记失败不影响插件：页面自己仍然能用 remote.settings 读写 */
  }
}
