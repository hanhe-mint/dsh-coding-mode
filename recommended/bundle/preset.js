/**
 * preset.js — 编程模式的「preset 半侧」= **任务编排行为层**（真正做事的插件）。
 *
 * 为什么拆成两半：DSH 设置页的表单只认「可独立寻址的 profile 条目」
 * （`dsh-settings` 原话：Forms expose only volatile fields from active, uniquely
 * addressed profile entries）。插件嵌在 preset 的 `plugins` 列表里时不是这样的条目，
 * 它的 Config 在设置页永远看不到。所以：
 *
 *   - 顶层条目 `coding-mode-settings` → `index.js`（Host 半侧）：持有 volatile
 *     配置字段，并把当前生效值经 `codingModeSettings` 服务暴露出来。它自己不做事。
 *   - preset 子条目 `coding-mode` → 本文件（preset 半侧）：本文件是**唯一**做事的
 *     地方 —— 首轮分类、persona 注入、近场引导、任务回显、阶段指引、交付门、
 *     子代理分档、计数上报。配置不在自己身上，而是每次从 `codingModeSettings`
 *     服务读（设置页改完，下一个请求就是新值）。
 *
 * 读取服务是「尽力而为」：作用域链看不到、服务没注册、方法不存在、调用抛错、
 * 返回值形状不对，**任何一种情况都退回内置默认继续工作，绝不抛**。
 * 这条是本插件的硬约束：插件崩了会把用户的会话一起带走，代价远大于功能缺失。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 行为层总览（10 件事，全部受设置页开关控制，缺服务时开关按内置默认走）
 *   ① 首轮任务分类        `agent/inbox/claimed` → classifyTask → bumpClass()
 *   ② persona 首轮注入    `agent/pre-step` → 每会话一次 → bump('personaInjected')
 *   ③ 近场引导            `agent/pre-step` → 每条真实用户消息一次 → bump('guideInjected')
 *   ④ 任务回显            协议段尾 → bump('taskEchoed')
 *   ⑤ 阶段指引            协议段尾（文本指引）→ setStage()
 *   ⑥ 交付门（**真门**）   `agent/turn-stopping` → 阶段 3 且无验证证据 → steer 驳回并拽回本轮
 *                         → bump('deliveryBlocked')；到上限放行 → bump('deliveryGiveUp')
 *   ⑦ 子代理分档          `agent/request` waterfall → tierPolicy 强制档 或 按复杂度自动判 → bumpTier()
 *   ⑧ 计数                协议段渲染 / 门禁拦截 / 门禁放行 / 阶段推进
 *   ⑨ 统计摘要            协议段最尾（独立开关 statsFooter，默认关）→ 让**模型**能读到计数
 *   ⑩ 阶段硬门控          `agent/pre-step` → `tools.restrict`（独立开关 stageRestrict，默认关）
 *   ⑪ 硬流程门            `tools.guard`（计划前置门 + 验证前置门）与 `agent/turn-stopping`
 *                         （流程不可跳过）—— 独立开关 flowGate，**默认关**。
 *                         为什么要这个开关：硬门会打断既有工作流（老会话里没有计划信号的
 *                         用户会突然写不了文件），所以只有用户明确要"硬"时才开。
 *
 * 开关默认值分三类，**不要混淆**：
 *   - 行为层开关默认 **开**（读不到服务也按开走，功能不缺席）；
 *   - 实验期开关 `statsFooter` / `stageRestrict` 默认 **关**（绝不被动进实验组）；
 *   - 硬流程门 `flowGate` 默认 **关**（它会拒绝工具调用、驳回轮次收尾 —— 默认开就是惊吓）。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 设计与实测依据：
 *   - 「模型无法自路由、模式在首个请求就路径承诺锁定」→ 分类与 persona 必须**外部注入**。
 *   - 按模型选 persona：pro 与 flash 的最优 persona 不同（见 protocol.buildPersona 注释）。
 *   - **不用 `ctx.tools.restrict` 做阶段门控**：改为**文本指引 + 完成信号驱动**。
 *     理由（2026-10 实验修正，原表述过强）：早期认为"工具面一动就换前缀缓存域"，
 *     实测并不成立——前缀缓存命中的是**最长匹配前缀**，工具列表在请求尾部，
 *     增删尾部工具只损失变化点之后的命中，前面的系统提示与历史照旧命中：
 *     官方 deepseek-flash 带 4 工具时 cached/prompt = 1020/1154（88%），
 *     删 1 个工具降到 896/1106（81%），恢复后立刻回到 1020（88%）。
 *     所以不用 restrict 的**真正**理由是**简洁与可控**（少一个会变的状态源、
 *     少一处 restrict 交集语义的坑），而不是"省缓存"。
 *     注意中转站（dieqiyun）上一切前缀行为都不可预测，见 AGENTS.md 的实测记录。
 *   - `agent/request` 只用来给**子代理**分档；主会话的模型一律不碰
 *     （换模型 = 换缓存域 = 整段上下文全价重发）。
 */

import {
  advanceStage,
  buildNearFieldGuide,
  buildPersona,
  buildProtocol,
  buildStageText,
  buildStatsFooter,
  buildTaskEcho,
  classifyTask,
  isComplexTask,
  planGateDecision,
  resolveEffortPolicy,
  STAGE_COUNT,
  STAGE_NAMES,
  TIERS,
} from './protocol.js'

export const name = 'dsh-coding-mode'

/** 本插件真正依赖的服务：提示段与工具守卫。 */
export const inject = ['tools', 'systemPrompt']

/**
 * Host 半侧注册的服务名。两边靠这个字符串握手（不引入跨文件共享模块，
 * 避免 preset 子作用域下的解析问题）。
 */
const SETTINGS_SERVICE = 'codingModeSettings'

/** 协议段 order 的兜底值（正常走 DSH 中央分配值，取不到才用）。 */
const FALLBACK_SECTION_ORDER = 700

/** 内置默认路由：读不到 Host 配置时用，保证插件照常工作。默认走官方渠道（缓存稳定）。 */
const BUILTIN_DEFAULTS = Object.freeze({
  flash: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }),
  pro: Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }),
})

/**
 * 会话状态表的上限。本表是**进程内缓存**，不是真相来源（真相永远在会话事件里），
 * 所以超出上限时直接丢最老的一条即可 —— 下次用到会自动从事件重建。
 * 为什么要上限：长跑进程里每个会话都留一条会缓慢泄漏。
 */
const SESSION_STATE_LIMIT = 200

/**
 * 单会话内 `guided` 集合的上限（去重"这条用户消息已注过近场引导"）。
 *
 * 为什么要单独设上限：这张集合**每个用户消息加一条，且永不清理** ——
 * 是本插件唯一会随会话长度**无界增长**的结构（sessions / restrictLift 都已设 200 上限）。
 * 实测估算：5000 条消息的会话约 0.5 MB（id 形态）～0.9 MB（文本兜底形态）；
 * 最坏情况 200 个长会话可达百 MB 量级，对长跑进程是真实的缓慢泄漏。
 *
 * 淘汰语义安全：丢掉最老的 key 只意味着**那条极早的消息若再次出现会被重复注入一次引导**，
 * 而"再次出现"在正常时序里不会发生（用户消息只被认领一次），所以这是纯防御性上限。
 */
const GUIDED_LIMIT = 500

/**
 * 插件注入消息的 source 标记。分类时会跳过它，避免把自己的引导当成"用户任务"。
 *
 * ⚠️ **必须是 `plugin:<插件名>`（producer-owned kind），不能用 `kind: 'plugin'`。**
 * v4 会话格式对此有硬校验（`dsh-session-format-v3-to-v4/lib/lib/index.js:126`）：
 *
 *   if (typeof value["kind"] !== "string" || value["kind"].length === 0
 *       || value["kind"] === "plugin")
 *     throw new SessionFormatError("format v4 message requires a producer-owned source kind");
 *
 * 官方对第三方插件的命名规则（同文件 `producerKind()`）：
 *   第一方插件用自身名字（plan-mode / tool-goal …），其余一律 `plugin:<插件名>`。
 * `kind:'plugin'` 是**已废弃的 v3 形状**，只在旧格式迁移器里被读取，运行时直接拒。
 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin:dsh-coding-mode' })

/** 本插件的注入消息 id 前缀（与 PLUGIN_SOURCE 一起用于识别"这条消息是我注的"）。 */
const PLUGIN_KIND = 'plugin:dsh-coding-mode'

/**
 * 判定"这条消息是不是本插件注入的"——兼容新形状与历史 v3 形状。
 *
 * ⚠️ 修过一个真实 bug：本函数原来比较 `source.plugin === PLUGIN_SOURCE.plugin`，
 * 而 v4 形状里**没有 `plugin` 键**，两边都是 `undefined` → **条件恒真**，
 * 守卫完全空转（任何 `user/message` 都会命中）。现在改为按 `kind` 判定。
 */
function isPluginSource(source) {
  if (!source || typeof source !== 'object') return false
  if (source.kind === PLUGIN_KIND) return true
  // 历史形状（v3）：{kind:'plugin', plugin:'dsh-coding-mode'} —— 仅为兼容旧会话日志。
  return source.kind === 'plugin' && source.plugin === 'dsh-coding-mode'
}

/**
 * 注入消息 id 的前缀：`coding-mode-<tag>-<时间戳>-<序号>`。
 * 带 tag 是为了**重启后能从事件日志里认出"哪一种"已经注过了**（见 foldEvents）。
 */
const PLUGIN_ID_PREFIX = 'coding-mode-'

/** 阶段完成信号涉及的引号内工具名（用于提示文本与事件解析的一致性）。 */
const WRITE_TOOLS = Object.freeze(['write', 'edit'])

/**
 * 「验证类」工具白名单 —— 交付门判定「有没有留下证据」只看这些。
 *
 * 为什么是这五个：它们的输出**全部是可核验的客观事实**（命令真实输出、文件真实内容、
 * 搜索结果真实命中、图像真实像素），而模型的自述不是。
 * 只列 `bash` / `read` / `grep` / `glob` / `read_image`，**刻意不含 `write` / `edit`**：
 * 「我又写了一遍」不是验证，「我读回来确认写对了」才是。
 */
const VERIFY_TOOLS = Object.freeze(['bash', 'read', 'grep', 'glob', 'read_image'])

/**
 * 「计划信号」工具 —— 成功的这些调用代表"会话里已经给过计划"，是 flowGate 前置门的解锁条件。
 *
 * 为什么正是这两个：它们**本身就是**阶段机 0→1 / 1→2 的完成信号
 * （`todo_write` = 计划已外化，`exit_plan_mode` = 计划已交用户拍板），
 * 与阶段口径同源，不引入第二把尺。
 * 第三个来源（用户处于计划模式）走 `planModeActive`，不在这个名单里。
 */
const PLAN_SIGNAL_TOOLS = Object.freeze(['todo_write', 'exit_plan_mode'])

/**
 * flowGate 的「流程不可跳过」每会话最多驳回几次。
 *
 * 与 {@link DELIVERY_BLOCK_LIMIT} **分开计数**，不复用同一个额度：
 * 若共用，几次"没有计划"的驳回会把额度吃光，等到阶段 3 真该拦"没验证"时门已经放弃了
 * —— 两道门的目标不同，各自的防死循环额度也必须独立。
 * 取 2 的理由与交付门一致：1 次太脆（模型第一次可能没看懂），3 次以上成本失控。
 */
const FLOW_BLOCK_LIMIT = 2

/**
 * 交付门每会话最多驳回几次（防死循环的硬上限）。
 *
 * 取 2 而不是 1 或 3：
 *   - 1 次太脆 —— 模型第一次可能没理解驳回理由，第二次通常就懂了；
 *   - 3 次以上成本明显失控（每次都真的多跑一整步模型请求）。
 * 到达上限后**放行并记一次 `deliveryGiveUp`** —— 宁可放过一个没验证的交付，
 * 也绝不允许插件把用户的会话卡成死循环。
 */
const DELIVERY_BLOCK_LIMIT = 2

/**
 * 按阶段裁剪工具面时的允许名单（仅当 `stageRestrict` 打开时使用）。
 *
 * 设计口径：**只收窄、不封锁**（每个阶段都保留读/搜/问/记这四类基础能力），
 * 因为阶段 0/1 的目标是"先看清楚、先想清楚再动手"，而不是"不许读文件"。
 * 阶段 3（终态）**不加限制**（返回 null = 释放 restrict，全量工具面开放）。
 */
const STAGE_RESTRICT_ALLOW = Object.freeze({
  0: Object.freeze(['read', 'grep', 'glob', 'read_image', 'bash', 'ask_user_question', 'todo_write']),
  1: Object.freeze(['read', 'grep', 'glob', 'read_image', 'bash', 'ask_user_question', 'todo_write', 'exit_plan_mode']),
  2: null, // 开发阶段要动文件，不做任何裁剪（null = 不设置 restrict）
  3: null, // 交付阶段全量开放
})

/** 合法的子代理分档策略。`auto` 之外的两档都是"强制"。 */
const FORCED_TIERS = Object.freeze(['flash', 'pro'])

/**
 * "声称完成"的措辞表 —— 只用来决定**要不要提醒补证据**，不参与任何判定。
 * 命中它本身不代表完成，恰恰相反：命中且其后没有任何工具证据 = 该提醒。
 */
const CLAIM_RE =
  /完成了|已修复|修好了|已改好|搞定了|都改好|已经好了|全部完成|完毕|搞定|做好|已实现|已加好|没问题|可以了|已解决|\bdone\b|\bfixed\b|\bcompleted\b|\bfinished\b|\bresolved\b/i

/* ═══════════════════════════ 服务读取（全部防御式） ═══════════════════════════ */

/** 取一个可选服务；取不到返回 undefined（绝不让插件因缺少可选依赖而激活失败）。 */
function optionalService(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/** 把一个值规整成非空字符串；不是字符串就返回空串。 */
function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 只接受严格的 `true` 才关；其它一切（undefined / 缺失 / 垃圾）都按开处理。 */
function switchOn(value) {
  return value !== false
}

/**
 * 只接受严格的 `true` 才算开；其它一切（undefined / 缺失 / 垃圾）都按**关**处理。
 *
 * 为什么需要与 {@link switchOn} 相反的这一版：`statsFooter` / `stageRestrict` 是
 * **实验期开关且默认关**（它们要么多付 token、要么多一个会变的状态源）。
 * 读不到服务时若按"开"处理，等于让所有人都被动进入实验组 —— 那是错的默认值。
 */
function switchOff(value) {
  return value === true
}

/**
 * 把服务给出的值规整成插件内部形状。
 * 任何字段缺失都补内置默认，任何非对象输入都整体退回默认。
 *
 * 默认值分三类，**必须分清**：
 *   - 行为层开关默认 **true**（读不到服务时也按 true 走，功能不缺席）；
 *   - 实验期开关（`statsFooter` / `stageRestrict`）默认 **false**（绝不被动进实验组）；
 *   - 硬流程门 `flowGate` 默认 **false**（它会拒绝工具调用，默认开就是惊吓）；
 *     而 `effortPolicy` 默认 **auto**（新默认 = 模型按任务自选强度）。
 * @param {any} raw
 */
function normalize(raw) {
  const tiers = {}
  const source = raw && typeof raw === 'object' ? raw : {}
  const rawTiers = source.tiers && typeof source.tiers === 'object' ? source.tiers : {}
  for (const tier of TIERS) {
    const fallback = BUILTIN_DEFAULTS[tier]
    const row = rawTiers[tier] && typeof rawTiers[tier] === 'object' ? rawTiers[tier] : {}
    tiers[tier] = {
      provider: text(row.provider) || fallback.provider,
      model: text(row.model) || fallback.model,
      reasoningEffort: text(row.reasoningEffort),
    }
  }
  // `tierPolicy` 只认三档；写错一个字母就强制所有子代理换档的代价太大，非法值一律退回 auto。
  const policy = text(source.tierPolicy).toLowerCase()
  return {
    tiers,
    planGate: switchOn(source.planGate),
    loopGuard: switchOn(source.loopGuard),
    // —— 行为层开关（默认开）——
    stageGuide: switchOn(source.stageGuide),
    taskEcho: switchOn(source.taskEcho),
    nearFieldGuide: switchOn(source.nearFieldGuide),
    tierSubagents: switchOn(source.tierSubagents),
    protocolSection: switchOn(source.protocolSection),
    tierPolicy: FORCED_TIERS.includes(policy) ? policy : 'auto',
    // —— 推理强度策略（C 项：默认 auto = 模型按任务自选）——
    // 复用 protocol.js 的同一个规整函数：Host 半侧、preset 半侧、协议渲染三处
    // 必须是**同一把尺**，否则会出现"设置页显示 auto、协议却按 fixed 渲染"这种鬼故事。
    effortPolicy: resolveEffortPolicy(source.effortPolicy),
    // —— 实验期开关（默认关）——
    statsFooter: switchOff(source.statsFooter),
    stageRestrict: switchOff(source.stageRestrict),
    // —— 硬流程门（B 项：默认关）——
    flowGate: switchOff(source.flowGate),
  }
}

/**
 * 读当前生效配置。优先走 Host 半侧的 `codingModeSettings` 服务；
 * 一切都拿不到时退回内置默认，不抛。
 * @param {any} ctx
 */
function readSettings(ctx) {
  try {
    const service = optionalService(ctx, SETTINGS_SERVICE)
    if (service && typeof service.read === 'function') return normalize(service.read())
  } catch {
    /* 服务读失败 → 用内置默认继续跑 */
  }
  return normalize(undefined)
}

/** 读计划模式当前是否对该会话生效；不可用/读失败返回 undefined（= 不可判定）。 */
function planModeActive(ctx, agent) {
  const session = agent?.session
  if (!session) return undefined

  // 首选：planMode 服务的已提交状态。
  const pm = optionalService(ctx, 'planMode')
  if (pm && typeof pm.loggedActive === 'function') {
    try {
      const v = pm.loggedActive(session)
      if (typeof v === 'boolean') return v
    } catch {
      /* 落到兜底路径 */
    }
  }

  // 兜底：直接读会话投影。
  // 背景：preset 里的 planning 组会 `isolate: { planMode: true }` 隔离出独立实例，
  // 挂在 preset 根上的插件不一定解析得到那个实例；而投影是按会话存的，
  // 走 sessionProjections.stateOf(session, 'plan') 拿到的是同一份事实。
  const projections = optionalService(ctx, 'sessionProjections')
  if (projections && typeof projections.stateOf === 'function') {
    try {
      const state = projections.stateOf(session, 'plan')
      if (state && typeof state.active === 'boolean') return state.active
    } catch {
      /* 两条路都不通 → 不可判定 */
    }
  }

  return undefined
}

/* ═══════════════════════════ 会话事件解析（纯读，防御式） ═══════════════════════════ */

/**
 * 读一个会话的**事件日志长度**，作为"日志有没有变长"的廉价探针。
 *
 * 为什么用它当探针：DSH 的 `Session` 有 `get seq() { return this.log.length }`，
 * 且源码注释明确写着这是 **`seq = log.length` 的连续性契约**。于是：
 *   - 判断"有没有新事件"只要比一个数字，**O(1)**；
 *   - 不必依赖"事件通知能不能送达本作用域"这类**我没能确证**的假设。
 * 一个 O(1) 探针就把"阶段会不会随会话推进"从**不确定**变成**确定**。
 *
 * @param {any} session
 * @returns {number|undefined} 取不到返回 undefined（调用方退化为"只扫一次"）
 */
function readSessionSeq(session) {
  try {
    const s = session?.seq
    if (typeof s === 'number' && Number.isFinite(s)) return s
  } catch {
    /* 落到 events.length */
  }
  try {
    if (Array.isArray(session?.events)) return session.events.length
  } catch {
    /* 探测不到就返回 undefined */
  }
  return undefined
}

/**
 * 读一个会话的事件日志。优先**增量读**，取不到就整段读。
 *
 * 增量读为什么可信：`snapshotEvents(fromSeq, toSeqExclusive)` 的实现就是
 * `this.log.slice(fromSeq, toSeqExclusive)`，而 `seq === log.length` 是契约，
 * 所以 `snapshotEvents(lastSeq, seq)` 恰好是"上次之后新增的那些"。
 * 这里仍然**校验返回长度**（`=== to - from`）：长度对不上就说明我对契约的理解
 * 在这个版本上不成立，立刻退回整段读 —— 宁可多花一次拷贝，也绝不漏事件。
 *
 * 关于 `snapshotEvents`：它已被官方标注 deprecated（"new calls are prohibited"），
 * 但它是**唯一**的同步全量读入口。用它换 resume-safe 的阶段派生，取舍见报告。
 * 全程 try/catch：会话形状随版本变动，任何异常都不许冒泡到 agent loop。
 *
 * @param {any} session
 * @param {number} [fromSeq] 只取该序号（含）起的新事件；不传 = 整段读
 * @returns {any[]}
 */
function readSessionEvents(session, fromSeq) {
  if (!session) return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      if (typeof fromSeq === 'number') {
        const to = readSessionSeq(session)
        if (typeof to === 'number' && to > fromSeq) {
          const delta = session.snapshotEvents(fromSeq, to)
          if (Array.isArray(delta) && delta.length === to - fromSeq) return delta
        }
      }
      const all = session.snapshotEvents()
      if (Array.isArray(all)) return all
    }
  } catch {
    /* 落到 events 数组 */
  }
  try {
    if (Array.isArray(session.events)) {
      return typeof fromSeq === 'number' ? session.events.slice(fromSeq) : session.events
    }
  } catch {
    /* 两条路都不通 → 视为"读不到"，调用方会退化为进程内状态 */
  }
  return []
}

/**
 * 从消息/事件 data 里抽出纯文本。
 * 兼容 `content` 是字符串数组、文本块数组，以及 `data.message` 的嵌套形状。
 * @param {any} payload
 * @returns {string}
 */
function messageText(payload) {
  if (!payload) return ''
  const inner =
    payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)
      ? payload.message
      : payload
  const content = Array.isArray(inner.content) ? inner.content : []
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/** 一个事件是不是「真实用户发来的消息」（插件注入的一律不算）。 */
function isRealUserEvent(event) {
  return (
    event?.type === 'user/message' &&
    event.data?.source?.kind === 'user'
  )
}

/** 取 `tool/call` 事件里的工具名；取不到返回空串。 */
function toolCallName(event) {
  if (event?.type !== 'tool/call') return ''
  const data = event.data
  if (!data || typeof data !== 'object') return ''
  const name = data.name ?? data.toolName
  return typeof name === 'string' ? name : ''
}

/**
 * 取 `tool/result` 事件关联的 callId；取不到返回 undefined。
 *
 * ⚠️ **必须兼容三种形状**，否则整条"结果驱动"的链路会**静默失效**
 * （阶段 2→3 永远推不上去、水线永远不升，而日志里看不出任何异常）：
 *   - `message.toolCallId` 与 `message.source.callId` —— **真实 DSH 的形状**。
 *     `dsh-llm` 的 `createToolResultMessage()` 只写这两个字段
 *     （`source: {kind:'tool', callId}` + `toolCallId: callId`），且 `dsh-session`
 *     的校验器硬要求 `message.toolCallId === message.source.callId`；
 *     已在本机 `ref-dsh-src` 与打包的 `app.asar` 上**双向确证**。
 *   - `message.callId` —— 真实形状里**不存在**这个字段。保留它只为兼容单测桩
 *     与更早形态的会话日志，**不能只认它**（原实现只认它，所以在真实会话里
 *     `name` 永远是 undefined：write/edit 的推进与水线实际上从未生效过）。
 * 探测顺序是"先真实形状、后兼容形状"：让兼容分支去兜底，而不是去掩盖真实问题。
 * @param {any} event
 * @returns {string|undefined}
 */
function toolResultCallId(event) {
  if (event?.type !== 'tool/result') return undefined
  const message = event.data?.message
  if (!message || typeof message !== 'object') return undefined
  const candidates = [message.toolCallId, message.source?.callId, message.callId]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

/* ═══════════════════════════ 插件入口 ═══════════════════════════ */

/**
 * 插件入口（preset 半侧）。
 * @param {any} ctx preset 子作用域上的插件上下文
 */
export function apply(ctx) {
  /**
   * 每次求值都重新读服务 —— 提示段的 text 是函数，所以设置页改完，
   * 下一个请求拿到的就是新值，不需要重注册。
   */
  const settings = () => readSettings(ctx)
  const planGateOn = () => settings().planGate

  /**
   * 注册一个事件监听，**注册失败也不许把插件带崩**。
   *
   * 为什么要包一层：`ctx.on` 不是所有上下文都有（老版本 ctx、单测桩、
   * 被裁剪过的作用域都可能没有它）。行为层是**增益**，不是插件的存在前提 ——
   * 少了它顶多少个功能，插件自己炸了会把用户的整个会话一起带走。
   * cordis 的 `ctx.on` 返回值本身就是托管的 disposer，不需要再套 effect。
   */
  function onEvent(event, handler) {
    try {
      if (typeof ctx?.on !== 'function') return
      ctx.on(event, handler)
    } catch {
      /* 注册失败 → 该事件驱动的行为静默缺席 */
    }
  }

  /* ---------------- 计数上报（全部静默跳过，绝不抛） ---------------- */

  /**
   * 调 `codingModeSettings.bump(key)`。
   * 服务不存在 / 方法不存在 / 方法抛错 → 全部静默跳过。
   * 计数是**观测**，不是功能：计数失败绝不该影响编排。
   */
  function bump(key, by = 1) {
    try {
      const service = optionalService(ctx, SETTINGS_SERVICE)
      if (service && typeof service.bump === 'function') service.bump(key, by)
    } catch {
      /* 计数失败不影响功能 */
    }
  }

  /** 调 `codingModeSettings.bumpClass(form)`。同上，静默。 */
  function bumpClass(form) {
    try {
      const service = optionalService(ctx, SETTINGS_SERVICE)
      if (service && typeof service.bumpClass === 'function') service.bumpClass(form)
    } catch {
      /* 计数失败不影响功能 */
    }
  }

  /** 调 `codingModeSettings.setStage(sessionId, stage)`。同上，静默。 */
  function setStage(sessionId, stage) {
    try {
      const service = optionalService(ctx, SETTINGS_SERVICE)
      if (service && typeof service.setStage === 'function') service.setStage(sessionId, stage)
    } catch {
      /* 上报失败不影响功能 */
    }
  }

  /** 调 `codingModeSettings.bumpTier(tier)`。同上，静默。 */
  function bumpTier(tier) {
    try {
      const service = optionalService(ctx, SETTINGS_SERVICE)
      if (service && typeof service.bumpTier === 'function') service.bumpTier(tier)
    } catch {
      /* 计数失败不影响功能 */
    }
  }

  /* ---------------- 会话状态（缓存；真相在会话事件里） ---------------- */

  /** @type {Map<any, {firstText: any, form: any, complex: boolean, model: string, personaDone: boolean, guided: Set<string>, stage: number, reportedStage: number, scanned: boolean, pendingWrites: Map<string,string>, awaitingEvidence: boolean, lastAssistantText: string, nudged: boolean, unverifiedWrite: boolean, deliveryBlocks: number, deliveryGaveUp: boolean, planSignaled: boolean, flowBlocks: number}>} */
  const sessions = new Map()

  /** 造一份空白会话状态。 */
  function freshSessionState() {
    return {
      firstText: undefined, // 首条真实用户消息原文（只记第一条）
      form: undefined, // 分类结果：build / fix / explore / ambiguous
      complex: false, // 是否复杂任务

      model: '', // 本会话当前模型 id（用于按模型选 persona）
      personaDone: false, // persona 是否已注入（每会话一次）
      guided: new Set(), // 已注入过近场引导的用户消息标识（每条一次）
      stage: 0, // 当前阶段 0..3
      reportedStage: -1, // 上次上报给服务的阶段（-1 = 还没报过）
      scanned: false, // 是否已读过一次事件日志（resume 重建）
      lastSeq: undefined, // 上次读到的会话日志长度（session.seq）—— 增量读的起点兼变更探针
      pendingWrites: new Map(), // callId → 工具名，用于把 tool/result 配回调用
      awaitingEvidence: false, // 最近一个事件是"模型说话"而非"工具结果"
      lastAssistantText: '', // 最近一条助手文本（交付门判定用）
      nudged: false, // 本轮是否已提醒过补证据
      // —— A 项：交付门升级为"有牙齿的真门"后新增的水位 ——
      unverifiedWrite: false, // 最近一次成功的 write/edit 之后**还没有**任何成功的验证类工具调用
      deliveryBlocks: 0, // 本会话已驳回几次（防死循环的计数器）
      deliveryGaveUp: false, // 是否已经到达上限并放弃驳回（保证 deliveryGiveUp 每会话只记一次）
      restrictStage: -1, // 已经按哪个阶段设过 restrict（-1 = 还没设过）；避免每步重复设置
      // —— B 项：硬流程门（flowGate）新增的两个水位 ——
      planSignaled: false, // 会话里是否出现过"计划信号"（成功的 todo_write / exit_plan_mode）
      flowBlocks: 0, // flowGate 的"跳过流程"驳回次数（本会话上限 FLOW_BLOCK_LIMIT，防死循环）
      // —— 分档流程：本会话当前的推理强度档位（决定协议裁剪到哪一步）——
      // 来源是 request/header 事件里的 config.reasoningEffort，
      // 而不是 system-prompt/assemble 的 variables —— 后者只带 provider/model。
      effort: '',
    }
  }

  /**
   * 把一批事件折进状态。
   *
   * 做三件事：①补首轮任务文本与分类；②按完成信号推进阶段；③维护
   * "最近是模型在说话、还是工具留下了证据"这个水位（交付门用）。
   *
   * **单步推进**：调用 protocol.advanceStage，一次最多进一级 —— 同一个
   * `todo_write` 不能把 0 直接顶到 2。这保证重放同一段事件得到同一个阶段。
   * @param {any} state
   * @param {any[]} events
   */
  function foldEvents(state, events) {
    for (const event of events) {
      if (!event || typeof event !== 'object') continue

      // ① 首轮真实用户消息（只认第一条，且只认真正用户发来的）
      //
      // 注意**刻意不在这里 bumpClass**：从日志恢复出来的分类不是本进程做的，
      // 而 `stats()` 的口径是"本次进程内统计，重启归零"（面板上就这么写）。
      // 与 `personaInjected` 同一约定：恢复的状态不计数，只计本进程真正发生的事。
      // 若在此计数，会话状态被 200 上限淘汰后重建会**重复计数**。
      if (state.firstText === undefined && isRealUserEvent(event)) {
        const t = messageText(event.data)
        if (t) {
          state.firstText = t
          const c = classifyTask(t)
          state.form = c.form
          state.complex = c.complex
        }
      }

      // ①b 插件自己注入过的消息 —— 让"只注一次"在**进程重启后依然成立**。
      //
      // 为什么必须从事件里恢复：`personaDone` 是进程内标记，resume 后归零，
      // 会在会话中途再注一次首轮策略（用户看到莫名其妙多出一段"首轮策略"）。
      // 注入的消息是持久化的 user/message，且带我们的 plugin 标记与 id 前缀，
      // 所以可以据此把"已经注过"这件事重建出来 —— 这才是真正的 resume-safe。
      if (event.type === 'user/message' && isPluginSource(event.data?.source)) {
        const id = typeof event.data?.id === 'string' ? event.data.id : ''
        if (id.startsWith(PLUGIN_ID_PREFIX + 'persona-')) state.personaDone = true
      }

      // ② 工具调用：**只登记"待定"，不做任何判定**
      if (event.type === 'tool/call') {
        const name = toolCallName(event)
        const callId = event.data?.callId
        if (typeof callId === 'string' && name) state.pendingWrites.set(callId, name)
        // A1 / A2：这里刻意**既不推进阶段、也不降水线**。
        // 「调用过」只说明模型发起过，成不成要等 tool/result 的 ok ——
        // 原实现在这里用 `advanceStage(..., true)` 把 ok 硬编码成真、并直接降水线，
        // 于是**一条报错的命令既算验证成功、又能推进阶段**，水线与阶段双双失真。
        continue
      }
      // ②b 工具结果：阶段推进与"验证水线"**一律以 ok 为准**（与 write/edit 同一口径）
      if (event.type === 'tool/result') {
        const callId = toolResultCallId(event)
        const name = callId !== undefined ? state.pendingWrites.get(callId) : undefined
        if (callId !== undefined) state.pendingWrites.delete(callId)
        const ok = event.data?.message?.isError !== true

        // A1：**只有成功的验证**才算验证。
        // 失败的命令什么都没核验到，所以水线**不降** ——
        // "跑了个报错命令就算验过了"正是本项要修掉的缺口（交付门会继续拦着）。
        if (ok && typeof name === 'string' && VERIFY_TOOLS.includes(name)) {
          state.unverifiedWrite = false
        }
        // flowGate 的"计划信号"：成功的 todo_write / exit_plan_mode 都算已经给过计划。
        // 只认成功：失败的 todo_write 什么都没外化，不该解锁计划前置门。
        if (ok && typeof name === 'string' && PLAN_SIGNAL_TOOLS.includes(name)) {
          state.planSignaled = true
        }
        // A2：阶段推进**只看结果**。失败的调用一律不推进（原来非写工具在调用处
        // 用硬编码的 ok=true 推进，失败的命令照样能把阶段顶上去）。
        const next = advanceStage(state.stage, name, ok)
        if (next > state.stage) state.stage = next

        // A 项：只有**成功**的 write/edit 才升起水线（失败的写什么都没改，不需要验证）。
        // 注意这里**不重置** deliveryBlocks —— 驳回次数是"本会话"的上限，
        // 每轮改动都重置就永远到不了上限，死循环保护会失效。
        if (ok && typeof name === 'string' && WRITE_TOOLS.includes(name)) state.unverifiedWrite = true
        // 工具结果 = 本轮有证据在；重置提醒水位，让"下一次无证据的完成声明"能再被提醒。
        state.awaitingEvidence = false
        state.nudged = false
        continue
      }

      // ③ 证据水位：助手说完话之后若没有任何工具结果，就是"声称完成但无证据"的候选
      // —— 分档流程：从请求头事件读当前推理强度档位 ——
      //
      // 为什么用 request/header 而不是别处：它是**每次真实请求**都写入日志的事件，
      // 其 config 里带 reasoningEffort（dsh-session 的 seed 校验也认这个字段）。
      // system-prompt/assemble 的 variables 只有 provider/model，拿不到档位。
      if (event.type === 'request/header') {
        const cfg = event.data?.header?.config ?? event.data?.config
        const eff = cfg?.reasoningEffort
        if (typeof eff === 'string' && eff) state.effort = eff.toLowerCase()
        continue
      }

      if (event.type === 'assistant/message') {
        const t = messageText(event.data)
        if (t) {
          state.lastAssistantText = t
          state.awaitingEvidence = true
        }
      }
    }
  }

  /**
   * 取（必要时新建、重建或增量推进）会话状态。
   *
   * resume-safe 的关键：状态**只从会话事件派生**，进程内 Map 纯粹是缓存。
   *   - 首次碰到某会话（含进程重启后重新加载）：整段读一次事件，把首轮任务与
   *     阶段重建出来 —— 重启前后得到同一个阶段。
   *   - 之后：用 `session.seq`（= log.length）当 O(1) 变更探针，只增量读新增事件。
   *
   * 为什么不用事件通知（`session/event`）来推进：那需要假设"该通知能送达本作用域"，
   * 而这个假设我**没能从源码确证**；更要紧的是，通知路径与增量读路径会**重复折叠**
   * 同一批事件，而阶段推进是"有方向"的，重复折叠会多推一级、把阶段算错。
   * 单一真相来源（只在 ensureState 里读日志）+ O(1) 探针，既确定又不会算错。
   * @param {any} session
   */
  function ensureState(session) {
    const sid = session?.id
    if (sid === undefined || sid === null) return freshSessionState()

    let state = sessions.get(sid)
    if (state === undefined) {
      if (sessions.size >= SESSION_STATE_LIMIT) {
        // 真相在会话事件里，丢缓存不会丢事实 —— 直接丢最老的一条。
        const oldest = sessions.keys().next()
        if (!oldest.done) sessions.delete(oldest.value)
      }
      state = freshSessionState()
      sessions.set(sid, state)
    }

    const seq = readSessionSeq(session)
    const changed = seq === undefined ? !state.scanned : seq !== state.lastSeq
    if (changed) {
      // 增量读的起点：只有"确认这个长度是本会话上次读到的长度"时才敢用增量，
      // 否则（首次、或读不到 seq）整段读。
      const from =
        typeof seq === 'number' && typeof state.lastSeq === 'number' && seq > state.lastSeq
          ? state.lastSeq
          : undefined
      const fresh = readSessionEvents(session, from)
      if (fresh.length > 0) foldEvents(state, fresh)
      state.scanned = true
      state.lastSeq = seq
      // 重建/推进出来的阶段都要上报：resume 后服务侧的 stageBySession 同样需要被填上，
      // 否则设置页在"刚重启、还没渲染过协议段"的窗口里会看到空阶段。
      reportStage(session, state)
    }
    return state
  }

  /** 阶段变化时上报一次（只在真的变了的时候报，避免刷计数）。 */
  function reportStage(session, state) {
    if (state.stage === state.reportedStage) return
    const previous = state.reportedStage
    state.reportedStage = state.stage
    setStage(session?.id, state.stage)
    // `stageAdvances` 记的是**推进动量**（推进了几级），与 `setStage` 记的**当前值**互补。
    // 首次上报（previous === -1）不计：resume 后从事件里第一次读出阶段属于"发现现状"，
    // 不是"推进了一级"，计进去会让统计虚高。按级数累加，跨级推进也不会漏记。
    if (previous >= 0 && state.stage > previous) bump('stageAdvances', state.stage - previous)
  }

  /** 取会话当前阶段（顺带上报变化）。 */
  function stageOf(session, state) {
    reportStage(session, state)
    return state.stage
  }

  /**
   * flowGate 的「计划信号」判据 —— 三个来源任一成立即可（与需求逐条对应）：
   *   ① 会话事件里出现过**成功**的 `todo_write`；② 成功过的 `exit_plan_mode`；
   *   ③ 用户当前处于计划模式（复用既有的 {@link planModeActive}）。
   *
   * ① ② 由 foldEvents 从会话日志折叠出来（`state.planSignaled`），所以**resume-safe**：
   * 进程重启后重放同一份日志，得到同一个判定。
   *
   * ③ 的取值口径：只有**确定为 true** 才算有信号（`planModeActive` 不可判定时返回 undefined）。
   * 这里刻意**失败关闭**，与 `planGate` 的失败开放相反 —— 因为 flowGate 的语义就是
   * "没有计划不许动手"，而不是"读不到状态就别管"。代价可控：真读不到计划模式时，
   * 模型只要调一次 `todo_write` 就能解锁，而拒绝理由里已经把这条路写清楚了。
   * @param {any} state 会话状态
   * @param {any} agent 工具执行上下文 / 轮次里的 agent
   * @returns {boolean}
   */
  function hasPlanSignal(state, agent) {
    try {
      if (state && state.planSignaled === true) return true
      return planModeActive(ctx, agent) === true
    } catch {
      return false // 判定失败按"没有信号"处理（失败关闭），理由里给了可操作的出路
    }
  }

  /* ---------------- 协议段 order ---------------- */

  /** 协议段 order：优先用中央分配值，取不到再退回常量。 */
  function sectionOrder() {
    try {
      const o = ctx.systemPrompt?.getSectionOrder?.('PLAN_POLICY')
      if (Number.isFinite(o)) return o
    } catch {
      /* 没有中央值就用兜底常量 */
    }
    return FALLBACK_SECTION_ORDER
  }

  /* ---------------- ① 首轮任务分类 ---------------- */

  /**
   * `agent/inbox/claimed`：某条消息刚被认领。
   *
   * **只认 `source.kind === 'user'`**：插件自己注入的消息（runtime-context、
   * goal、approval、router 引导）不代表任务，把它们当首轮会让分类整段跑偏。
   * 每条会话**只记第一条**真实用户消息 —— 首轮就锁定执行形态，后续消息不覆盖。
   */
  onEvent('agent/inbox/claimed', (payload) => {
    try {
      const message = payload?.message
      if (message?.source?.kind !== 'user') return
      const session = payload?.agent?.session
      if (!session) return
      const t = messageText(message)
      if (!t) return

      const state = ensureState(session)
      if (state.firstText !== undefined) return // 只认首轮

      state.firstText = t
      const c = classifyTask(t)
      state.form = c.form
      state.complex = c.complex
      bumpClass(c.form)
    } catch {
      /* 分类是增益，不是功能前提：出错就不分类，绝不打断消息认领 */
    }
  })

  /* ---------------- 会话模型快照（persona 按模型选型用） ---------------- */

  /**
   * `system-prompt/assemble`：只**观察**，不改装配结果。
   *
   * 为什么需要它：persona 的最优版本与模型强相关（pro 与 flash 不同），
   * 而"当前用的是哪个模型"只有装配回来才知道（`assembled.variables.model`）。
   * 本监听器原样返回 assembled —— 它不改变任何提示内容，因此不产生额外缓存代价。
   *
   * 时序上安全：`agent/pre-step` 内部先 `systemPrompt.assemble(...)` 再派发
   * `agent/pre-step`，所以 pre-step 里读到的模型一定是本步刚定下来的。
   */
  onEvent('system-prompt/assemble', async (_assembly, context, next) => {
    let assembled
    try {
      assembled = await next()
    } catch (error) {
      throw error // 装配失败是上游的事，原样冒泡，不让本插件吞掉别人的错误
    }
    try {
      const session = context?.agent?.session
      const model = assembled?.variables?.model
      if (session && typeof model === 'string' && model) {
        const state = ensureState(session)
        state.model = model
      }
    } catch {
      /* 观察失败不影响装配 */
    }
    return assembled
  })

  /* ---------------- ②③⑥ 首轮 persona / 近场引导 / 交付门 ---------------- */

  /**
   * 造一条**插件注入的**用户消息。
   *
   * 为什么走「user 消息」而不是往系统提示里塞：系统提示段一变，整段前缀缓存就废
   * （早期表述过强，实测见 AGENTS.md：改工具面只损失部分前缀命中）。
   * 而这条消息只在**该变的时候**变一次，是可控的、离散的代价。
   * `source.kind: 'plugin:dsh-coding-mode'`（producer-owned） 让它可被识别 —— 后续分类会跳过它。
   */
  let injectedSeq = 0
  function pluginMessage(contentText, tag) {
    injectedSeq += 1
    return {
      id: `${PLUGIN_ID_PREFIX}${tag}-${Date.now().toString(36)}-${injectedSeq}`,
      role: 'user',
      source: { ...PLUGIN_SOURCE },
      content: [{ type: 'text', text: contentText }],
    }
  }

  /**
   * `agent/pre-step`：每步请求前改写要追加的消息。
   *
   * **必须 spread 改写**：decision 上除了 `messages` 还有 `startsRequestSeries`
   * 等由上游设置的字段，重建对象会把它们丢掉（丢掉 startsRequestSeries 会让
   * 请求序列判定出错 → 缓存与历史处理一起错）。所以只做
   * `return { ...decision, messages: [...] }`。
   *
   * 三条铁律：
   *   1. `decision.kind !== 'enter'`（如 `reject`）时**原样透传** —— 不拦别人的决定。
   *   2. 不处理时返回**下游原样结果**，不自己造对象。
   *   3. 任何异常都吞掉并返回下游结果：编排崩了也不能让用户的会话崩。
   */
  onEvent('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const config = settings()
      const session = payload?.agent?.session

      // B 项：阶段硬门控（可选开关，默认关）。
      //
      // 放在最前面、且**不受 decision 形状影响**：工具面是"当前阶段"的属性，
      // 与这一步的 decision 是 enter 还是 reject 无关；而且必须在这一步真正
      // 执行（`step()` 里读取工具面）之前设好。
      //
      // 必须在 **scoped context**（`agent.ctx`）上调用 restrict —— 见 applyStageRestrict 的注释。
      if (config.stageRestrict && session) {
        const gateState = ensureState(session)
        applyStageRestrict(payload.agent, stageOf(session, gateState), gateState)
      }

      // 铁律 1：不是 enter 就原样透传（reject 等）。
      if (!decision || decision.kind !== 'enter') return decision

      if (!session) return decision

      const state = ensureState(session)
      const form = state.form ?? 'explore'
      const complex = state.complex === true
      const injected = []

      // ② persona：每条会话**只注一次**（首轮策略，中途再注只会污染上下文）
      if (!state.personaDone) {
        state.personaDone = true
        injected.push(pluginMessage(buildPersona({ form, complex, model: state.model }), 'persona'))
        bump('personaInjected')
      }

      // ③ 近场引导：**每条真实用户消息**一次
      //    信号取本轮刚认领的 messages（payload.messages），因为 claimed 拿到的
      //    就是这一步新入列的消息 —— 天然就是"新的用户消息"，不需要自己算时序。
      const claimed = Array.isArray(payload?.messages) ? payload.messages : []
      const userMessage = claimed.find((m) => m?.role === 'user' && m?.source?.kind === 'user')
      if (config.nearFieldGuide && userMessage) {
        const key =
          userMessage.id !== undefined && userMessage.id !== null
            ? String(userMessage.id)
            : messageText(userMessage).slice(0, 120)
        if (key && !state.guided.has(key)) {
          state.guided.add(key)
          // 上限淘汰：Set 的迭代顺序 = 插入顺序，删第一个即丢最老的。
          // 与 sessions / restrictLift 同源的防泄漏做法。
          while (state.guided.size > GUIDED_LIMIT) {
            const oldest = state.guided.values().next()
            if (oldest.done) break
            state.guided.delete(oldest.value)
          }
          injected.push(pluginMessage(buildNearFieldGuide({ form, complex }), 'guide'))
          bump('guideInjected')
        }
      }

      // ⑥ 交付门：模型**声称完成**但本轮没有任何工具证据 → 提醒补证据
      //    判据全部来自增量水位（awaitingEvidence / lastAssistantText），
      //    所以这里不读事件日志、O(1)、不会拖慢每一步。
      if (
        config.stageGuide &&
        state.stage >= 2 &&
        state.awaitingEvidence &&
        !state.nudged &&
        CLAIM_RE.test(state.lastAssistantText)
      ) {
        state.nudged = true
        injected.push(pluginMessage(buildEvidenceReminder(), 'evidence'))
        bump('guideInjected')
      }

      if (injected.length === 0) return decision

      // 铁律 2 + 3：spread 改写，保住 decision 上的其它字段。
      const base = Array.isArray(decision.messages) ? decision.messages : []
      return { ...decision, messages: [...base, ...injected] }
    } catch {
      return decision // 铁律 3：编排出错时退回下游结果，绝不抛
    }
  })

  /**
   * 交付门提醒文案。
   *
   * 为什么做成**提示文本**而不是一个工具：本项目刻意保持 **0 个模型可见工具**
   * ——理由是**简洁**（不占模型注意力、不引入需要模型学会的新接口），
   * 而不是省缓存：实测增删尾部工具只损失部分前缀命中，官方渠道删 1 个工具
   * 命中率 88%→81% 且恢复后立刻回满。同理也不做 `tools.restrict`。
   */
  function buildEvidenceReminder() {
    return (
      '【编程模式 · 交付门】你刚刚给出了完成性结论，但**这一步没有留下任何工具证据**。\n\n'
      + '本项目的硬要求：\n'
      + '- 凡"完成了 / 修好了 / 实现好了"的声明，**必须附可核验证据**：文件确实存在（贴路径）、'
      + '命令确实跑过（贴输出）、数值确实达标（贴断言）。\n'
      + '- 没有证据的完成声明**一律按未完成处理**。"应该没问题""理论上可以"不算证据。\n'
      + '- 交付前必须让**独立子代理反对你一次**（找反例 / 边界 / 回归），不要复用你自己刚跑的结论。\n\n'
      + '请立刻补上证据：跑一次真实命令并把它**原样**贴出来，或读回文件确认改动确实在里面。'
    )
  }

  /* ---------------- A 项：交付门（从"提示"升级为"有牙齿的真门"） ---------------- */

  /**
   * 把一条消息**塞回当前这一轮**，让模型在同一步之后继续干活。
   *
   * 为什么是 `steer` 而不是 `followup` —— 这一条已从源码确证（`dsh-agent-loop/lib/index.js`）：
   *   ```
   *   followup(input) { this.send(input, "next-turn", true); }   // 开**新轮**
   *   steer(input)    { this.send(input, "next-step", true); }   // 进**本轮的下一步**
   *   inject(input)   { this.send(input, "next-step", false); }  // 同上，但不唤醒驱动器
   *   ```
   * 且轮次关闭处（同文件 `run()` 内）是：
   *   ```
   *   if (turnEnds && this.inbox.nextStep.length === 0) {
   *     await this.dispatch.serial("agent/turn-stopping", { turn, signal });
   *   }
   *   if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 派发之后**重新检查**
   *   ```
   * 也就是说：在 `agent/turn-stopping` 里往 `next-step` 里塞东西，`break` 就不会执行，
   * 循环接着跑下一步 —— **steer 在 turn-stopping 阶段确实有效**（有源码依据，不是推测）。
   * 而 `followup` 进的是 `next-turn`，救不回当前这一轮，且会多开一轮（可能失控），所以不用。
   *
   * 优先 `steer`，失败再退 `inject`（两者落地位置相同，`inject` 只是不唤醒驱动器；
   * 此刻循环正在自己跑，唤不唤醒都不影响它继续）。都不可用 → 返回空串，调用方放弃记帐。
   *
   * @param {any} agent turn-stopping 负载里的 agent（事件负载会自动注入它）
   * @param {object} message 一条完整的 user 角色消息
   * @returns {string} 实际用上的方法名；一个都没成功则空串
   */
  function steerSameTurn(agent, message) {
    for (const method of ['steer', 'inject']) {
      try {
        if (typeof agent?.[method] !== 'function') continue
        agent[method](message)
        return method
      } catch {
        /* 这个方法不可用 → 试下一个 */
      }
    }
    return ''
  }

  /**
   * 交付门驳回文案。
   *
   * 为什么要**驳回**而不是像以前那样只"提醒一句"：原来的交付门只是一段提示文本，
   * 模型说完成就完成了 —— 门是纸做的。现在改成在 `agent/turn-stopping` 里
   * （轮次即将关闭的最后一刻）驳回，并把轮次**拽回来继续**，
   * 于是"没证据不许收尾"从建议变成了硬约束。
   */
  function buildDeliveryRejection() {
    return (
      '【编程模式 · 交付门驳回】本轮到目前为止**不能收尾**。\n\n'
      + '原因：你在阶段 3（验证/交付），而且自**最后一次成功的 write / edit** 之后，'
      + '**没有跑过任何验证类工具**（`bash` / `read` / `grep` / `glob` / `read_image`）。'
      + '也就是说：你改完文件之后直接宣布了结果，中间没有任何可核验的环节。\n\n'
      + '请立刻补上，且必须**原样粘贴真实输出**（不要转述、不要总结）：\n'
      + '1. 跑一次能证明改动生效的真实命令（例如 `node --test` / 编译 / 实际调用），贴出原始输出；\n'
      + '2. 或用 `read` 把改动后的文件读回来，贴出关键片段，确认改动确实落盘。\n'
      + '3. 交付前让**独立子代理反对你一次**（找反例 / 边界 / 回归）——'
      + '要真的派 `subagent`，不要自己脑内模拟。\n\n'
      + '做完这些再收尾。**没有证据的完成声明一律按未完成处理。**'
    )
  }

  /**
   * flowGate 的「流程不可跳过」驳回文案（阶段还没到 3、且整场都没有计划信号）。
   *
   * 为什么文案要说"任选一条即可解锁"：这是**硬门**，模型被驳回后只能靠这段文本
   * 自己找出口。写清解锁条件，门才是在**纠正流程**；不写，门就变成了拦路石。
   * @param {number} stage 当前阶段
   */
  function buildFlowSkipRejection(stage) {
    const name = STAGE_NAMES[stage] ?? String(stage)
    return (
      '【编程模式 · 流程门驳回】本轮不能收尾：这次会话**从来没有给过计划**，'
      + `阶段还停在 ${stage} · ${name}。\n\n`
      + '硬流程门（flowGate）要求：动手之前先把计划外化，收尾之前先走到阶段 3（验证/交付）——'
      + '阶段机不是建议，是**门槛**。\n\n'
      + '请立刻补上（任选一条即可解锁本门）：\n'
      + '1. 用 `todo_write` 把计划写成待办（目标 / 验收标准 / 步骤）；\n'
      + '2. 用 `exit_plan_mode` 把计划交给用户确认。\n\n'
      + '补完之后**继续推进任务**，不要直接把这一轮关掉。'
    )
  }

  /**
   * `agent/turn-stopping`：轮次即将关闭时的**最后一道门**。
   *
   * 语义（源码依据见 {@link steerSameTurn}）：这是"这一轮本来要结束了"的时刻，
   * 监听器是 serial 派发、**会被 await**，所以在这里注入消息能把轮次拽回来。
   *
   * 判定（两条同时成立才驳回）：
   *   ① 阶段已是 3（验证/交付）——`STAGE_COUNT - 1`；
   *   ② 自最后一次成功的 write/edit 以来没有任何验证类工具调用（`state.unverifiedWrite`）。
   *
   * 三条自我约束：
   *   - **受 `stageGuide` 开关控制**：关了就不做（它是同一套"阶段"行为的延伸）；
   *     flowGate 打开时它也生效（见下方说明），因为"阶段 3 有未验证的写"正是硬流程门
   *     要拦的那种"跳过验证直接收尾"；
   *   - **每会话最多驳回 `DELIVERY_BLOCK_LIMIT` 次**，到顶就放行并记一次 `deliveryGiveUp`
   *     —— 宁可放过一个没验证的交付，也绝不允许插件把用户的会话卡成死循环；
   *   - **只记成功投递的账**：steer/inject 都送不进去时不 `bump`，否则统计会谎报"拦住了"。
   *
   * 刻意**不用 `followup`**：那会开新轮，可能失控。
   */
  onEvent('agent/turn-stopping', async (payload) => {
    try {
      const config = settings()
      // 两道门都关 → **在碰会话状态之前**就返回。
      //
      // 这个提前返回的位置很要紧：它保证 `flowGate=false`（默认）时这一步与改动前
      // **逐条等价** —— 不折叠事件、不上报阶段、不动任何一个计数。
      // 若把判据挪到 ensureState 之后，关掉 stageGuide 的老行为就会多出一堆副作用。
      if (!config.stageGuide && !config.flowGate) return

      const agent = payload?.agent
      const session = agent?.session
      if (!session) return

      const state = ensureState(session)
      const stage = stageOf(session, state)

      // —— flowGate 专属：流程不可跳过（默认关，打开才是硬门）——
      //
      // 判定：阶段还没到 3，且整场没有计划信号 → 驳回一次，把轮次拽回来补计划。
      // 为什么要这道门：阶段机原本只是**文本指引**，模型完全可以无视它直接宣布完工；
      // flowGate 打开后，"跳过流程收尾"这件事在轮次即将关闭的最后一刻会被驳回。
      if (config.flowGate && stage < STAGE_COUNT - 1 && !hasPlanSignal(state, agent)) {
        // 防死循环：与交付门同一风格的上限，但**额度独立**（flowBlocks）。
        // 若与交付门共用额度，几次"没有计划"的驳回会把额度吃光，
        // 等到阶段 3 真该拦"没验证"时门已经放弃了 —— 两道门目标不同，额度必须分开。
        if (state.flowBlocks < FLOW_BLOCK_LIMIT) {
          const delivered = steerSameTurn(agent, pluginMessage(buildFlowSkipRejection(stage), 'flow'))
          if (delivered) {
            state.flowBlocks += 1
            bump('flowBlocked')
            // 一次只驳一条：已经因为"没计划"驳回了，这一轮就不再叠加交付门的驳回。
            return
          }
        }
        // 送不进去 / 已到上限 → 不在这里纠缠，继续往下走（该放行就放行）。
        // 宁可放过一次没计划的收尾，也绝不允许插件把用户的会话卡成死循环。
      }

      // 判定 ①：阶段必须是终态（验证/交付）
      if (stage < STAGE_COUNT - 1) return
      // 判定 ②：自最后一次成功写盘以来没有验证类工具调用 → 无证据
      if (!state.unverifiedWrite) return

      // 防死循环：到达上限就放行。
      // `deliveryGaveUp` 保证「放弃驳回」**每会话只记一次** —— 否则后续每次收尾
      // 都会再记一笔，计数器会变成"这一轮被放行了几次"，语义跑偏。
      if (state.deliveryBlocks >= DELIVERY_BLOCK_LIMIT) {
        if (!state.deliveryGaveUp) {
          state.deliveryGaveUp = true
          bump('deliveryGiveUp')
        }
        return
      }

      const delivered = steerSameTurn(agent, pluginMessage(buildDeliveryRejection(), 'gate'))
      if (!delivered) return // 送不进同一轮就别记账

      // 注意：**不重置** `state.unverifiedWrite`。
      // 驳回后模型若仍然不验证、再次收尾，我们要能再驳一次（这就是"最多 N 次"的意义）；
      // 只有真的出现验证类工具调用时那个水位才会自己降下来。
      state.deliveryBlocks += 1
      bump('deliveryBlocked')
    } catch {
      /* 交付门是增益：任何异常都放行，绝不把用户的轮次卡死 */
    }
  })

  /* ---------------- B 项：阶段硬门控（可选开关，默认关） ---------------- */

  /**
   * per-session 的 restrict 释放器。
   *
   * 为什么必须自己存：`tools.restrict()` 的语义是**交集**（源码注释与参考实现都明确写死：
   * "Restrictions intersect; scoped registrations remain visible" / "tools.restrict 是交集——
   * 释放旧 disposer 再设新"）。不释放旧的，第二个阶段的 allow 会与第一个取交集，
   * 结果是工具越用越少，最后什么都调不动。
   *
   * 键用 sessionId：不同会话各自一份限制，互不干扰。
   */
  const restrictLift = new Map()

  /** 释放某会话已有的 restrict（幂等；释放器抛错也照常继续）。 */
  function releaseStageRestrict(sessionId) {
    if (sessionId === undefined || sessionId === null) return
    const previous = restrictLift.get(sessionId)
    if (previous === undefined) return
    restrictLift.delete(sessionId)
    try {
      if (typeof previous === 'function') previous()
    } catch {
      /* 释放失败不能挡路：最多是这一层的限制还挂着，下次 apply 会被新的替换 */
    }
  }

  /**
   * 取"可以被 restrict 的全局工具名"集合。
   *
   * 为什么需要它：`tools.restrict()` 对**不认识的名字会抛错**
   * （`tools.restrict() names unknown global tool "xxx"`），
   * 而工具面随平台与环境变化（例如 win32 上可能没有 `bash`）。
   * 不先过滤，一个缺失的工具就会让整段阶段门控抛掉。
   *
   * 探法说明（诚实标注）：已从源码确证的是 `this.view(scope)`，其中 scope = `scopeOf(this.ctx)`；
   * 参考实现（router-bootstrap 的 applyStageRestrict，生产可用）传的是 `view(agent)`。
   * 两者都先试，都不行就返回 null —— 调用方**放弃门控**而不是冒险抛错。
   * 见报告"未确证"一节。
   * @returns {Set<string>|null}
   */
  function restrictableNamesOf(toolsService, agent) {
    const candidates = [() => toolsService.view(agent), () => toolsService.view(), () => toolsService.view(agent?.ctx)]
    for (const probe of candidates) {
      try {
        const view = probe()
        const names = view?.restrictableNames
        if (names && typeof names.has === 'function') return names
      } catch {
        /* 这个探法不可用 → 试下一个 */
      }
    }
    return null
  }

  /**
   * 按阶段重设工具面限制（仅当 `stageRestrict` 打开时才会被调用）。
   *
   * **必须在 scoped context 上调用**（`agent.ctx.get('tools')`，不是插件自己的 `ctx`）：
   * 源码里 `restrict()` 第一件事就是
   * `const scope = scopeOf(this.ctx); if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx) ...")`。
   * 全局调用会直接抛 —— 这条已确证（`dsh-tools/lib/index.js:2895-2897`）。
   *
   * 为什么带 `state`：restrict 每设一次都会新建一层 effect，而 pre-step **每步都跑**。
   * 阶段没变时重设纯属无谓的churn，所以用 `state.restrictStage` 记住"当前已按哪个阶段设过"。
   *
   * 全程 try/catch：门控失败就退回"全量工具面"，绝不因为限制没设上而让请求失败。
   *
   * @param {any} agent pre-step 负载里的 agent
   * @param {number} stage 当前阶段
   * @param {any} state 该会话的状态对象（存 restrictStage 标记）
   */
  function applyStageRestrict(agent, stage, state) {
    const sessionId = agent?.session?.id
    try {
      const scoped = agent?.ctx
      const toolsService = scoped && typeof scoped.get === 'function' ? scoped.get('tools') : undefined
      // 拿不到 scoped 工具服务 = 这个环境不支持阶段门控。
      // 刻意**不记标记**：等它有朝一日可用时我们还要能接上（这次尝试只是一次 get()，很便宜）。
      if (!toolsService || typeof toolsService.restrict !== 'function') return

      // 阶段没变就不重设。标记交给它管，避免每步释放-重设的churn。
      if (state.restrictStage === stage) return

      // 关键顺序：**先释放旧的，再设新的**（restrict 是交集语义）。
      // 不释放的话，阶段 1 的 allow 会与阶段 0 的取交集，工具越用越少，最后什么都调不动。
      releaseStageRestrict(sessionId)

      const allow = STAGE_RESTRICT_ALLOW[stage]
      if (allow === null || allow === undefined) {
        state.restrictStage = stage // 该阶段本就不限制，记标记免得每步重算
        return
      }

      const restrictable = restrictableNamesOf(toolsService, agent)
      if (restrictable === null) return // 拿不到可限制名单 → 不冒险，保持全量（也不记标记，下次再试）

      const filtered = allow.filter((name) => restrictable.has(name))
      if (filtered.length === 0) {
        state.restrictStage = stage // 没有可限制的名字 = 该阶段实际无限制
        return
      }

      const disposer = toolsService.restrict({ allow: filtered })
      // ⚠️ 官方 practices.md:19 的硬要求：`agent.ctx` 上的注册**有两个 owner**。
      // restrict 的所有权是 agent 的 fiber（dsh-tools 内部走 `layers.effect(this.ctx, …)`），
      // 插件卸载**不会**释放它。若不把释放器镜像进本插件自己的 effect，
      // 一旦插件被卸载/热重载（改 profile、HMR）而 agent 仍存活，
      // 新实例的 restrictLift 是空的、**永远释放不掉旧实例留下的限制** ——
      // 阶段 2/3 的"全量开放"会与残留的 allow 取交集，write/edit 被永久隐藏，
      // 只能销毁 agent 才能恢复。
      if (sessionId !== undefined && sessionId !== null && typeof disposer === 'function') {
        restrictLift.set(sessionId, disposer)
        // 镜像：插件自己的 effect 也持一份 disposer，按 session 键控。
        // 插件卸载时这句会跑，旧限制随之被释放，不会残留成"工具越用越少"。
        ctx.effect(() => () => {
          try {
            disposer()
          } catch {
            /* 释放幂等 */
          }
        }, 'dsh-coding-mode: stage restrict mirror')
        state.restrictStage = stage
        // 与 sessions 表同样的理由：这张 Map 的生命周期＝进程生命周期，
        // 不设上限就是一条缓慢的内存泄漏。丢掉的是**释放器**而不是限制本身，
        // 方向是安全的（该会话退回全量工具面，不会卡死任何东西）。
        while (restrictLift.size > SESSION_STATE_LIMIT) {
          const oldest = restrictLift.keys().next()
          if (oldest.done) break
          releaseStageRestrict(oldest.value)
        }
      } else {
        // 拿不到 disposer → 限制设了却没法释放，比不设更危险。立刻撤销并放弃本阶段。
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          /* 幂等 */
        }
        state.restrictStage = stage
      }
    } catch {
      // restrict 抛错（例如名字在该 agent 作用域里不可限制）→ 本次门控放弃，工具面保持原样。
      // 这里刻意**不重新抛出**：阶段门控是增益，失败不该影响这一步的请求。
      releaseStageRestrict(sessionId)
      // 修过一个真实缺陷：原实现在 try 开头就 `state.restrictStage = stage`，
      // 于是抛错后标记仍指向该阶段 → 之后每步都在前面提前返回，
      // **该阶段永久不再重试**（静默失效）。现在抛错时**不记标记**，
      // 与上面"拿不到 scoped 服务时刻意不记标记"的设计意图一致。
    }
  }

  /* ---------------- ⑦ 子代理自动分档（只动子会话） ---------------- */

  /**
   * `agent/request` waterfall：给**子代理会话**按任务复杂度选档。
   *
   * 依据（已在本地 DSH 源码确证，非猜测）：
   *   - `dsh-agent-loop/lib/index.js:1179` 派发
   *     `this.dispatch.waterfall("agent/request", {turn, step, signal}, () => seedConfig)`，
   *     `seedConfig` 就是 `LlmCallConfig`。
   *   - `LlmCallConfig` 的声明形状（`dsh-agent-preset-registry` 的 typert 声明）：
   *     `{ provider: string; model: string; reasoningEffort?: ReasoningEffortId;
   *        temperature?: number; maxTokens?: number; stop?: string[] }`。
   *   - `dsh-agent/lib/index.js:181` 官方自己就是这么用的：`await next()` 拿到
   *     resolved 配置，spread 后覆盖 `provider` / `model` / `reasoningEffort` 返回。
   *   - 事件负载里的 `agent` 是**自动注入**的（`dsh-agent/lib/types/dispatch.js`
   *     的 `fused(payload) = {...payload, agent}`），所以这里拿得到会话身份。
   *
   * **绝对不碰主会话**：`session.header.parentSession === undefined` 就是主会话，
   * 直接原样返回。给主会话换模型 = 换缓存域 = 整段上下文全价重发，这是本项目
   * 最贵的一种错误（实测 pro 路由下第 4 条请求起缓存永久失效）。
   */
  onEvent('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      const config = settings()
      if (!config.tierSubagents) return resolved

      const session = payload?.agent?.session
      // 只认子会话：主会话的 parentSession 是 undefined。
      if (!session || session.header?.parentSession === undefined) return resolved

      // ⚠️ **fork 子会话一律不碰路由** —— 这是官方明说的硬约束，不是优化偏好。
      //
      // 证据（`dsh-tool-subagent` README 原文）：
      //   · "Shipped fork tools cannot select a child LLM route —— they inherit the
      //      parent's provider and model **to keep the copied conversation prefix
      //      eligible for KV Cache reuse**."
      //   · "**a child route override may prevent a fork child from reusing the
      //      inherited parent prefix**."
      //
      // `subagent_fork` 的全部价值就是"复制父会话的对话前缀 → 服务端 KV 缓存能直接
      // 复用那一段"。它继承父的 provider/model 正是为了让前缀**逐字节一致**。
      // 我们一旦把路由改掉（换模型 = 换缓存域），那份继承前缀立刻**再也命不中**，
      // 于是"复制整个会话"的 token 全按未命中重发 —— 比用 spawn 还贵。
      //
      // 怎么区分 fork 与 spawn（已从源码确证，非猜测）：
      //   `dsh-subagent` 的 `childSessionMeta()` 写 `origin: "subagent"`；
      //   fork 走自己的 seed 路径，**不写 origin**。源码注释亦写明
      //   "A fork shares the lineage field without the origin and is an independent
      //   conversation"。故：
      //     主会话 = 无 parentSession；spawn = 有 parentSession + origin==='subagent'；
      //     fork  = 有 parentSession + 无 origin。
      if (session.header?.origin !== 'subagent') return resolved

      const state = ensureState(session)
      // D 项：`tierPolicy` 不是 auto 时**强制**用这一档，直接跳过复杂度判断。
      //
      // 为什么要跳过而不是"也用复杂度叠加"：A/B 实验要的是一组**干净对照**
      // （"全部强制 flash" vs "全部强制 pro"），如果还掺进自动判定，
      // 实验组之间就不止一个变量在变，结论无法归因。
      // 注意 `bumpTier(tier)` 照常调用 —— 强制档也要进统计，否则实验组看不到分档分布。
      const complex =
        config.tierPolicy === 'auto'
          ? (typeof state.firstText === 'string' ? isComplexTask(state.firstText) : state.complex === true)
          : config.tierPolicy === 'pro'
      const tier = complex ? 'pro' : 'flash'
      const route = config.tiers?.[tier]
      if (!route?.provider || !route?.model) return resolved

      bumpTier(tier)

      // C 项：推理强度策略（与协议段的渲染必须**同一口径**，否则会自相矛盾）。
      //
      // `auto`（新默认）：**不覆盖强度** —— 让模型自己按任务难度选。
      //   这条链路是通的（已从源码确证）：模型在 `subagent` 调用里给的
      //   `reasoning_effort` 经 `dsh-subagent` 的 `resolveChildAgentOptions`
      //   （`...requested` 排在父值之后，模型的选择优先）落到子 agent 的
      //   `options.reasoningEffort`，再由 `dsh-agent-loop` 的
      //   `const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort`
      //   写进 seedConfig —— 也就是这里 `next()` 拿到的 `resolved.reasoningEffort`。
      //   若在这里强行写配置值，模型的选择会被**静默覆盖**，"模型自选"就成了空话。
      //
      //   未能确证的一点：无法从 `resolved` 区分"模型显式指定"与"从父会话继承"
      //   （`resolveChildAgentOptions` 两个来源写的是同一个字段），所以 auto 下
      //   两种来源都原样保留；一个都没有时不补，让适配器走它自己的默认
      //   （这正是 DSH 自己的做法：换路由且没点名强度时就是删掉，让新模型自解析）。
      if (config.effortPolicy !== 'fixed') {
        return { ...(resolved ?? {}), provider: route.provider, model: route.model }
      }

      // `fixed`：保持既有行为 —— 清掉继承来的强度，改用本档位的配置值。
      // 不清的话上游（或适配器默认）的强度会跟我们的模型配错对。
      const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved ?? {}
      return {
        ...withoutInheritedEffort,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      }
    } catch {
      return resolved // 分档失败就用原来解析出来的配置，绝不抛
    }
  })

  /* ---------------- ④⑤ 协议段（含任务回显 + 阶段指引） ---------------- */

  /**
   * 常驻协议段。`text` 用函数形式：
   *   - 每次组装求值 → 设置页改完配置立即生效，不需要重注册；
   *   - 且 DSH 会把**组装上下文**传进来（`dsh-system-prompt/lib/index.js:342`
   *     `typeof section.text === 'function' ? section.text(context) : section.text`），
   *     所以这里拿得到 `context.agent.session` → 任务回显与阶段指引可以按会话渲染。
   *
   * 为什么阶段指引放**系统提示**而不是每步注入消息：它是"规则"，每轮都要在；
   * 放消息里会随轮次堆积（还要重放历史），放系统提示是常量内存。
   * 代价是阶段变化会改变这一段的尾巴 —— 所以 buildProtocol 把易变内容全排在段尾
   * 最小化前缀失效范围，且阶段最多只变 3 次。
   */
  /* ---------------- 语言闸已迁出本插件 ---------------- */

  /**
   * 语言指令（"始终使用简体中文回复"）**已移到独立插件** `@local/dsh-language-guard`。
   *
   * 为什么迁出（两个理由）：
   *   1. **它只对编程模式生效**。本插件的行为层跑在 preset 半侧，注册的提示段
   *      只属于编程模式的 agent —— 换到 standard / minimal preset 就没有中文指令了。
   *      而"用什么语言回答"是**全局个人偏好**，跟"用哪套工作流"是两件事。
   *   2. **独立后可以单独关**：不想用时 disable 那一个 bundle 即可，不必动编程模式。
   *
   * 新插件在**顶层**注册（全局层），并取 order **-900**（比这里原来的 -500 更靠前）：
   *   `-1000` harness identity（英文）→ `-900` 语言闸 → `0` 英文 persona。
   * 装配走 `merge()`，全局层被每个 agent 继承，所以所有模式都拿得到。
   *
   * ⚠️ 不要在本地重新加回语言段：那样会和独立插件**双重注入**同一段指令。
   */

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'coding-mode:protocol',
        order: sectionOrder(),
        text: (context) => {
          const config = settings()

          // D 项：协议段总开关。关掉 = 对照组（不注入任何协议文本）。
          //
          // 为什么"注册但渲染空串"而不是"干脆不注册"：`ctx.systemPrompt.section()`
          // 只在 apply 时执行一次，配置却随时可变 —— 想动态注销就必须重注册，
          // 那会带来"注册/注销竞态 + order 变化"这类新状态源。
          // 而渲染空串是零成本的：DSH 装配时会 `.filter((section) => section.text.length > 0)`
          // 把空段直接丢掉，所以空串等于"这一段的净效果就是不存在"。
          //
          // 关键：**计数也不涨** —— 若还照计 `protocolRendered`，设置页会显示
          // "协议渲染了 12 次"而模型实际一个字都没看到，统计就变成了谎话。
          if (!config.protocolSection) return ''

          let taskEcho = ''
          let stageText = ''
          let stageValue
          // 分档流程：当前推理强度档位。读不到就留空串 → 退回完整流程。
          // 注意 `state` 只在下面的 try 里可见，所以必须提到外层来。
          let effortTier = ''
          try {
            const session = context?.agent?.session
            if (session) {
              const state = ensureState(session)
              effortTier = typeof state.effort === 'string' ? state.effort : ''
              if (config.taskEcho && state.firstText) {
                const echo = buildTaskEcho(state.firstText)
                if (echo) {
                  taskEcho = echo
                  bump('taskEchoed')
                }
              }
              if (config.stageGuide) {
                stageValue = stageOf(session, state)
                stageText = buildStageText(stageValue, { form: state.form })
              } else {
                stageValue = state.stage
              }
            } else if (config.stageGuide) {
              // 拿不到会话（例如单测直接调 text()）也要给出可用文本，
              // 否则同一份代码在两种路径下渲染出不同结构，很难查。
              // 阶段同样补 0：上面已经按阶段 0 渲染指引，统计摘要就必须说同一个数，
              // 否则"指引说阶段 0、摘要却没写阶段"就是自相矛盾。
              stageValue = 0
              stageText = buildStageText(0)
            }
          } catch {
            /* 段渲染失败就退化为纯协议文本，绝不抛 */
          }

          // C 项：统计摘要（默认关）。
          //
          // **刻意在读统计之前不 `bump('protocolRendered')`**（计数放到最后）：
          // 这样"本次"这一行拿到的是**截止上一次渲染**的读数，于是首次渲染必然全零 →
          // `buildStatsFooter` 按"全零不渲染"返回空串 —— 没有历史数据时一个 token 都不多花。
          // 反过来若先计数再渲染，计数永远 ≥1，"全零就不加"这条约束就形同虚设。
          let statsFooter = ''
          if (config.statsFooter) {
            try {
              const service = optionalService(ctx, SETTINGS_SERVICE)
              if (service && typeof service.stats === 'function') {
                statsFooter = buildStatsFooter(service.stats(), { stage: stageValue })
              }
            } catch {
              /* 统计读失败 → 只是没有这一行，协议段本体照常渲染 */
            }
          }

          // 计数时机刻意放在"确定要返回一段渲染好的协议"这一刻：
          // 前面任何一条路径提前 return（协议段关闭）都不会计数，统计与事实一致。
          bump('protocolRendered')

          // 段尾拼接顺序：任务回显在前（"在为哪件事工作"的锚），阶段指引在后
          // （"现在该干嘛"最靠近结尾，注意力最近的一格留给可执行指令），
          // 统计摘要最末（它变化最频繁，放最后可让缓存失效只波及它自己）。
          return buildProtocol({
            tiers: config.tiers,
            planGate: config.planGate,
            loopGuard: config.loopGuard,
            // C 项：**总是显式传入**当前策略。`buildProtocol` 自己的函数级默认是 'fixed'
            // （为了不动纯函数的既有契约与既有单测），所以这里不传就会静默退回 fixed ——
            // 那会让"设置页默认 auto"变成一句空话。
            effortPolicy: config.effortPolicy,
            // 分档流程：把当前档位交给 buildProtocol 做章节裁剪。
            // 读不到时传空串 → flowForTier 退回**完整流程**（宁多不少，绝不静默降级）。
            tier: effortTier,
            // 用户可配置的档位映射（设置页填）。留空 = 全用内置默认，
            // 行为与加这两个字段之前**逐字相同**。
            flowByTier: config.flowByTier,
            effortByTier: config.effortByTier,
            stageText,
            taskEcho,
            statsFooter,
          })
        },
      }),
    'dsh-coding-mode: protocol section',
  )

  /* ---------------- ⑧ 计划门禁：单调守卫 + 计数 ---------------- */

  /**
   * 计划门禁：同步拒绝，任何插件都翻不回来。
   * 计数口径：拦截 → `gateDenials`；**计划模式确实生效且仍被放行**（例如 bash/read，
   * 计划期本来就该能读）→ `gateAllows`。二者互斥，加起来就是门禁的真实话语次数。
   */
  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        const gateOn = planGateOn()
        const planActive = exec?.agent ? planModeActive(ctx, exec.agent) : undefined
        const reason = planGateDecision({
          planGate: gateOn,
          toolName: exec?.name,
          planActive,
        })
        if (typeof reason === 'string') bump('gateDenials')
        else if (gateOn && planActive === true) bump('gateAllows')
        return reason
      }),
    'dsh-coding-mode: plan gate',
  )

  /* ---------------- ⑪ 硬流程门（flowGate，默认关） ----------------
   *
   * **为什么默认关**：这两道门会**直接拒绝工具调用**、还会驳回轮次收尾。
   * 对已经跑顺的工作流来说，它们是打断式的 —— 老会话里没有计划信号、
   * 或者模型觉得"改完再说"的时候，突然写不了文件会让人以为插件坏了。
   * 所以它是**可选开关且默认关**：只有用户明确要"硬"（要流程不许跳过）时才打开。
   * 不动默认值时，下面的守卫永远返回 undefined，工具面与行为与从前逐条一致。
   * ------------------------------------------------------------------------ */

  /**
   * 「计划前置门」拒绝理由。
   *
   * 硬门的第一原则：**拒绝理由必须告诉模型怎么解**。
   * 这是一道同步的单调守卫，模型被拒之后唯一能拿到的信息就是这段文本；
   * 只写"被拒绝"等于把模型锁死在同一个调用上反复撞墙 ——
   * 门的作用是**纠正流程**，不是拦住工作。
   */
  function buildPlanRequiredReason() {
    return (
      '【编程模式 · 计划前置门】拒绝本次 write / edit：本次会话还没有任何"计划信号"。\n\n'
      + '硬流程门（flowGate）要求：**动手改文件之前，先把计划外化**。'
      + '怎么解（任选一条，做完立刻可以继续写）：\n'
      + '1. 用 `todo_write` 把计划写成待办（目标 / 验收标准 / 步骤）；或\n'
      + '2. 用 `exit_plan_mode` 把计划交给用户确认；或\n'
      + '3. 让用户进入计划模式并确认计划。\n\n'
      + '注意：`bash` / `read` / `grep` / `glob` 不受本门限制 —— 先看代码、先跑命令都可以。'
    )
  }

  /**
   * 「验证前置门」拒绝理由（阶段 3 且有未验证的写）。
   *
   * 与交付门的区别：交付门拦的是"收尾"，这道门拦的是"继续改" ——
   * 改完没验证就接着大改，会把两处改动混在一起，出问题无法归因。
   */
  function buildVerifyRequiredReason() {
    return (
      '【编程模式 · 验证前置门】拒绝本次 write / edit：你已经进入阶段 3（验证/交付），'
      + '但自**最后一次成功的 write / edit** 之后，还没有跑过任何**成功**的验证类工具'
      + '（`bash` / `read` / `grep` / `glob` / `read_image`）。\n\n'
      + '先验证再继续改（否则两处改动混在一起，出问题无法归因）：\n'
      + '1. 跑一次能证明改动生效的真实命令（`node --test` / 编译 / 实际调用），**原样**贴出输出；\n'
      + '2. 或用 `read` 把改动后的文件读回来，确认改动确实落盘。\n\n'
      + '注意：**报错的命令不算验证** —— 失败的命令什么都没核验到，本门不会因此解除。'
    )
  }

  /**
   * 硬流程门守卫（`ctx.tools.guard`，与计划门禁同一机制、可叠加）。
   *
   * 判定顺序刻意是"计划在前、验证在后"：
   *   ① 计划前置门：整场没有计划信号 → 一律拒绝 write / edit；
   *   ② 验证前置门：阶段 3（终态）且水线未降 → 拒绝 write / edit，要求先验证。
   *
   * 三个刻意的取舍：
   *   - **`flowGate` 关闭时立刻返回 undefined**：默认路径上这道守卫是**完全惰性**的
   *     （不读会话、不折叠事件），所以不会给默认行为带来任何副作用；
   *   - **拿不到会话时放行**：计划信号与阶段都挂在会话上，没有会话就没有可判据的状态。
   *     拒绝一个判不了的调用会把工具面卡死，而拒绝从来不是目的；
   *   - **守卫自己绝不抛**：`tools.guard` 的返回值直接参与工具执行，
   *     一个抛出的守卫会打断用户的操作。任何意外都退化成"放行"。
   */
  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        try {
          // 默认关：读不到配置也按关处理（switchOff 口径），老 profile 完全不受影响。
          if (!settings().flowGate) return undefined

          const name = exec?.name
          if (typeof name !== 'string' || !WRITE_TOOLS.includes(name)) return undefined

          const agent = exec?.agent
          const session = agent?.session
          if (!session) return undefined

          const state = ensureState(session)

          // ① 计划前置门
          if (!hasPlanSignal(state, agent)) return buildPlanRequiredReason()

          // ② 验证前置门（阶段 3 = 终态 = STAGE_COUNT - 1）
          if (state.stage >= STAGE_COUNT - 1 && state.unverifiedWrite) return buildVerifyRequiredReason()

          return undefined
        } catch {
          // 守卫抛错会打断工具执行 —— 门自己的 bug 绝不能变成用户的故障。
          return undefined
        }
      }),
    'dsh-coding-mode: flow gate',
  )
}
