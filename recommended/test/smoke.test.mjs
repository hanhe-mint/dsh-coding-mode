/**
 * smoke.test.mjs — 对拆分后两半插件的真实冒烟测试。
 *
 * 不是纯函数测试：它真的 import 两个模块、真的调用 `apply(ctx, config)`，
 * 用桩 ctx 捕获「注册了什么」，再断言注册出来的东西行为正确。
 * 提示段 / 门禁 / 事件监听全部**真实驱动一遍**，而不是只看有没有注册。
 *
 * 拆分的背景（见 bundle/cordis.patch.yml 顶部注释）：
 *   - `../bundle/index.js`（Host 半侧，顶层可寻址条目）：持有 volatile 配置字段，
 *     把当前生效值注册成 `codingModeSettings` 服务。它自己不做事。
 *   - `../bundle/preset.js`（preset 半侧，preset 的 plugins 列表里那一行）：
 *     **任务编排行为层** —— 首轮分类 / persona / 近场引导 / 任务回显 / 阶段指引 /
 *     交付门 / 子代理分档 / 计数。
 *
 * 桩 ctx 因此要实现 `provide` / `set` / `get` 这条服务链，外加 `on`（事件监听）
 * 与 `emit`（把事件真的派发给监听器），才能验证真实通路。
 *
 * 用法：node --import ./register.mjs --test smoke.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply as hostApply,
  Config,
  inject as hostInject,
  name as hostName,
  SETTINGS_FIELDS,
  SETTINGS_SERVICE,
} from '../bundle/index.js'
import { apply as presetApply, inject as presetInject, name as presetName } from '../bundle/preset.js'

/* ══════════════════════════ 桩：最小可用的 ctx ══════════════════════════ */

/**
 * 造一个最小可用的桩 ctx，记录所有注册动作，并实现最小的服务容器 + 事件总线。
 *
 * 本次新增：`on(event, fn)` 与配套的 `emit`，因为行为层几乎全靠事件驱动
 * （`agent/inbox/claimed` / `agent/pre-step` / `agent/request` / `system-prompt/assemble`）。
 *
 * @param {object} [opts]
 * @param {any} [opts.planMode] 假的 planMode 服务；不传 = 该服务不存在
 * @param {number} [opts.sectionOrder] 假的中央 order
 * @param {any} [opts.sessionProjections] 假的会话投影服务
 * @param {any} [opts.settings] 假的 settings 服务；传了才会触发 ctx.inject(['settings']) 子上下文
 * @param {any} [opts.service] 预置的 codingModeSettings 服务（行为层用例用它当录播器）
 * @param {boolean} [opts.noOn] 故意不提供 ctx.on（验证插件对老 ctx 的容忍度）
 */
function makeCtx({ planMode, sectionOrder = 500, sessionProjections, settings, service, noOn } = {}) {
  const sections = []
  const guards = []
  const tools = []
  const effects = []
  const provided = []
  const services = new Map()
  const policies = []
  const listeners = new Map()

  const ctx = {
    fiber: { id: 'fake-fiber' },
    effect: (fn, label) => {
      effects.push(label)
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    provide: (key, value) => {
      provided.push(key)
      services.set(key, value)
      return () => services.delete(key)
    },
    set: (key, value) => {
      if (!services.has(key)) throw new Error(`cannot set property "${key}" without provide`)
      services.set(key, value)
      return true
    },
    get: (key) => {
      if (key === 'planMode') return planMode
      if (key === 'sessionProjections') return sessionProjections
      return services.get(key)
    },
    inject: (deps, callback) => {
      // 只有 settings 服务存在时才走子上下文；否则回调永不执行（模拟「依赖缺席」）。
      if (settings === undefined) return () => {}
      const child = {
        effect: (fn, label) => {
          effects.push(label)
          const d = fn()
          return typeof d === 'function' ? d : () => {}
        },
        settings: {
          configure: (policy, fiber) => {
            policies.push({ policy, fiber })
            return () => {}
          },
        },
      }
      callback(child)
      return () => {}
    },
    tools: {
      register: (def) => {
        tools.push(def)
        return () => {}
      },
      guard: (g) => {
        guards.push(g)
        return () => {}
      },
      // 故意提供 restrict：用来断言本插件**从不调用**它（restrict 会击穿前缀缓存）。
      restrict: (arg) => {
        tools.push({ __restrictCalled: arg })
        return () => {}
      },
    },
    systemPrompt: {
      section: (s) => {
        sections.push(s)
        return () => {}
      },
      getSectionOrder: () => sectionOrder,
    },
  }

  if (!noOn) {
    ctx.on = (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const arr = listeners.get(event) || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    }
  }

  if (service !== undefined) {
    services.set(SETTINGS_SERVICE, service)
    provided.push(SETTINGS_SERVICE)
  }

  /** 按 name 取一段（测试**不要用下标** —— 新增段会挤掉 sections.find((s) => s.name === 'coding-mode:protocol') 的含义）。 */
  const sectionByName = (name) => {
    const found = sections.find((s) => s && s.name === name)
    if (!found) throw new Error(`找不到提示段 "${name}"（现有：${sections.map((s) => s.name).join(', ')}）`)
    return found
  }
  return { ctx, sections, sectionByName, guards, tools, effects, provided, services, policies, listeners }
}

/** 把 Host 半侧装到桩 ctx 上，返回预设档位配置。 */
function bootHost(config = {}) {
  const stub = makeCtx()
  hostApply(stub.ctx, config)
  return stub
}

/** 把一个普通事件（emit 语义）派发给桩 ctx 上所有监听器。 */
async function emit(stub, event, ...args) {
  const fns = stub.listeners.get(event) || []
  const out = []
  for (const fn of fns) out.push(await fn(...args))
  return out
}

/**
 * 把一次 waterfall 派发给桩 ctx 上的监听器。
 * cordis 的 waterfall 语义：监听器拿到 `(payload, next)`，`next()` 返回下游结果。
 * 桩里按注册顺序串起来，最后一个的下游是 `downstream`。
 */
async function emitWaterfall(stub, event, payload, downstream) {
  const fns = stub.listeners.get(event) || []
  let out = downstream
  for (const fn of fns) {
    const prev = out
    out = await fn(payload, async () => prev)
  }
  return out
}

/* ══════════════════════ 行为层用例用的录播服务 ══════════════════════ */

/**
 * 两档的内置默认路由。
 *
 * **刻意从 Host 半侧 `Config` 的 schema default 推出来，而不是写死字面量**：
 *   - provider / model 的默认值是插件主人的选择，会随实测结论调整
 *     （本轮就从 dieqiyun 中转切到了 deepseek-official 官方渠道：
 *      官方前缀缓存稳定 8/8、命中率 88%~96%，中转站带 tools 时 token 数会抖）；
 *   - 写死会让"换一次渠道 → 一批用例集体变红"的噪音盖过真实回归；
 *   - 更重要的是：这样还**顺带断言了两个半侧的默认值必须一致** ——
 *     `preset.js` 的 `BUILTIN_DEFAULTS`（读不到服务时的兜底）与
 *     `index.js` 的 `Config` 默认值一旦分叉，下面的用例就会失败。
 */
const DEFAULT_TIERS = {
  flash: {
    provider: Config.def.flashProvider.def,
    model: Config.def.flashModel.def,
    reasoningEffort: Config.def.flashReasoningEffort.def,
  },
  pro: {
    provider: Config.def.proProvider.def,
    model: Config.def.proModel.def,
    reasoningEffort: Config.def.proReasoningEffort.def,
  },
}

/**
 * 一份**全零**的统计快照（形状与 index.js 的 stats() 一致）。
 * `statsFooter` 用例的默认输入 —— 用来验证"全零不追加"。
 */
const ZERO_STATS = {
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
  stageBySession: {},
  tierRouted: { flash: 0, pro: 0 },
  startedAt: 0,
}

/**
 * 造一个会记录调用的 `codingModeSettings` 服务。
 * @param {object} [opts]
 * @param {object} [opts.overrides] read() 里要覆盖的字段（开关等）
 * @param {boolean} [opts.noBump] 故意不提供 bump 系列方法
 * @param {boolean} [opts.throwingBump] bump 系列方法故意抛错
 * @param {any} [opts.stats] stats() 的返回值（默认全零）；用于统计摘要用例
 * @param {boolean} [opts.noStats] 故意不提供 stats() 方法
 * @param {boolean} [opts.throwingStats] stats() 故意抛错
 */
function recordingService({ overrides = {}, noBump = false, throwingBump = false, stats, noStats = false, throwingStats = false } = {}) {
  const rec = { bumps: [], classes: [], stages: [], tiers: [] }
  const service = {
    read: () => ({ tiers: DEFAULT_TIERS, planGate: true, loopGuard: true, ...overrides }),
  }
  if (!noBump) {
    const push = (arr, value) => {
      if (throwingBump) throw new Error('bump exploded')
      arr.push(value)
    }
    service.bump = (key, by) => push(rec.bumps, { key, by })
    service.bumpClass = (form) => push(rec.classes, form)
    service.setStage = (sid, stage) => push(rec.stages, { sid, stage })
    service.bumpTier = (tier) => push(rec.tiers, tier)
  }
  if (!noStats) {
    service.stats = () => {
      if (throwingStats) throw new Error('stats exploded')
      return stats ?? ZERO_STATS
    }
  }
  return { service, rec }
}

/** 统计某个计数的出现次数。 */
function countBumps(rec, key) {
  return rec.bumps.filter((b) => b.key === key).length
}

/**
 * 造一个假的会话对象，**忠实模仿真实 DSH Session 的两个关键契约**：
 *   1. `seq` 是 getter，恒等于日志长度（源码里的 `seq = log.length` 连续性契约）；
 *   2. `snapshotEvents(from, to)` 就是日志切片（`log.slice(from, to)`）。
 * 插件正是靠这两个契约做 O(1) 变更探测与增量读取，桩里必须一致，否则测的不是真实语义。
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {any[]} [opts.events] 事件日志（可继续 push，`seq` 会随之增长）
 */
/**
 * 给事件日志补齐「计划信号工具的缺失结果」。
 *
 * 背景（本轮流程硬化 Task A2）：阶段推进现在一律以 `tool/result` 的 `ok` 为准，
 * 光有 `tool/call` 不再推进任何东西 —— 这是**刻意的**（失败的调用不该算完成）。
 *
 * 但既有一批夹具只写了 `todo_write` / `exit_plan_mode` 的 `tool/call` 就断言"阶段推进"，
 * 它们表达的是"这件事成功发生了"。与其逐个改夹具（易错、且会让断言与意图脱节），
 * 不如在造会话这一处统一补齐 —— **只在完全没有任何结果时才补**，
 * 所以显式写了 `isError: true` 的失败路径用例**完全不受影响**（那是本文件 2 处刻意测失败的用例）。
 *
 * @param {any[]} events 原始事件日志
 * @returns {any[]} 补齐后的事件日志（新数组，不改原数组）
 */
function withPlanSignalResults(events) {
  const list = Array.isArray(events) ? events : []
  const answered = new Set()
  for (const e of list) {
    if (e?.type !== 'tool/result') continue
    const d = e.data?.message
    const cid = d?.toolCallId ?? d?.source?.callId ?? d?.callId
    if (typeof cid === 'string' && cid) answered.add(cid)
  }
  const out = []
  for (const e of list) {
    out.push(e)
    if (e?.type !== 'tool/call') continue
    const name = e.data?.name
    const cid = e.data?.callId
    if (name !== 'todo_write' && name !== 'exit_plan_mode') continue
    if (typeof cid !== 'string' || !cid || answered.has(cid)) continue
    out.push(ev('tool/result', { message: toolResultMessage(cid, false) }))
    answered.add(cid)
  }
  return out
}


function fakeSession(id, { parentSession, events = [], header } = {}) {
  // ⚠️ 必须**读取时**规范化，不能在这里拷成固定数组：
  // liveSession 会持续往 `events` 里 push，若此处生成快照，`seq` 就不再增长、
  // `snapshotEvents` 也读不到后续事件 —— 那会把整个增量推进路径测坏。
  const read = (from = 0, to = events.length) => withPlanSignalResults(events.slice(from, to))
  const len = () => withPlanSignalResults(events).length
  const session = {
    id,
    // `parentSession` 简写 = **spawn 子会话**：真实 DSH 里 `dsh-subagent` 的
    // `childSessionMeta()` 会给它写 `origin: 'subagent'`。带上这个字段才符合真机形状；
    // 想造 fork 子会话请显式传 `header: { parentSession: '...' }`（fork 不写 origin）。
    header: header ?? (parentSession === undefined ? {} : { parentSession, origin: 'subagent' }),
    snapshotEvents: read,
  }
  Object.defineProperty(session, 'seq', { get: len, enumerable: true })
  return session
}

/**
 * 造一个"活"的会话：日志数组可继续追加，用来驱动**增量推进**路径。
 * 真实 DSH 里日志只有这一份，桩里也必须只有一份。
 */
function liveSession(id, { parentSession } = {}) {
  const events = []
  const session = fakeSession(id, { parentSession, events })
  return {
    session,
    events,
    push: (type, data) => {
      const e = ev(type, data)
      e.seq = events.length
      events.push(e)
      // 这里**刻意不补**计划信号的结果：补齐由 fakeSession 的读取时规范化统一负责。
      // 若在这里也补一份，读取时再补一次就是重复插入（同一 callId 两条结果）。
      return e
    },
  }
}

/** 造一条会话事件。 */
function ev(type, data) {
  return { type, seq: 0, time: 0, data }
}

/** 造一条真实用户消息（source.kind === 'user'）。 */
function userMessage(text, id = `u-${text.length}-${text.charCodeAt(0)}`) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

/** 造一条插件注入的消息（v4 形状：`plugin:<name>`，见 preset.js 的 PLUGIN_SOURCE 注释）。 */
function pluginMessage(text) {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    source: { kind: 'plugin:someone-else' },
    content: [{ type: 'text', text }],
  }
}

/** 造一条助手文本事件（DSH 的真实形状：data.message.content）。 */
function assistantEvent(text) {
  return ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

/* ══════════════ 工具调用/结果（真实 v4 形状，A1/A2 的关键） ══════════════ */

/**
 * 造一条**真实 DSH 形状**的 tool-result 消息。
 *
 * 为什么必须按真实形状造：`dsh-llm` 的 `createToolResultMessage()` 只写
 *   `source: { kind:'tool', callId }` 与 `toolCallId: callId`，
 * **没有 `message.callId` 这个字段**（`dsh-session` 的校验器还硬要求
 * `toolCallId === source.callId`）。已在本机 `ref-dsh-src` 与打包 `app.asar` 双向确证。
 * 原先的桩用 `{ callId }`，于是"插件读错字段"这件事在单测里被完全掩盖了 ——
 * 现在真实形状必须被覆盖，同时保留旧形状的用例（见 file 尾部"兼容形状"一组）。
 */
function toolResultMessage(callId, isError) {
  return {
    role: 'tool',
    toolCallId: callId,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text: isError ? 'Error: boom' : 'ok' }],
    isError,
  }
}

/**
 * 一次**成功的**工具调用 = `tool/call` + `tool/result` 两条事件。
 *
 * 真实 DSH 里这两条必然成对出现（`ToolCallRecovery` 会在步骤失败时补记保守的错误结果），
 * 所以"只推 tool/call 不推 tool/result"是不真实的桩。A2 之后阶段推进与水位
 * **一律以结果的 ok 为准**，因此凡是要驱动阶段/水位的用例都必须用这一对。
 */
function okCall(callId, name) {
  return [
    ev('tool/call', { callId, name }),
    ev('tool/result', { message: toolResultMessage(callId, false) }),
  ]
}

/** 一次**失败的**工具调用（结果 isError=true）。A1/A2 的核心用例都靠它。 */
function failCall(callId, name) {
  return [
    ev('tool/call', { callId, name }),
    ev('tool/result', { message: toolResultMessage(callId, true) }),
  ]
}

/** liveSession 版的 `okCall`：往可增长的会话日志里推一对"成功调用"。 */
function pushOk(push, callId, name) {
  push('tool/call', { callId, name })
  push('tool/result', { message: toolResultMessage(callId, false) })
}

/** liveSession 版的 `failCall`。 */
function pushFail(push, callId, name) {
  push('tool/call', { callId, name })
  push('tool/result', { message: toolResultMessage(callId, true) })
}

/**
 * 旧的 `{ callId }` 形状（**真实 DSH 里不存在**，只为兼容旧会话日志与历史桩保留）。
 * 单独留一个工厂，是为了让"兼容形状仍然工作"这件事有**明确的、可被单测覆盖**的入口。
 */
function legacyResultEvent(callId, isError) {
  return ev('tool/result', { message: { callId, isError } })
}

/* ══════════════════ Host 半侧（顶层可寻址条目）══════════════════ */

test('index.js: 导出形态符合 Host 插件规范（apply + name + Config）', () => {
  assert.equal(hostName, 'dsh-coding-mode')
  assert.equal(typeof hostApply, 'function')
  assert.deepEqual(hostInject, [], 'Host 半侧不依赖必需服务（settings 是可选的 inject 子上下文）')
  assert.ok(Config && typeof Config === 'object', 'Config 必须存在（设置页表单靠它）')
})

test('index.js: Config 至少包含 flash/pro 两档 + 既有开关 + 全部新字段', () => {
  const keys = Object.keys(Config.def).sort()
  // 这 8 个是**不可缺**的既有字段（也是客户端的身份字段）。
  const REQUIRED = [
    'flashModel',
    'flashProvider',
    'flashReasoningEffort',
    'loopGuard',
    'planGate',
    'proModel',
    'proProvider',
    'proReasoningEffort',
  ]
  // 这 4 个是行为层开关（默认全开），属于**可增补**字段。
  const BEHAVIOR_SWITCHES = ['nearFieldGuide', 'stageGuide', 'taskEcho', 'tierSubagents']
  // D 项 2 个（A/B 实验开关）+ C 项 1 个（统计摘要）+ B 项 1 个（阶段硬门控）。
  const NEW_FIELDS = ['protocolSection', 'tierPolicy', 'statsFooter', 'stageRestrict']
  // 本轮新增：B 项的硬流程门 + C 项的推理强度策略。
  const LATEST_FIELDS = ['flowGate', 'effortPolicy']
  // 本轮再增：用户可自配的「档位 → 流程 / 子代理强度区间」覆盖表
  // （让非 DS 渠道也能按自己的档位名配差异，落实"有什么适配什么"）。
  const TIER_MAP_FIELDS = ['flowByTier', 'effortByTier']
  const allowed = new Set([...REQUIRED, ...BEHAVIOR_SWITCHES, ...NEW_FIELDS, ...LATEST_FIELDS, ...TIER_MAP_FIELDS])

  for (const k of REQUIRED) assert.ok(keys.includes(k), `缺少必需字段 ${k}`)
  for (const k of allowed) assert.ok(keys.includes(k), `缺少字段 ${k}`)
  for (const k of keys) assert.ok(allowed.has(k), `出现未预期字段 ${k}`)
  assert.ok(!keys.includes('memory'), '不得有长期记忆开关（防作弊）')
  assert.ok(!keys.includes('sectionOrder'), 'sectionOrder 是无效旋钮，应已删除')
  assert.equal(keys.length, 20, '设置页字段最终应为 20 项（18 + flowByTier/effortByTier）')
  assert.equal(SETTINGS_FIELDS.length, 20, 'SETTINGS_FIELDS 最终应为 20 项')
  assert.deepEqual(
    [...SETTINGS_FIELDS].sort(),
    keys,
    '导出的 SETTINGS_FIELDS 必须与 Config 字段完全一致（客户端页面靠它结构识别命名空间）',
  )
  // 客户端身份字段**必须**仍是最早的 8 个：老 profile 只写了前 8 项，
  // 用更多字段去卡结构识别会让这类用户的 ns 识别失败。
  // 所以这条断言是**位置敏感**的（不是集合相等），顺序错一位就要红。
  assert.deepEqual(
    [...SETTINGS_FIELDS].slice(0, 8),
    [
      'flashProvider',
      'flashModel',
      'flashReasoningEffort',
      'proProvider',
      'proModel',
      'proReasoningEffort',
      'planGate',
      'loopGuard',
    ],
    '前 8 个字段的位置与顺序都不能变（客户端 IDENTITY_FIELDS 依赖它们）',
  )
})

test('index.js: flowGate / effortPolicy 的默认值是刻意的', () => {
  // B 项：硬流程门**默认关** —— 它会拒绝 write/edit 并驳回轮次收尾，默认开就是惊吓。
  assert.equal(Config.def.flowGate.def, false)
  assert.equal(Config.def.flowGate.meta?.volatile, true)
  // C 项：推理强度策略默认 auto（模型按任务自选），且同样必须可在线修改。
  assert.equal(Config.def.effortPolicy.def, 'auto')
  assert.equal(Config.def.effortPolicy.meta?.volatile, true)

  // 两个字段都必须出现在 read() 里，否则 preset 半侧永远读不到。
  const { ctx, services } = makeCtx()
  hostApply(ctx, {})
  const snap = services.get(SETTINGS_SERVICE).read()
  assert.equal(snap.flowGate, false)
  assert.equal(snap.effortPolicy, 'auto')
})

test('index.js: flowGate 只有显式 true 才算开；effortPolicy 非法值退回 auto', () => {
  for (const bad of [undefined, null, 0, '', 'yes', 1, {}]) {
    const { ctx, services } = makeCtx()
    hostApply(ctx, { flowGate: bad })
    assert.equal(services.get(SETTINGS_SERVICE).read().flowGate, false, `flowGate=${String(bad)} 应退 false`)
  }
  const { ctx, services } = makeCtx()
  hostApply(ctx, { flowGate: true })
  assert.equal(services.get(SETTINGS_SERVICE).read().flowGate, true)

  for (const bad of ['', 'AUTO!', 'fixd', null, undefined, 42, {}]) {
    const { ctx: c2, services: s2 } = makeCtx()
    hostApply(c2, { effortPolicy: bad })
    assert.equal(s2.get(SETTINGS_SERVICE).read().effortPolicy, 'auto', `非法值 ${String(bad)} 应退回 auto`)
  }
  for (const [given, expected] of [['fixed', 'fixed'], ['FIXED', 'fixed'], [' Fixed ', 'fixed'], ['auto', 'auto']]) {
    const { ctx: c3, services: s3 } = makeCtx()
    hostApply(c3, { effortPolicy: given })
    assert.equal(s3.get(SETTINGS_SERVICE).read().effortPolicy, expected)
  }
})

test('index.js: flowBlocked 进计数白名单，并出现在 stats() 里', () => {
  const { ctx, services } = makeCtx()
  hostApply(ctx, {})
  const service = services.get(SETTINGS_SERVICE)
  assert.equal(service.stats().flowBlocked, 0, '初始为 0')
  service.bump('flowBlocked')
  service.bump('flowBlocked', 3)
  assert.equal(service.stats().flowBlocked, 4)
  // 拼错的名字仍然被丢弃（白名单语义不变）
  service.bump('flowblocked')
  assert.equal(service.stats().flowBlocked, 4)
})

test('index.js: 4 个新字段的默认值是刻意的（实验开关默认关）', () => {
  // D 项：协议段默认开（默认行为＝全开，用户只做减法）
  assert.equal(Config.def.protocolSection.def, true)
  assert.equal(Config.def.protocolSection.meta?.volatile, true)
  // D 项：档位策略默认 auto
  assert.equal(Config.def.tierPolicy.def, 'auto')
  assert.equal(Config.def.tierPolicy.meta?.volatile, true)
  // C/B 项：实验期开关**默认关** —— 默认开会让所有人多付 token / 多一个会变的状态源
  assert.equal(Config.def.statsFooter.def, false)
  assert.equal(Config.def.statsFooter.meta?.volatile, true)
  assert.equal(Config.def.stageRestrict.def, false)
  assert.equal(Config.def.stageRestrict.meta?.volatile, true)

  // 4 个新字段都必须出现在 read() 里，否则 preset 半侧永远读不到
  const { ctx, services } = makeCtx()
  hostApply(ctx, {})
  const snap = services.get(SETTINGS_SERVICE).read()
  for (const k of ['protocolSection', 'tierPolicy', 'statsFooter', 'stageRestrict']) {
    assert.ok(k in snap, `read() 必须带上 ${k}`)
  }
  assert.equal(snap.statsFooter, false)
  assert.equal(snap.stageRestrict, false)
  assert.equal(snap.tierPolicy, 'auto')
})

test('index.js: tierPolicy 非法值一律退回 auto（写错一个字母不该强制换档）', () => {
  for (const bad of ['', 'AUTO!', 'pro x', null, undefined, 42, {}, 'flsh', 'ProMax']) {
    const { ctx, services } = makeCtx()
    hostApply(ctx, { tierPolicy: bad })
    assert.equal(services.get(SETTINGS_SERVICE).read().tierPolicy, 'auto', `非法值 ${String(bad)} 应退回 auto`)
  }
  // 合法值逐字保留（大小写不敏感，前后空白容忍）
  for (const [given, expected] of [['flash', 'flash'], ['pro', 'pro'], ['AUTO', 'auto'], [' Pro ', 'pro']]) {
    const { ctx, services } = makeCtx()
    hostApply(ctx, { tierPolicy: given })
    assert.equal(services.get(SETTINGS_SERVICE).read().tierPolicy, expected)
  }
})

test('index.js: 两个新计数进白名单，且 stats() 里有它们', () => {
  const { ctx, services } = makeCtx()
  hostApply(ctx, {})
  const service = services.get(SETTINGS_SERVICE)
  assert.equal(service.stats().deliveryBlocked, 0)
  assert.equal(service.stats().deliveryGiveUp, 0)
  service.bump('deliveryBlocked')
  service.bump('deliveryGiveUp', 2)
  assert.equal(service.stats().deliveryBlocked, 1)
  assert.equal(service.stats().deliveryGiveUp, 2)
  // 非白名单里没有它们以外的名字：随便一个拼错的 key 仍然被丢弃
  service.bump('deliveryblocked')
  assert.equal(service.stats().deliveryBlocked, 1)
})

test('index.js: 两档每个字段都可在设置页编辑（都有 volatile 标记）', () => {
  for (const k of [
    'flashProvider',
    'flashModel',
    'flashReasoningEffort',
    'proProvider',
    'proModel',
    'proReasoningEffort',
    'planGate',
    'loopGuard',
  ]) {
    assert.equal(Config.def[k].meta?.volatile, true, `${k} 必须是 volatile（否则设置页改不了）`)
  }
})

test('index.js: 默认档位是官方渠道 + flash/pro 各自模型', () => {
  // 注意：provider / model 的默认值是**插件主人的选择**，会随实测结论调整
  // （本轮就从 dieqiyun 中转切到了 deepseek-official 官方渠道，
  // 依据是官方前缀缓存稳定、中转站带 tools 时 token 数会抖）。
  // 这条用例的作用是"默认值被改动时能被立刻发现"，所以这里如实钉住当前值。
  assert.equal(Config.def.flashProvider.def, 'deepseek-official')
  assert.equal(Config.def.proProvider.def, 'deepseek-official')
  assert.equal(Config.def.flashModel.def, 'deepseek-flash')
  assert.equal(Config.def.proModel.def, 'deepseek-v4-pro')
  assert.equal(Config.def.flashReasoningEffort.def, 'high')
  assert.equal(Config.def.proReasoningEffort.def, 'high')
})

test('index.js: 不再自己注入提示段/门禁（那件事已经搬到 preset 半侧）', () => {
  const { ctx, sections, guards, tools } = makeCtx()
  hostApply(ctx, {})
  assert.equal(sections.length, 0, 'Host 半侧不应再注入提示段')
  assert.equal(guards.length, 0, 'Host 半侧不应再注册门禁')
  assert.equal(tools.length, 0, '不应注册任何模型可见的工具')
})

test('index.js: 把当前生效配置注册成 codingModeSettings 服务', () => {
  const { ctx, provided, services } = makeCtx()
  hostApply(ctx, { flashModel: 'my-flash' })
  assert.deepEqual(provided, [SETTINGS_SERVICE])
  const service = services.get(SETTINGS_SERVICE)
  assert.equal(typeof service.read, 'function', '服务必须提供 read()')
  assert.equal(service.read().tiers.flash.model, 'my-flash')
})

test('index.js: read() 每次重新求值（配置改了，下一次读就是新值）', () => {
  const { ctx, services } = makeCtx()
  let model = 'first-model'
  const live = { get: () => model }
  hostApply(ctx, { proModel: live, proProvider: 'p', proReasoningEffort: 'max' })
  const service = services.get(SETTINGS_SERVICE)
  assert.equal(service.read().tiers.pro.model, 'first-model')
  model = 'second-model'
  assert.equal(service.read().tiers.pro.model, 'second-model', 'read() 必须是活的，不能缓存')
})

test('index.js: 服务读不到配置时也不抛，gate 开关默认开', () => {
  const { ctx, services } = makeCtx()
  hostApply(ctx, undefined)
  const snap = services.get(SETTINGS_SERVICE).read()
  assert.equal(snap.planGate, true)
  assert.equal(snap.loopGuard, true)
})

test('index.js: 自带可视化页面 → 登记 settings 呈现策略 auto:false', () => {
  const { ctx, policies } = makeCtx({ settings: {} })
  hostApply(ctx, {})
  assert.equal(policies.length, 1, '应恰好登记 1 次呈现策略')
  assert.deepEqual(policies[0].policy, { auto: false })
  assert.equal(policies[0].fiber, ctx.fiber, '策略必须挂在本插件自己的 fiber 上')
})

test('index.js: 没有 settings 服务时不登记策略、也不报错', () => {
  const { ctx, policies } = makeCtx()
  assert.doesNotThrow(() => hostApply(ctx, {}))
  assert.equal(policies.length, 0)
})

/* ══════════════════ preset 半侧（真正做事的插件）══════════════════ */

test('preset.js: 导出形态符合「做事插件」规范', () => {
  assert.equal(typeof presetName, 'string')
  assert.equal(typeof presetApply, 'function')
  assert.deepEqual(presetInject, ['tools', 'systemPrompt'])
})

test('apply: 只注册一个协议段 + 两个守卫（计划门禁 + 硬流程门），不给工具面增加负担', () => {
  const { ctx, sections, guards, tools } = makeCtx()
  presetApply(ctx, {})
  assert.equal(sections.length, 1, '应只有协议段一段')
  // 守卫有**两个**：计划门禁（既有）与硬流程门（flowGate，默认关）。
  // 两者都是 `ctx.tools.guard` 的单调守卫（可叠加），flowGate 关闭时后者永远返回 undefined。
  assert.equal(guards.length, 2, '应有 2 个守卫（计划门禁 + 硬流程门）')
  assert.equal(tools.length, 0, '不应注册任何模型可见的工具（含 restrict 调用）')
})

test('apply: flowGate 关闭（默认）时，硬流程门守卫完全惰性 —— 任何 write/edit 都放行', () => {
  // 这是"默认关 = 现有行为逐条不变"的核心证据之一：
  // 守卫虽然注册了，但关掉开关时它不读会话、不折叠事件、直接返回 undefined。
  const { service } = recordingService() // overrides 里没有 flowGate → 退默认 false
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  assert.equal(stub.guards.length, 2)
  const flowGuard = stub.guards[1]

  // 一个"什么都没有"的会话：阶段 0、没有计划信号、也没有计划模式服务。
  // 若守卫不是惰性的，这里必然拒绝 write —— 那是把默认行为改掉了。
  const session = fakeSession('s1', { events: [] })
  for (const name of ['write', 'edit', 'bash', 'read']) {
    assert.equal(
      flowGuard({ name, agent: { session } }),
      undefined,
      `flowGate 关闭时 ${name} 必须放行`,
    )
  }
  // 连"会话对象形状很怪"也不许抛（守卫抛错会打断工具执行）
  assert.equal(flowGuard({ name: 'write', agent: { session: null } }), undefined)
  assert.equal(flowGuard({ name: 'write' }), undefined)
  assert.equal(flowGuard({}), undefined)
})

test('apply: 协议段名字正确、order 取中央值', () => {
  const { ctx, sections } = makeCtx({ sectionOrder: 500 })
  presetApply(ctx, {})
  assert.equal(sections.find((s) => s.name === 'coding-mode:protocol').name, 'coding-mode:protocol')
  assert.equal(sections.find((s) => s.name === 'coding-mode:protocol').order, 500, '应优先用 getSectionOrder 的中央值')
})

test('apply: 中央 order 取不到时退回常量，不会变成 NaN', () => {
  const { ctx, sections } = makeCtx({ sectionOrder: undefined })
  presetApply(ctx, {})
  assert.ok(Number.isFinite(sections.find((s) => s.name === 'coding-mode:protocol').order), 'order 必须是有限数')
})

test('apply: 协议段的 text 是函数（配置改了立即生效，无需重注册）', () => {
  const { ctx, sections } = makeCtx()
  presetApply(ctx, {})
  const proto = sections.find((s) => s.name === 'coding-mode:protocol')
  assert.ok(proto, '应注册名为 coding-mode:protocol 的段')
  assert.equal(typeof proto.text, 'function')
  const rendered = proto.text()
  assert.ok(rendered.includes('## 编程模式'))
  assert.ok(rendered.includes('**flash**'))
  assert.ok(rendered.includes('**pro**'))
})

test('apply: 挂上行为层所需的事件监听（不是只挂提示段）', () => {
  const { ctx, listeners } = makeCtx()
  presetApply(ctx, {})
  for (const eventName of [
    'agent/inbox/claimed',
    'agent/pre-step',
    'agent/request',
    'agent/turn-stopping',
    'system-prompt/assemble',
  ]) {
    assert.equal((listeners.get(eventName) || []).length, 1, `必须监听 ${eventName}`)
  }
})

test('apply: 不监听 session/event（阶段推进只走单一真相来源，避免重复折叠）', () => {
  const { ctx, listeners } = makeCtx()
  presetApply(ctx, {})
  assert.equal(
    (listeners.get('session/event') || []).length,
    0,
    '若同时监听 session/event 又做增量读，同一批事件会被折叠两次 → 阶段多推一级',
  )
})

test('apply: 默认（stageRestrict 关闭）时从不调用 ctx.tools.restrict', async () => {
  // 阶段硬门控改成**可选开关且默认关**（B 项）。默认路径上必须一个 restrict 都不发 ——
  // 它多一个会变的状态源，没开的时候不该有任何痕迹。
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  assert.equal(stub.tools.length, 0, 'apply 阶段不应调用 restrict')

  // 连"走一遍 pre-step"也不该调：默认关就是真的关。
  const session = fakeSession('s1', { events: [] })
  const agent = { session, ctx: { get: () => undefined } }
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(stub.tools.length, 0, 'stageRestrict 关闭时 pre-step 也不该调用 restrict')
})

test('apply: 缺少 ctx.on 的老 ctx 上不崩（只是少了事件驱动的行为）', () => {
  const { ctx, sections } = makeCtx({ noOn: true })
  assert.doesNotThrow(() => presetApply(ctx, {}))
  assert.equal(sections.length, 1, '协议段仍应注册成功')
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes('## 编程模式'))
})

/* ══════════════════ ⑦b 保护 fork 的 KV 缓存复用 ══════════════════ */

test('⑦b fork 子会话：**绝不覆盖路由**（否则继承前缀再也命不中缓存）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // fork 的形状：有 parentSession，但**没有** origin（dsh-subagent 只给 spawn 写）。
  const forked = fakeSession('forked', { header: { parentSession: 'parent-1' } })

  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: forked } },
    { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'parent-effort' },
  )
  assert.equal(resolved.provider, 'parent-provider', 'fork 必须保留父的 provider（官方：route 覆盖会破坏前缀复用）')
  assert.equal(resolved.model, 'parent-model', 'fork 必须保留父的 model')
  assert.equal(resolved.reasoningEffort, 'parent-effort', 'fork 必须保留父的强度')
  assert.equal(rec.tiers.length, 0, 'fork 不该被计入分档（它没被分档）')
})

test('⑦b spawn 子会话：仍然正常分档（对照组）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { header: { parentSession: 'parent-1', origin: 'subagent' } })

  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: child } },
    { provider: 'parent-provider', model: 'parent-model' },
  )
  assert.equal(resolved.provider, DEFAULT_TIERS.flash.provider, 'spawn 应被分档')
  assert.equal(rec.tiers.length, 1, 'spawn 应计入分档')
})

test('⑦b fork 保护不受 tierPolicy 影响（强制档也不该碰 fork）', async () => {
  const { service } = recordingService({ overrides: { tierPolicy: 'pro' } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const forked = fakeSession('forked', { header: { parentSession: 'p' } })
  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: forked } },
    { provider: 'pp', model: 'pm' },
  )
  assert.equal(resolved.provider, 'pp', '强制档也不能改 fork 的路由')
  assert.equal(resolved.model, 'pm')
})

/* ══════════════════ 两半的接缝：Host 配置 → 服务 → 协议文本 ══════════════════ */

test('接缝: Host 半侧配的值，preset 半侧真的读得到（同一个作用域链）', () => {
  const { ctx, sections } = makeCtx()
  hostApply(ctx, {
    proProvider: 'my-provider',
    proModel: 'my-strong-model',
    proReasoningEffort: 'max',
    // C 项之后强度**默认 auto**（协议里不给固定值），所以要断言"配置的强度真的进了协议"
    // 就必须显式选 fixed —— 否则测的就不是这条接缝，而是 auto 的渲染。
    effortPolicy: 'fixed',
  })
  presetApply(ctx, {})
  const rendered = sections.find((s) => s.name === 'coding-mode:protocol').text()
  assert.ok(rendered.includes('my-provider'), '自定义 provider 应出现')
  assert.ok(rendered.includes('my-strong-model'), '自定义 model 应出现')
  assert.ok(rendered.includes('reasoning_effort=`max`'), '自定义推理强度应出现')
})

test('接缝: 设置页改了配置，preset 半侧下一个请求就用新值（不重注册）', () => {
  let model = 'old-model'
  const { ctx, sections } = makeCtx()
  hostApply(ctx, { flashModel: { get: () => model }, flashProvider: 'my-provider' })
  presetApply(ctx, {})
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes('old-model'))
  model = 'new-model'
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes('new-model'), 'text() 必须每次重新读服务')
  assert.ok(!sections.find((s) => s.name === 'coding-mode:protocol').text().includes('old-model'))
})

test('接缝: planGate=false 经服务传到门禁上（设置页能一键停用）', () => {
  const { ctx, guards } = makeCtx({ planMode: { loggedActive: () => true } })
  hostApply(ctx, { planGate: false })
  presetApply(ctx, {})
  assert.equal(guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), undefined)
})

/* ══════════════════ preset 半侧的优雅降级（读不到服务也不能崩）══════════════════ */

test('降级: 完全没有 codingModeSettings 服务 → 用内置默认值继续工作', () => {
  const { ctx, sections } = makeCtx()
  assert.doesNotThrow(() => presetApply(ctx, {}))
  const rendered = sections.find((s) => s.name === 'coding-mode:protocol').text()
  assert.ok(rendered.includes(DEFAULT_TIERS.flash.provider), '应退回内置默认 provider')
  assert.ok(rendered.includes(DEFAULT_TIERS.flash.model), '应退回内置默认 flash 模型')
  assert.ok(rendered.includes(DEFAULT_TIERS.pro.model), '应退回内置默认 pro 模型')
})

test('降级: 服务的 read() 抛错 → 用内置默认值，不冒泡', () => {
  const { ctx, sections } = makeCtx()
  ctx.provide(SETTINGS_SERVICE, {
    read: () => {
      throw new Error('boom')
    },
  })
  assert.doesNotThrow(() => presetApply(ctx, {}))
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes(DEFAULT_TIERS.flash.provider))
})

test('降级: 服务返回垃圾形状 → 用内置默认值，不抛', () => {
  const { ctx, sections } = makeCtx()
  ctx.provide(SETTINGS_SERVICE, { read: () => 'not-an-object' })
  assert.doesNotThrow(() => presetApply(ctx, {}))
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes(DEFAULT_TIERS.flash.provider))

  const partial = makeCtx()
  partial.ctx.provide(SETTINGS_SERVICE, { read: () => ({ tiers: { flash: { model: 'only-model' } } }) })
  presetApply(partial.ctx, {})
  const rendered = partial.sectionByName('coding-mode:protocol').text()
  assert.ok(rendered.includes('only-model'), '给了的字段要用')
  assert.ok(rendered.includes(DEFAULT_TIERS.pro.model), '没给的字段要补默认')
})

test('降级: 服务上没有 read 方法 → 用内置默认值，不抛', () => {
  const { ctx, sections } = makeCtx()
  ctx.provide(SETTINGS_SERVICE, {})
  assert.doesNotThrow(() => presetApply(ctx, {}))
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes(DEFAULT_TIERS.flash.provider))
})

test('降级: ctx.get 本身抛错 → 用内置默认值，不抛', () => {
  const { ctx, sections } = makeCtx()
  ctx.get = () => {
    throw new Error('no context')
  }
  assert.doesNotThrow(() => presetApply(ctx, {}))
  assert.ok(sections.find((s) => s.name === 'coding-mode:protocol').text().includes(DEFAULT_TIERS.flash.provider))
})

test('降级: 服务完全没有 bump/setStage/bumpTier → 全功能仍工作、不抛', async () => {
  const { service } = recordingService({ noBump: true })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  await assert.doesNotReject(async () => {
    await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })
    await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
    await emitWaterfall(stub, 'agent/request', { agent: { session: fakeSession('c1', { parentSession: 'p' }) } }, { provider: 'x', model: 'y' })
  })
})

test('降级: 服务的 bump 抛错 → 静默吞掉，编排照常完成', async () => {
  const { service, rec } = recordingService({ throwingBump: true })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  let decision
  await assert.doesNotReject(async () => {
    await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })
    decision = await emitWaterfall(
      stub,
      'agent/pre-step',
      { agent: { session }, messages: [] },
      { kind: 'enter', messages: [] },
    )
  })
  assert.ok(Array.isArray(decision.messages), '即便计数抛错，persona 仍应注入成功')
  assert.equal(rec.classes.length, 0, '抛错的计数不会留下记录')
})

test('降级: 服务完全缺失时，8 项行为全部退化为默认且不抛', async () => {
  const stub = makeCtx() // 没有任何 codingModeSettings
  presetApply(stub.ctx, {})
  const { session, push } = liveSession('s1')

  await assert.doesNotReject(async () => {
    await emit(stub, 'agent/inbox/claimed', {
      agent: { session },
      message: userMessage('登录接口报错了，一直返回 500，帮我修一下'),
    })
    push('tool/call', { callId: 'c1', name: 'todo_write' })
    const decision = await emitWaterfall(
      stub,
      'agent/pre-step',
      { agent: { session }, messages: [] },
      { kind: 'enter', messages: [], startsRequestSeries: true },
    )
    assert.equal(decision.startsRequestSeries, true, 'spread 改写必须保住别的字段')
    await emitWaterfall(
      stub,
      'agent/request',
      { agent: { session: fakeSession('c1', { parentSession: 'p' }) } },
      { provider: 'seed-provider', model: 'seed-model' },
    )
  })

  // 协议段仍能渲染，且用的是内置默认档位。
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('## 编程模式'))
  assert.ok(rendered.includes(DEFAULT_TIERS.flash.provider))

  // 门禁仍按失败开放放行。
  assert.equal(stub.guards[0]({ name: 'write', agent: { session } }), undefined)
})

/* ══════════════════ ① 首轮任务分类 ══════════════════ */

test('① 首轮分类: 首条真实用户消息被分类，并上报 bumpClass', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  await emit(stub, 'agent/inbox/claimed', {
    agent: { session },
    message: userMessage('帮我实现一个导出 CSV 的函数'),
  })
  assert.deepEqual(rec.classes, ['build'], '应分类为 build 并上报一次')
})

test('① 首轮分类: 故障类任务分类为 fix', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: fakeSession('s1') },
    message: userMessage('登录接口报错了，一直返回 500，帮我修一下'),
  })
  assert.deepEqual(rec.classes, ['fix'])
})

test('① 首轮分类: 插件注入的消息不算首轮任务', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: fakeSession('s1') },
    message: pluginMessage('【编程模式 · 首轮策略】……'),
  })
  assert.deepEqual(rec.classes, [], 'source.kind !== user 的消息必须被忽略')
})

test('① 首轮分类: 每条会话只认第一条真实用户消息', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('报错了，帮我修一下这个 bug') })
  assert.deepEqual(rec.classes, ['build'], '第二条不应覆盖首轮分类')

  // 另一条会话独立计数。
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: fakeSession('s2') },
    message: userMessage('报错了，帮我修一下这个 bug'),
  })
  assert.deepEqual(rec.classes, ['build', 'fix'], '不同会话各自记第一条')
})

test('① 首轮分类: resume 后能从会话事件重建首轮任务与分类', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 事件里已经有首轮用户消息（模拟进程重启后重新加载会话）。
  const session = fakeSession('s1', { events: [ev('user/message', userMessage('帮我实现一个导出 CSV 的函数'))] })

  // 触发一次 ensureState（走协议段渲染）。
  stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session },
    message: userMessage('后来又说了一句：顺便加个日志'),
  })
  assert.deepEqual(rec.classes, [], '首轮任务已从事件里恢复，后续消息不应再上报分类')

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('导出 CSV'), '任务回显应来自事件里重建的首轮任务')
})

test('① 首轮分类: 没有 session 的消息不崩', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  await assert.doesNotReject(async () => {
    await emit(stub, 'agent/inbox/claimed', { agent: {}, message: userMessage('随便什么') })
    await emit(stub, 'agent/inbox/claimed', {})
  })
})

/* ══════════════════ ② 首轮 persona 注入 ══════════════════ */

test('② persona: 首个请求注入一次，且计入 personaInjected', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  const decision = await emitWaterfall(
    stub,
    'agent/pre-step',
    { agent: { session }, messages: [] },
    { kind: 'enter', messages: [] },
  )
  assert.equal(decision.messages.length, 1, '应注入一条 persona')
  assert.ok(decision.messages[0].content[0].text.includes('首轮策略'), 'persona 文本应可识别')
  assert.equal(decision.messages[0].role, 'user')
  assert.equal(
    decision.messages[0].source.kind,
    'plugin:dsh-coding-mode',
    '注入消息必须是 v4 的 producer-owned kind（`plugin:<插件名>`）——`kind:"plugin"` 会被会话格式硬拒',
  )
  assert.equal(countBumps(rec, 'personaInjected'), 1)
})

/* ══════════════════ ②b source.kind 必须符合 v4 会话格式 ══════════════════ */

/**
 * 这个用例是为了**堵住一个真实事故**：插件曾用 `{kind:'plugin', plugin:'dsh-coding-mode'}`
 * （v3 旧形状）注入消息，v4 会话格式对此有硬校验，一旦写进会话日志就会抛
 * `format v4 message requires a producer-owned source kind`。
 * 当时测试夹具也用了同一个非法形状，所以**测试全绿但真机报错**——
 * 因此这里必须直接用格式规则断言，而不是断言"我们自己的写法"。
 *
 * 规则出处：`dsh-session-format-v3-to-v4/lib/lib/index.js:126` 与 `producerKind()`。
 */
test('②b source.kind: 任何注入消息都不得使用被 v4 拒绝的形状', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  // 两条注入通道都要抓：persona / 近场引导走 `decision.messages`（pre-step 改写），
  // 交付门走 `agent.steer|inject`。只抓一条会漏掉另一条。
  const seen = []
  const session = fakeSession('s1')
  const agent = {
    session,
    steer: (m) => seen.push(m),
    inject: (m) => seen.push(m),
    followup: (m) => seen.push(m),
  }
  const takeDecision = (d) => {
    for (const m of d?.messages ?? []) seen.push(m)
    return d
  }

  takeDecision(
    await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] }),
  )
  takeDecision(
    await emitWaterfall(
      stub,
      'agent/pre-step',
      {
        agent,
        messages: [
          { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我实现一个导出 CSV 的函数' }] },
        ],
      },
      { kind: 'enter', messages: [] },
    ),
  )
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })

  // 只检查**本插件产生的**消息：decision 里可能夹带调用方自己传进来的消息，那不是我们的责任。
  const ours = seen.filter((m) => typeof m?.source?.kind === 'string' && m.source.kind.includes('coding-mode'))
  assert.ok(
    ours.length > 0,
    `这个用例必须真的捕获到本插件的注入消息，否则它什么也没验证（共捕获 ${seen.length} 条，其中本插件 0 条）`,
  )

  for (const m of ours) {
    const kind = m.source.kind
    assert.notEqual(
      kind,
      'plugin',
      '`kind:"plugin"` 是已废弃的 v3 形状，v4 会抛 format v4 message requires a producer-owned source kind',
    )
    assert.ok(!('plugin' in m.source), '不得携带遗留的 `plugin` 字段（官方迁移器会丢掉它，说明它已不是身份来源）')
    assert.equal(kind, 'plugin:dsh-coding-mode', '必须是 producer-owned kind')
  }
})

test('② persona: 每条会话只注入一次（第二次不再注入）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  const first = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  const second = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(first.messages.length, 1)
  assert.equal(second.messages.length, 0, '第二次不应再注入 persona')
  assert.equal(countBumps(rec, 'personaInjected'), 1, '计数也只应有一次')
})

test('② persona: 按模型选型（flash 分支带"别重复/别跑环境自检"锚点，pro 分支不带）', async () => {
  // flash 模型 → flash 版 persona（含锚点）
  const flashStub = makeCtx({ service: recordingService().service })
  presetApply(flashStub.ctx, {})
  const flashSession = fakeSession('s1')
  await emit(flashStub, 'system-prompt/assemble', {}, { agent: { session: flashSession }, scope: flashSession }, async () => ({ variables: { model: DEFAULT_TIERS.flash.model } }))
  const flashDecision = await emitWaterfall(flashStub, 'agent/pre-step', { agent: { session: flashSession }, messages: [] }, { kind: 'enter', messages: [] })
  const flashText = flashDecision.messages[0].content[0].text
  assert.ok(flashText.includes('不要重复已完成的工作'), 'flash 分支应有"别重复"锚点')
  assert.ok(flashText.includes('环境自检'), 'flash 分支应有"别跑环境自检"锚点')

  // pro 模型 → pro 版 persona（刻意更短，不堆锚点）
  const proStub = makeCtx({ service: recordingService().service })
  presetApply(proStub.ctx, {})
  const proSession = fakeSession('s2')
  await emit(proStub, 'system-prompt/assemble', {}, { agent: { session: proSession }, scope: proSession }, async () => ({ variables: { model: DEFAULT_TIERS.pro.model } }))
  const proDecision = await emitWaterfall(proStub, 'agent/pre-step', { agent: { session: proSession }, messages: [] }, { kind: 'enter', messages: [] })
  const proText = proDecision.messages[0].content[0].text
  assert.ok(!proText.includes('环境自检'), 'pro 分支不应堆 flash 专属锚点（实测对 pro 有负收益）')

  // 两档都必须带"先分类再行动"这条弱带核心指令。
  assert.ok(flashText.includes('先判定任务类型'))
  assert.ok(proText.includes('先判定任务类型'))
})

test('② persona: 弱带（分类为 ambiguous）注入的是"先分类再行动"指令', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('嗯？') })

  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  const text = decision.messages[0].content[0].text
  assert.ok(text.includes('先判定任务类型'), '弱带必须有先分类再行动的指令')
  assert.ok(text.includes('信息不足'), '弱带应明确指出任务信息不足')
})

test('② persona: resume 后不会重复注入（从事件日志恢复"已注入"状态）', async () => {
  // 第一次运行：注入 persona，并把它当成持久化的 user/message 记进事件日志。
  const { service, rec } = recordingService()
  const first = makeCtx({ service })
  presetApply(first.ctx, {})
  const { session, push } = liveSession('s1')
  await emit(first, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })
  const d1 = await emitWaterfall(first, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(d1.messages.length, 1, '首轮应注入 persona')
  // 真实 DSH 会把 decision.messages 落成 user/message 事件。
  for (const m of d1.messages) push('user/message', m)

  // 进程重启：全新 stub，只靠同一份事件日志。
  const second = makeCtx({ service })
  presetApply(second.ctx, {})
  const reopened = fakeSession('s1', { events: session.snapshotEvents() })
  const d2 = await emitWaterfall(second, 'agent/pre-step', { agent: { session: reopened }, messages: [] }, { kind: 'enter', messages: [] })

  assert.equal(d2.messages.length, 0, '重启后不应在会话中途再注一次首轮策略')
  assert.equal(countBumps(rec, 'personaInjected'), 1, '计数也仍应只有一次')
})

test('② persona: 自己注入的 persona 消息不会被当成用户任务去分类', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', {
    events: [
      ev('user/message', {
        id: 'coding-mode-persona-abc-1',
        role: 'user',
        source: { kind: 'plugin:dsh-coding-mode' },
        content: [{ type: 'text', text: '【编程模式 · 首轮策略】你是一名务实的软件工程师……' }],
      }),
    ],
  })
  stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.deepEqual(rec.classes, [], '插件自己的 persona 消息不该产生分类计数')
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(!rendered.includes('本轮任务'), '也不该被当成"本轮任务"回显出来')
})

/* ══════════════════ ③ 近场引导 ══════════════════ */

test('③ 近场引导: 每条真实用户消息注入一次，且计入 guideInjected', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  const msg = userMessage('帮我实现一个导出 CSV 的函数', 'u1')

  const decision = await emitWaterfall(
    stub,
    'agent/pre-step',
    { agent: { session }, messages: [msg] },
    { kind: 'enter', messages: [] },
  )
  const guide = decision.messages.find((m) => m.content[0].text.includes('近距离引导'))
  assert.ok(guide, '应注入近场引导')
  assert.equal(countBumps(rec, 'guideInjected'), 1)
})

test('③ 近场引导: 同一条用户消息不会重复注入', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  const msg = userMessage('帮我实现一个导出 CSV 的函数', 'u1')
  const downstream = () => ({ kind: 'enter', messages: [msg] })

  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [msg] }, downstream())
  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [msg] }, downstream())
  assert.equal(countBumps(rec, 'guideInjected'), 1, '同一条消息只引导一次')
})

test('③ 近场引导: 新的用户消息会再注入一次', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [userMessage('帮我实现一个导出 CSV 的函数', 'u1')] }, { kind: 'enter', messages: [] })
  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [userMessage('再帮我加个单元测试', 'u2')] }, { kind: 'enter', messages: [] })
  assert.equal(countBumps(rec, 'guideInjected'), 2, '两条不同用户消息应各引导一次')
})

test('③ 近场引导: 插件注入的消息不触发引导', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [pluginMessage('运行时上下文……')] }, { kind: 'enter', messages: [] })
  assert.equal(countBumps(rec, 'guideInjected'), 0, '只有 source.kind === user 才引导')
})

test('③ 近场引导: 复杂任务用"决策闭合"版引导', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  const msg = userMessage('帮我重构这个模块的并发架构', 'u-complex')
  // 分类与引导都由同一条用户消息驱动：分类在 claim 阶段，引导在 pre-step 阶段。
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: msg })

  const decision = await emitWaterfall(
    stub,
    'agent/pre-step',
    { agent: { session }, messages: [msg] },
    { kind: 'enter', messages: [] },
  )
  const guide = decision.messages.find((m) => m.content[0].text.includes('近距离引导'))
  assert.ok(guide, '应注入近场引导')
  assert.ok(guide.content[0].text.includes('复杂任务'), '复杂任务应走深引导')
})

test('③ 近场引导: 关掉 nearFieldGuide 开关后不再注入', async () => {
  const { service, rec } = recordingService({ overrides: { nearFieldGuide: false } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')

  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [userMessage('帮我实现一个导出 CSV 的函数', 'u1')] }, { kind: 'enter', messages: [] })
  assert.equal(countBumps(rec, 'guideInjected'), 0)
})

test('③ 近场引导: decision 被 spread 改写 —— startsRequestSeries 等字段不丢', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  const downstream = { kind: 'enter', messages: [], startsRequestSeries: true, someOtherField: 42 }

  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [userMessage('帮我实现一个导出 CSV 的函数', 'u1')] }, downstream)
  assert.equal(decision.startsRequestSeries, true, 'startsRequestSeries 必须保住')
  assert.equal(decision.someOtherField, 42, '其它未知字段也必须保住')
  assert.equal(decision.kind, 'enter')
  assert.ok(decision.messages.length > 0, 'messages 是新数组')
  assert.notEqual(decision.messages, downstream.messages, '必须是新数组，不是原地改下游对象')
})

test('③ 近场引导: kind !== "enter" 时原样透传（不擅自改别人的决定）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  const reject = { kind: 'reject', messages: [], reason: 'blocked' }

  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [userMessage('帮我实现一个导出 CSV 的函数', 'u1')] }, reject)
  assert.equal(decision, reject, '必须原样返回同一个对象')
  assert.equal(countBumps(rec, 'personaInjected'), 0, 'reject 时连 persona 都不该注')
})

test('③ 近场引导: 无事可做时返回下游结果本身（不自己造对象）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  // 先消耗掉 persona。
  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })

  const downstream = { kind: 'enter', messages: [] }
  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, downstream)
  assert.equal(decision, downstream, '没有要注入的东西时应原样透传下游结果')
})

/* ══════════════════ ④ 任务回显 ══════════════════ */

test('④ 任务回显: 首条真实任务文本进协议段，并计入 taskEchoed', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session },
    message: userMessage('帮我实现一个导出 CSV 的函数'),
  })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('本轮任务'), '应渲染任务回显块')
  assert.ok(rendered.includes('导出 CSV'), '应含任务原文')
  assert.ok(countBumps(rec, 'taskEchoed') >= 1)
})

test('④ 任务回显: 截断到 160 字符', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  const long = `实现一个东西${'补'.repeat(400)}`
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage(long) })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  // 回显块在「本轮任务」标题的下一行（协议正文里也有别的引用块，不能瞎找第一行）。
  const lines = rendered.split('\n')
  const head = lines.findIndex((l) => l.includes('本轮任务'))
  assert.ok(head >= 0, '应渲染回显标题')
  const line = lines[head + 2]
  assert.ok(line.startsWith('> '), `回显行应是引用块（实际：${line}）`)
  assert.ok(line.length <= 165, `回显应被截断（实际 ${line.length}）`)
  assert.ok(line.includes('…'), '截断应有省略号')
})

test('④ 任务回显: 关掉 taskEcho 开关后不再渲染', async () => {
  const { service, rec } = recordingService({ overrides: { taskEcho: false } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1')
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(!rendered.includes('本轮任务'), '关掉后不应出现回显块')
  assert.equal(countBumps(rec, 'taskEchoed'), 0)
})

/* ══════════════════ ⑤ 阶段指引 ══════════════════ */

test('⑤ 阶段推进: 日志增长后在下一次触碰时被增量吸收，并上报 setStage', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const { session, push } = liveSession('s1')

  // 真实顺序：claim 先发生（插件在这一刻第一次碰到会话 → 读一遍日志），
  // 之后每次工具调用追加事件，下一次触碰（下一个 step）吸收增量。
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })
  push('tool/call', { callId: 'c1', name: 'todo_write' })
  await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：1 · 拟合方案'), 'todo_write 应把阶段推到 1')
  assert.ok(rec.stages.some((s) => s.stage === 1), '阶段变化应上报 setStage')
  assert.equal(rec.stages.at(-1).sid, 's1')
})

test('⑤ 阶段推进: 增量读与整段重建得到同一阶段（两条路一致）', async () => {
  const { service, rec } = recordingService()
  const live = makeCtx({ service })
  presetApply(live.ctx, {})
  const { session, push } = liveSession('s1')

  // 忠实还原真实顺序：inbox 里认领 + 同一条消息落进 user/message 事件日志，
  // 之后每次工具调用都追加 tool/call 事件。
  const task = userMessage('帮我实现一个导出 CSV 的函数')
  await emit(live, 'agent/inbox/claimed', { agent: { session }, message: task })
  push('user/message', task)
  push('tool/call', { callId: 'c1', name: 'todo_write' })
  push('tool/call', { callId: 'c2', name: 'exit_plan_mode' })
  // 每次 push 之后都触碰一次 → 走**增量**路径逐条吸收。
  await emitWaterfall(live, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  const liveText = live.sectionByName('coding-mode:protocol').text({ agent: { session } })

  // 全新 stub（= 进程重启），只靠同一份日志一次读到底 → 走**整段重建**路径。
  const restarted = makeCtx({ service })
  presetApply(restarted.ctx, {})
  const reopened = fakeSession('s1', { events: session.snapshotEvents() })
  const rescanText = restarted.sectionByName('coding-mode:protocol').text({ agent: { session: reopened } })

  assert.equal(liveText, rescanText, '增量推进与整段重建必须得出完全一致的文本（resume-safe）')
  assert.ok(liveText.includes('### 当前阶段：2 · 开发'))
  assert.ok(liveText.includes('导出 CSV'), '任务回显在两条路上都应恢复')
  assert.ok(rec.stages.some((s) => s.stage === 2))
})

test('⑤ 阶段推进: 完成信号链 0→1→2→3', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'c1', name: 'todo_write' }),
    ev('tool/call', { callId: 'c2', name: 'exit_plan_mode' }),
    ev('tool/call', { callId: 'c3', name: 'write' }),
    ev('tool/result', { message: { callId: 'c3', isError: false } }),
  ]
  const session = fakeSession('s1', { events })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：3 · 验证/交付'), '完成信号链应把阶段推到 3')
  assert.equal(rec.stages.at(-1).stage, 3)
  assert.equal(rec.stages.at(-1).sid, 's1')
})

test('⑤ 阶段推进: 失败的 write 不算完成信号（停在阶段 2）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'c1', name: 'todo_write' }),
    ev('tool/call', { callId: 'c2', name: 'exit_plan_mode' }),
    ev('tool/call', { callId: 'c3', name: 'write' }),
    ev('tool/result', { message: { callId: 'c3', isError: true } }),
  ]
  const session = fakeSession('s1', { events })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：2 · 开发'), '失败的 write 不应推进到 3')
})

test('⑤ 阶段推进: 一次只进一级（同一个 todo_write 不能把 0 顶到 2）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: [ev('tool/call', { callId: 'c1', name: 'todo_write' })] })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：1 · 拟合方案'), '单次 todo_write 只到 1')
  assert.ok(!rec.stages.some((s) => s.stage === 2), '不应越级')
})

test('⑤ 阶段推进: 阶段只前进不后退（重放幂等）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: [ev('tool/call', { callId: 'c1', name: 'todo_write' })] })

  stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  const a = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  const b = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.equal(a, b, '同一批事件重复渲染必须得到同一结果（resume-safe 的前提）')
})

test('⑤ 阶段指引: 四阶段的文本都可渲染，且是中文、含完成标准', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  const seen = new Set()
  const cases = [
    { events: [], expect: '了解/对齐' },
    { events: [ev('tool/call', { callId: 'a', name: 'ask_user_question' })], expect: '拟合方案' },
    {
      events: [
        ev('tool/call', { callId: 'a', name: 'todo_write' }),
        ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
      ],
      expect: '开发',
    },
    {
      events: [
        ev('tool/call', { callId: 'a', name: 'todo_write' }),
        ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
        ev('tool/call', { callId: 'c', name: 'write' }),
        ev('tool/result', { message: { callId: 'c', isError: false } }),
      ],
      expect: '验证/交付',
    },
  ]
  let i = 0
  for (const c of cases) {
    i += 1
    const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session: fakeSession(`stage-${i}`, { events: c.events }) } })
    assert.ok(rendered.includes(c.expect), `应渲染出「${c.expect}」`)
    assert.ok(rendered.includes('完成标准'), '每个阶段都要写清完成标准')
    assert.ok(rendered.includes('做什么'), '每个阶段都要写清做什么')
    seen.add(c.expect)
  }
  assert.equal(seen.size, 4)
})

test('⑤ 阶段指引: 关掉 stageGuide 开关后不渲染阶段段', async () => {
  const { service } = recordingService({ overrides: { stageGuide: false } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session: fakeSession('s1') } })
  assert.ok(!rendered.includes('### 当前阶段'), '关掉后不应出现阶段段')
  assert.ok(rendered.includes('## 编程模式'), '但常驻协议仍在')
})

test('⑤ 阶段指引: resume 后阶段从会话事件重建', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  // 模拟"进程重启后重新加载会话"：全新 stub，事件里已带完整完成信号链。
  const restarted = makeCtx({ service })
  presetApply(restarted.ctx, {})
  const session = fakeSession('s1', {
    events: [
      ev('tool/call', { callId: 'c1', name: 'todo_write' }),
      ev('tool/call', { callId: 'c2', name: 'exit_plan_mode' }),
    ],
  })
  const rendered = restarted.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：2 · 开发'), '重启后应从事件重建出阶段 2')
  assert.ok(rec.stages.some((s) => s.stage === 2), '重建出的阶段也应上报')
})

test('⑤ 阶段推进: 增量读长度对不上契约时，退回整段读（绝不漏事件）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = withPlanSignalResults([
    ev('tool/call', { callId: 'c1', name: 'todo_write' }),
    ev('tool/call', { callId: 'c2', name: 'exit_plan_mode' }),
  ])
  // 故意提供一个"撒谎"的 snapshotEvents：增量切片返回空数组（长度对不上 to - from）。
  // 插件必须识破并退回整段读，否则阶段会永远停在 0。
  const lying = {
    id: 'liar',
    header: {},
    snapshotEvents: (from, to) => {
      if (typeof from === 'number' && to !== undefined) return [] // 长度 0 !== to - from
      return events
    },
  }
  Object.defineProperty(lying, 'seq', { get: () => events.length })

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session: lying } })
  assert.ok(rendered.includes('### 当前阶段：2 · 开发'), '长度校验失败时应退回整段读')
})

test('⑤ 阶段推进: 没有 seq 探针的会话退化为"只读一次"，不崩也不乱推', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 只有 snapshotEvents、没有 seq 的老形状会话。
  const session = {
    id: 'no-seq',
    header: {},
    snapshotEvents: () => withPlanSignalResults([ev('tool/call', { callId: 'c1', name: 'todo_write' })]),
  }
  const a = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(a.includes('### 当前阶段：1 · 拟合方案'))
  const b = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.equal(a, b, '没有探针就不该反复推进或产生不一致')
})

test('⑤ 阶段指引: 会话读不到事件（没有 snapshotEvents）时不崩，停在阶段 0', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = { id: 's1', header: {} } // 没有 snapshotEvents / events

  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：0 · 了解/对齐'))
})

test('⑤ 阶段指引: 不读会话上下文（单测直接调 text()）时也能渲染，不抛', () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  assert.doesNotThrow(() => stub.sectionByName('coding-mode:protocol').text())
  assert.ok(stub.sectionByName('coding-mode:protocol').text().includes('### 当前阶段：0'))
})

/* ══════════════════ ⑥ 交付门（红队 / 证据）══════════════════ */

test('⑥ 交付门: 阶段 3 文本含证据清单与红队硬要求', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'a', name: 'todo_write' }),
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
    ev('tool/call', { callId: 'c', name: 'write' }),
    ev('tool/result', { message: { callId: 'c', isError: false } }),
  ]
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session: fakeSession('s1', { events }) } })
  assert.ok(rendered.includes('交付门'), '阶段 3 必须有交付门')
  assert.ok(rendered.includes('证据'), '必须要求可核验证据')
  assert.ok(rendered.includes('红队'), '必须写进红队要求')
  assert.ok(rendered.includes('子代理'), '红队要求必须落到"派独立子代理"')
})

test('⑥ 交付门: 声称完成但没有工具证据 → 注入一条提醒', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 阶段 2 + 最后一条是助手在声称完成（其后没有任何 tool/result）
  const events = [
    ev('tool/call', { callId: 'a', name: 'todo_write' }),
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
    assistantEvent('我已经把导出功能完成了，应该没问题。'),
  ]
  const session = fakeSession('s1', { events })

  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  const reminder = decision.messages.find((m) => m.content[0].text.includes('交付门'))
  assert.ok(reminder, '应注入交付门提醒')
  assert.ok(reminder.content[0].text.includes('证据'), '提醒必须要求补证据')
  assert.equal(countBumps(rec, 'guideInjected'), 1)
})

test('⑥ 交付门: 有工具证据时不啰嗦', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'a', name: 'todo_write' }),
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
    assistantEvent('我已经把导出功能完成了。'),
    ev('tool/call', { callId: 'c', name: 'bash' }),
    ev('tool/result', { message: { callId: 'c', isError: false } }),
  ]
  const session = fakeSession('s1', { events })

  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(decision.messages.find((m) => m.content[0].text.includes('交付门')), undefined, '有证据就不该提醒')
})

test('⑥ 交付门: 没有完成声明的普通步骤不提醒', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'a', name: 'todo_write' }),
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
    assistantEvent('我先读一下这个文件看看现状。'),
  ]
  const session = fakeSession('s1', { events })

  const decision = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(decision.messages.find((m) => m.content[0].text.includes('交付门')), undefined)
})

test('⑥ 交付门: 提醒每条"无证据完成声明"只发一次', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'a', name: 'todo_write' }),
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
    assistantEvent('完成了。'),
  ]
  const session = fakeSession('s1', { events })

  const first = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  const second = await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  assert.ok(first.messages.some((m) => m.content[0].text.includes('交付门')))
  assert.ok(!second.messages.some((m) => m.content[0].text.includes('交付门')), '同一次完成声明不该反复提醒')
  assert.equal(countBumps(rec, 'guideInjected'), 1)
})

/* ══════════════════ ⑦ 子代理自动分档 ══════════════════ */

test('⑦ 分档: 子会话被改写成 flash 档（简单任务）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })
  await emit(stub, 'agent/inbox/claimed', { agent: { session: child }, message: userMessage('帮我加一行日志') })

  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: child }, turn: 1, step: 1 },
    { provider: 'seed-provider', model: 'seed-model' },
  )
  assert.equal(resolved.provider, DEFAULT_TIERS.flash.provider)
  assert.equal(resolved.model, DEFAULT_TIERS.flash.model)
  assert.deepEqual(rec.tiers, ['flash'])
})

test('⑦ 分档: 子会话复杂任务被改写成 pro 档', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: child },
    message: userMessage('帮我重构这个模块的并发架构，顺手把迁移方案也设计一下'),
  })

  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: child }, turn: 1, step: 1 },
    { provider: 'seed-provider', model: 'seed-model' },
  )
  assert.equal(resolved.model, DEFAULT_TIERS.pro.model)
  assert.deepEqual(rec.tiers, ['pro'])
})

test('⑦ 分档: 主会话的模型绝不被改写（换模型 = 换缓存域）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const main = fakeSession('main', { header: {} }) // parentSession === undefined

  const seed = { provider: 'seed-provider', model: 'seed-model' }
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: main }, turn: 1, step: 1 }, seed)
  assert.equal(resolved, seed, '主会话必须原样返回同一个对象')
  assert.deepEqual(rec.tiers, [], '主会话不该产生任何分档计数')
})

test('⑦ 分档: 关掉 tierSubagents 开关后不动子会话', async () => {
  const { service, rec } = recordingService({ overrides: { tierSubagents: false } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })

  const seed = { provider: 'seed-provider', model: 'seed-model' }
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child } }, seed)
  assert.deepEqual(resolved, seed)
  assert.deepEqual(rec.tiers, [])
})

test('⑦ 分档: effortPolicy=auto（默认）→ **保留模型自选的强度**，不覆盖', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })

  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: child } },
    { provider: 'seed', model: 'seed', reasoningEffort: 'inherited-effort' },
  )
  assert.equal(
    resolved.reasoningEffort,
    'inherited-effort',
    'auto 模式下模型自选的强度必须原样保留 —— 否则"让模型自选"就是空话',
  )
  // 没有任务文本 → 复杂度判 false → 落到 flash 档（这是刻意的：未知就选便宜的那档）。
  assert.equal(resolved.provider, DEFAULT_TIERS.flash.provider, '档位路由仍要生效')
  assert.equal(resolved.model, DEFAULT_TIERS.flash.model)
})

test('⑦ 分档: effortPolicy=fixed → 用配置的强度覆盖继承值', async () => {
  // 注意：`preset.js` 的配置**只**来自 `codingModeSettings` 服务（两半架构），
  // 传给 `apply` 的 config 参数会被忽略 —— 所以策略要设在 overrides 上。
  const { service } = recordingService({ overrides: { effortPolicy: 'fixed' } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })

  const resolved = await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: child } },
    { provider: 'seed', model: 'seed', reasoningEffort: 'inherited-effort' },
  )
  assert.equal(resolved.reasoningEffort, DEFAULT_TIERS.flash.reasoningEffort ?? 'high')
  assert.notEqual(resolved.reasoningEffort, 'inherited-effort', '不应保留上游继承的强度')
})

test('⑦ 分档: 档位配成空值时回落到内置默认模型（绝不写出半个模型）', async () => {
  const { service } = recordingService({ overrides: { tiers: { flash: { provider: '', model: '' }, pro: { provider: '', model: '' } } } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })

  // normalize() 的既定语义：provider/model 为空 → 补内置默认。
  // 所以这里应当落到内置默认档，而不是把空串或 undefined 写进请求。
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child } }, { provider: 'seed-provider', model: 'seed-model' })
  assert.equal(resolved.provider, DEFAULT_TIERS.flash.provider, '空 provider 必须补上内置默认（两个半侧的默认值必须一致）')
  assert.equal(resolved.model, DEFAULT_TIERS.flash.model)
  assert.ok(resolved.provider && resolved.model, 'provider 与 model 必须都非空')
})

test('⑦ 分档: 没有 payload.agent 时不崩', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const seed = { provider: 'p', model: 'm' }
  const resolved = await emitWaterfall(stub, 'agent/request', {}, seed)
  assert.deepEqual(resolved, seed)
})

/* ══════════════════ ⑧ 计数 ══════════════════ */

test('⑧ 计数: 协议段渲染计入 protocolRendered', () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  assert.equal(countBumps(rec, 'protocolRendered'), 0)
  stub.sectionByName('coding-mode:protocol').text()
  assert.equal(countBumps(rec, 'protocolRendered'), 1)
  stub.sectionByName('coding-mode:protocol').text()
  assert.equal(countBumps(rec, 'protocolRendered'), 2, '每次求值都应该计一次')
})

test('⑧ 计数: 门禁拦截计入 gateDenials', () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service, planMode: { loggedActive: () => true } })
  presetApply(stub.ctx, {})

  const reason = stub.guards[0]({ name: 'write', agent: { session: { id: 's1' } } })
  assert.equal(typeof reason, 'string')
  assert.equal(countBumps(rec, 'gateDenials'), 1)
  assert.equal(countBumps(rec, 'gateAllows'), 0)
})

test('⑧ 计数: 计划模式生效但放行非 gated 工具 → 计入 gateAllows', () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service, planMode: { loggedActive: () => true } })
  presetApply(stub.ctx, {})

  assert.equal(stub.guards[0]({ name: 'bash', agent: { session: { id: 's1' } } }), undefined)
  assert.equal(stub.guards[0]({ name: 'read', agent: { session: { id: 's1' } } }), undefined)
  assert.equal(countBumps(rec, 'gateAllows'), 2)
  assert.equal(countBumps(rec, 'gateDenials'), 0)
})

test('⑧ 计数: 不在计划模式时既不算拦截也不算放行', () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service, planMode: { loggedActive: () => false } })
  presetApply(stub.ctx, {})

  for (const n of ['write', 'edit', 'bash']) {
    assert.equal(stub.guards[0]({ name: n, agent: { session: { id: 's1' } } }), undefined)
  }
  assert.equal(countBumps(rec, 'gateDenials'), 0)
  assert.equal(countBumps(rec, 'gateAllows'), 0)
})

test('⑧ 计数: 门禁开关关闭时不计数', () => {
  const { service, rec } = recordingService({ overrides: { planGate: false } })
  const stub = makeCtx({ service, planMode: { loggedActive: () => true } })
  presetApply(stub.ctx, {})
  assert.equal(stub.guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), undefined)
  assert.equal(countBumps(rec, 'gateDenials'), 0)
  assert.equal(countBumps(rec, 'gateAllows'), 0)
})

/* ══════════════════ 端到端计数（真服务，不是桩）══════════════════ */

/**
 * 这一组是本文件里**最硬**的验证：不换桩服务，直接让 Host 半侧的真实
 * `codingModeSettings` 服务接上 preset 半侧，驱动一遍真实行为，
 * 再去读服务自己的 `stats()`。
 *
 * 前面的计数用例用的是录播服务，只能证明"插件调了方法"；
 * 这一组能证明"计数确实落到了真实白名单计数器上、且数值正确"。
 */
test('端到端计数: 真服务上 8 类计数全部按预期累加', async () => {
  const stub = makeCtx({ planMode: { loggedActive: () => true } })
  hostApply(stub.ctx, {})
  presetApply(stub.ctx, {})
  const service = stub.services.get(SETTINGS_SERVICE)
  assert.equal(typeof service.stats, 'function', '真服务必须提供 stats()')

  const { session, push } = liveSession('e2e-1')

  // ① 首轮分类
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session },
    message: userMessage('帮我实现一个导出 CSV 的函数'),
  })
  // ④ 协议段渲染（顺带把任务回显与阶段指引都渲染出来）
  stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  // ③ 近场引导 + ② persona
  await emitWaterfall(
    stub,
    'agent/pre-step',
    { agent: { session }, messages: [userMessage('帮我实现一个导出 CSV 的函数', 'e2e-u1')] },
    { kind: 'enter', messages: [] },
  )
  // ⑤ 阶段推进（日志增长 → 下一次触碰时吸收增量）
  push('tool/call', { callId: 'x1', name: 'todo_write' })
  push('tool/call', { callId: 'x2', name: 'exit_plan_mode' })
  stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  // ⑧ 门禁：拦截一次 + 放行一次
  stub.guards[0]({ name: 'write', agent: { session } })
  stub.guards[0]({ name: 'bash', agent: { session } })
  // ⑦ 子代理分档
  await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: fakeSession('e2e-child', { parentSession: 'e2e-1' }) } },
    { provider: 'seed', model: 'seed' },
  )

  const stats = service.stats()
  assert.equal(stats.classified.build, 1, '① 首轮分类计数')
  assert.equal(stats.personaInjected, 1, '② persona 注入一次')
  assert.equal(stats.guideInjected, 1, '③ 近场引导一次')
  assert.equal(stats.taskEchoed, stats.protocolRendered, '④ 每次渲染都带任务回显')
  assert.equal(stats.protocolRendered, 2, '⑧ 本用例渲染了 2 次协议段')
  assert.equal(stats.gateDenials, 1, '⑧ 门禁拦截一次')
  assert.equal(stats.gateAllows, 1, '⑧ 门禁放行一次')
  assert.equal(stats.stageAdvances, 2, '⑤ 阶段从 0 推到 2（两次推进）')
  assert.equal(stats.stageBySession['e2e-1'], 2, '⑤ setStage 应记下会话当前阶段')
  assert.equal(stats.tierRouted.flash, 1, '⑦ 子代理被分到 flash 档')
})

test('端到端计数: 主会话分档计数为 0（绝不碰主会话）', async () => {
  const stub = makeCtx()
  hostApply(stub.ctx, {})
  presetApply(stub.ctx, {})
  const service = stub.services.get(SETTINGS_SERVICE)

  await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: fakeSession('main-e2e', { header: {} }) } },
    { provider: 'seed', model: 'seed' },
  )
  const stats = service.stats()
  assert.equal(stats.tierRouted.flash, 0)
  assert.equal(stats.tierRouted.pro, 0)
})

test('端到端计数: 设置页关掉开关后，真实计数按键归零', async () => {
  const stub = makeCtx()
  // 用 accessor 形态模拟 volatile 字段：先关掉再读，read() 每次求值。
  hostApply(stub.ctx, { stageGuide: false, taskEcho: false, nearFieldGuide: false, tierSubagents: false })
  presetApply(stub.ctx, {})
  const service = stub.services.get(SETTINGS_SERVICE)
  assert.equal(service.read().stageGuide, false)

  const session = fakeSession('off-1')
  await emit(stub, 'agent/inbox/claimed', { agent: { session }, message: userMessage('帮我实现一个导出 CSV 的函数') })
  stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  await emitWaterfall(
    stub,
    'agent/pre-step',
    { agent: { session }, messages: [userMessage('帮我实现一个导出 CSV 的函数', 'off-u1')] },
    { kind: 'enter', messages: [] },
  )
  await emitWaterfall(
    stub,
    'agent/request',
    { agent: { session: fakeSession('off-child', { parentSession: 'off-1' }) } },
    { provider: 'seed', model: 'seed' },
  )

  const stats = service.stats()
  assert.equal(stats.taskEchoed, 0, 'taskEcho 关了就不该计数')
  assert.equal(stats.guideInjected, 0, 'nearFieldGuide 关了就不该计数')
  assert.equal(stats.tierRouted.flash, 0, 'tierSubagents 关了就不该计数')
  assert.equal(stats.personaInjected, 1, 'persona 不归这四个开关管，仍应注入')
  assert.equal(stats.classified.build, 1, '分类不归这四个开关管，仍应计数')
})

/* ══════════════════ 门禁行为 ══════════════════ */

test('门禁: 计划模式生效时，write 被真实拒绝', () => {
  const { ctx, guards } = makeCtx({ planMode: { loggedActive: () => true } })
  presetApply(ctx, {})
  const reason = guards[0]({ name: 'write', agent: { session: { id: 's1' } } })
  assert.equal(typeof reason, 'string', '应返回拒绝理由')
  assert.ok(reason.includes('exit_plan_mode'))
})

test('门禁: 计划模式生效时，edit 被真实拒绝', () => {
  const { ctx, guards } = makeCtx({ planMode: { loggedActive: () => true } })
  presetApply(ctx, {})
  assert.equal(typeof guards[0]({ name: 'edit', agent: { session: { id: 's1' } } }), 'string')
})

test('门禁: 不在计划模式时，write 放行（日常写文件不受影响）', () => {
  const { ctx, guards } = makeCtx({ planMode: { loggedActive: () => false } })
  presetApply(ctx, {})
  assert.equal(guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), undefined)
})

test('门禁: 计划模式生效但工具是 bash/read 时放行（计划期仍要读日志列目录）', () => {
  const { ctx, guards } = makeCtx({ planMode: { loggedActive: () => true } })
  presetApply(ctx, {})
  for (const n of ['bash', 'read', 'glob', 'grep', 'todo_write']) {
    assert.equal(guards[0]({ name: n, agent: { session: { id: 's1' } } }), undefined, `${n} 不该被拦`)
  }
})

test('门禁: 没有 agent 的执行上下文放行，不抛异常', () => {
  const { ctx, guards } = makeCtx({ planMode: { loggedActive: () => true } })
  presetApply(ctx, {})
  assert.doesNotThrow(() => guards[0]({ name: 'write' }))
  assert.equal(guards[0]({ name: 'write' }), undefined)
})

/* ---------------- 投影兜底（preset 里 planMode 被 isolate 时的活路） ---------------- */

test('门禁兜底: planMode 服务取不到时，改读会话投影拿到 true → 仍然拦截', () => {
  const { ctx, guards } = makeCtx({
    sessionProjections: { stateOf: (_s, key) => (key === 'plan' ? { active: true } : undefined) },
  })
  presetApply(ctx, {})
  assert.equal(typeof guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), 'string')
})

test('门禁兜底: 投影说未生效 → 放行', () => {
  const { ctx, guards } = makeCtx({ sessionProjections: { stateOf: () => ({ active: false }) } })
  presetApply(ctx, {})
  assert.equal(guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), undefined)
})

test('门禁兜底: planMode 抛错时改用投影（不是直接放弃）', () => {
  const { ctx, guards } = makeCtx({
    planMode: {
      loggedActive: () => {
        throw new Error('boom')
      },
    },
    sessionProjections: { stateOf: () => ({ active: true }) },
  })
  presetApply(ctx, {})
  assert.equal(typeof guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), 'string')
})

test('门禁兜底: 两条路都不通 → 失败开放放行，不把工作卡死', () => {
  const { ctx, guards } = makeCtx()
  presetApply(ctx, {})
  assert.equal(guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), undefined)
})

test('门禁兜底: 投影抛错 → 放行且不冒泡', () => {
  const { ctx, guards } = makeCtx({
    sessionProjections: {
      stateOf: () => {
        throw new Error('boom')
      },
    },
  })
  presetApply(ctx, {})
  assert.doesNotThrow(() => guards[0]({ name: 'write', agent: { session: { id: 's1' } } }))
})

test('门禁兜底: 没有 session 的 agent → 放行', () => {
  const { ctx, guards } = makeCtx({
    planMode: { loggedActive: () => true },
    sessionProjections: { stateOf: () => ({ active: true }) },
  })
  presetApply(ctx, {})
  assert.equal(guards[0]({ name: 'write', agent: {} }), undefined)
})

test('apply: 两次调用都能正常工作（幂等、不残留状态）', () => {
  const a = makeCtx({ planMode: { loggedActive: () => true } })
  presetApply(a.ctx, {})
  const b = makeCtx({ planMode: { loggedActive: () => false } })
  presetApply(b.ctx, {})
  assert.equal(typeof a.guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), 'string')
  assert.equal(b.guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), undefined)
})

/* ══════════════════════════════════════════════════════════════════════════
 * D 项：A/B 实验用的运行时开关（没有它就没法跑对照组）
 * ══════════════════════════════════════════════════════════════════════════ */

test('D: protocolSection=false → 协议段渲染空串，且 protocolRendered 不增长', () => {
  const { service, rec } = recordingService({ overrides: { protocolSection: false } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  const rendered = stub.sectionByName('coding-mode:protocol').text()
  assert.equal(rendered, '', '关掉协议段必须完全不注入（空串会被 DSH 的装配过滤掉）')
  assert.equal(countBumps(rec, 'protocolRendered'), 0, '不渲染就不该计数 —— 否则统计在说谎')

  // 再渲染几次也照样不涨
  stub.sectionByName('coding-mode:protocol').text()
  stub.sectionByName('coding-mode:protocol').text()
  assert.equal(countBumps(rec, 'protocolRendered'), 0)
})

test('D: protocolSection=true（默认）→ 照常渲染并计数', () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const rendered = stub.sectionByName('coding-mode:protocol').text()
  assert.ok(rendered.includes('## 编程模式'))
  assert.equal(countBumps(rec, 'protocolRendered'), 1)
})

test('D: protocolSection=false 时计划门禁仍然工作（关提示 ≠ 关门禁）', () => {
  // 这是 D 项的关键语义：协议段是提示，门禁是 exec 通路，两者独立。
  // 如果关掉协议段连门禁一起关，A/B 实验就没法做"只去掉提示"的对照。
  const { service } = recordingService({ overrides: { protocolSection: false } })
  const stub = makeCtx({ service, planMode: { loggedActive: () => true } })
  presetApply(stub.ctx, {})
  assert.equal(stub.sectionByName('coding-mode:protocol').text(), '', '协议段确实关掉了')
  assert.equal(typeof stub.guards[0]({ name: 'write', agent: { session: { id: 's1' } } }), 'string', '门禁必须照常拦截')
})

test('D: protocolSection=false 时服务缺失也不抛', () => {
  const stub = makeCtx() // 完全没有 codingModeSettings
  presetApply(stub.ctx, {})
  assert.doesNotThrow(() => stub.sectionByName('coding-mode:protocol').text())
})

/* ---------------- D 项：tierPolicy 强制分档 ---------------- */

test('D: tierPolicy=flash 强制所有子代理走 flash（复杂任务也不例外）', async () => {
  const { service, rec } = recordingService({ overrides: { tierPolicy: 'flash' } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })
  // 这条任务是**复杂**的（架构/重构/并发/迁移），auto 下必然判 pro
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: child },
    message: userMessage('帮我重构这个模块的并发架构，顺手把迁移方案也设计一下'),
  })

  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child } }, { provider: 'seed', model: 'seed' })
  assert.equal(resolved.model, DEFAULT_TIERS.flash.model, '强制 flash 时复杂任务也必须走 flash')
  assert.deepEqual(rec.tiers, ['flash'], '强制档也要照常 bumpTier（否则实验组看不到分档分布）')
})

test('D: tierPolicy=pro 强制所有子代理走 pro（简单任务也不例外）', async () => {
  const { service, rec } = recordingService({ overrides: { tierPolicy: 'pro' } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'parent-1' })
  await emit(stub, 'agent/inbox/claimed', { agent: { session: child }, message: userMessage('加一行日志') })

  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child } }, { provider: 'seed', model: 'seed' })
  assert.equal(resolved.model, DEFAULT_TIERS.pro.model, '强制 pro 时简单任务也必须走 pro')
  assert.deepEqual(rec.tiers, ['pro'])
})

test('D: tierPolicy 非法值 / 读不到 → 退回 auto（走复杂度判断）', async () => {
  for (const overrides of [{ tierPolicy: 'flsh' }, { tierPolicy: '' }, { tierPolicy: undefined }]) {
    const { service, rec } = recordingService({ overrides })
    const stub = makeCtx({ service })
    presetApply(stub.ctx, {})
    const child = fakeSession('child', { parentSession: 'parent-1' })
    await emit(stub, 'agent/inbox/claimed', {
      agent: { session: child },
      message: userMessage('帮我重构这个模块的并发架构，顺手把迁移方案也设计一下'),
    })
    const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child } }, { provider: 'seed', model: 'seed' })
    assert.equal(resolved.model, DEFAULT_TIERS.pro.model, `非法值 ${String(overrides.tierPolicy)} 应退回 auto → 复杂任务走 pro`)
    assert.deepEqual(rec.tiers, ['pro'])
  }
})

test('D: tierPolicy 强制档也绝不碰主会话（换模型 = 换缓存域）', async () => {
  const { service, rec } = recordingService({ overrides: { tierPolicy: 'pro' } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const main = fakeSession('main', { header: {} })
  const seed = { provider: 'seed-provider', model: 'seed-model' }
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: main } }, seed)
  assert.equal(resolved, seed)
  assert.deepEqual(rec.tiers, [])
})

/* ══════════════════════════════════════════════════════════════════════════
 * C 项：统计摘要（让模型读得到宿主计数）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 从渲染出的协议段里抠出统计摘要那一行（没有则返回空串）。 */
function statsLineOf(rendered) {
  const match = rendered.match(/<!-- 本次会话统计：[^\n]*-->/)
  return match === null ? '' : match[0]
}

test('C: statsFooter=false（默认）→ 不追加统计摘要', () => {
  const { service } = recordingService({ stats: { ...ZERO_STATS, protocolRendered: 9, guideInjected: 3 } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const rendered = stub.sectionByName('coding-mode:protocol').text()
  assert.equal(statsLineOf(rendered), '', '默认关就必须一个字都不加')
})

test('C: statsFooter=true 且有数据 → 追加摘要，且长度 < 120 字符', () => {
  const { service } = recordingService({
    overrides: { statsFooter: true },
    stats: { ...ZERO_STATS, protocolRendered: 12, guideInjected: 3, gateDenials: 2, deliveryBlocked: 1, tierRouted: { flash: 4, pro: 1 } },
  })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const rendered = stub.sectionByName('coding-mode:protocol').text()
  const line = statsLineOf(rendered)

  assert.ok(line.length > 0, '有数据时必须追加')
  assert.ok(line.length < 120, `摘要必须短（目标 < 120 字符），实际 ${line.length}`)
  assert.ok(line.includes('协议渲染 12'), '应含协议渲染次数')
  assert.ok(line.includes('引导 3'), '应含引导次数')
  assert.ok(line.includes('门禁拦截 2'), '应含门禁拦截次数')
  assert.ok(line.includes('flash=4'), '应含分档分布')
  assert.ok(line.includes('当前阶段'), '应含当前阶段')
  // 必须是**段尾**：注释行之后除了空白不再有别的正文
  assert.equal(rendered.trimEnd().endsWith('-->'), true, '摘要必须在协议段最尾')
})

test('C: statsFooter=true 但全零 → 不追加（别浪费 token）', () => {
  const { service } = recordingService({ overrides: { statsFooter: true } }) // 默认 ZERO_STATS
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  assert.equal(statsLineOf(stub.sectionByName('coding-mode:protocol').text()), '', '全零就不该有这一行')
})

test('C: statsFooter=true 且数字很大时也被裁到 < 120（绝不撑爆段尾）', () => {
  const { service } = recordingService({
    overrides: { statsFooter: true },
    stats: {
      ...ZERO_STATS,
      protocolRendered: 987654321,
      guideInjected: 123456789,
      gateDenials: 55555555,
      deliveryBlocked: 44444444,
      deliveryGiveUp: 33333333,
      tierRouted: { flash: 22222222, pro: 11111111 },
    },
  })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const line = statsLineOf(stub.sectionByName('coding-mode:protocol').text())
  assert.ok(line.length > 0)
  assert.ok(line.length < 120, `超长数字也必须裁到 < 120，实际 ${line.length}`)
})

test('C: statsFooter=true 但服务没有 stats() / stats() 抛错 → 只少一行，绝不抛', () => {
  for (const opts of [{ overrides: { statsFooter: true }, noStats: true }, { overrides: { statsFooter: true }, throwingStats: true }]) {
    const { service } = recordingService(opts)
    const stub = makeCtx({ service })
    presetApply(stub.ctx, {})
    let rendered
    assert.doesNotThrow(() => {
      rendered = stub.sectionByName('coding-mode:protocol').text()
    })
    assert.ok(rendered.includes('## 编程模式'), '协议段本体照常渲染')
    assert.equal(statsLineOf(rendered), '')
  }
})

test('C: 服务完全缺失 + statsFooter 也读不到 → 不抛、不追加', () => {
  const stub = makeCtx()
  presetApply(stub.ctx, {})
  const rendered = stub.sectionByName('coding-mode:protocol').text()
  assert.ok(rendered.includes('## 编程模式'))
  assert.equal(statsLineOf(rendered), '')
})

test('C: statsFooter 不受 taskEcho / stageGuide 控制（是独立开关）', () => {
  // 需求明确写了：统计摘要**不**受 taskEcho 开关控制，而是另一个独立开关。
  // 所以把两个渲染类开关都关掉，只要 statsFooter 开着且有数据，摘要仍然要出现。
  const { service } = recordingService({
    overrides: { statsFooter: true, taskEcho: false, stageGuide: false },
    stats: { ...ZERO_STATS, protocolRendered: 5, gateDenials: 1 },
  })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const rendered = stub.sectionByName('coding-mode:protocol').text()

  assert.ok(rendered.includes('## 编程模式'), '协议段本体还在')
  assert.equal(rendered.includes('### 当前阶段'), false, 'stageGuide 关了，阶段段确实不渲染')
  assert.equal(statsLineOf(rendered).length > 0, true, 'statsFooter 必须独立生效，不受 taskEcho/stageGuide 影响')
})

/* ══════════════════════════════════════════════════════════════════════════
 * A 项：交付门（从"提示文本"升级为"有牙齿的真门"）
 *
 * 判定口径：阶段已是 3，且自最后一次**成功**的 write/edit 以来
 * 没有任何验证类工具（bash / read / grep / glob / read_image）调用。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 造一个假的 agent，记录 steer / inject / followup 的调用。
 * @param {any} session
 * @param {object} [opts]
 * @param {boolean} [opts.noMethods] 三个方法一个都不提供（验证"送不进去就不记账"）
 */
function fakeAgent(session, { noMethods = false } = {}) {
  const calls = []
  const agent = { session }
  if (!noMethods) {
    agent.steer = (message) => calls.push({ via: 'steer', message })
    agent.inject = (message) => calls.push({ via: 'inject', message })
    // followup 只用来断言"从来没被调用过"（它会新开一轮，可能失控）
    agent.followup = (message) => calls.push({ via: 'followup', message })
  }
  return { agent, calls }
}

/** 一条把会话推到阶段 3、且"改完没验证"的事件序列。 */
function eventsWrittenWithoutVerify() {
  return [
    ev('tool/call', { callId: 'a', name: 'todo_write' }), // 0 → 1
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }), // 1 → 2
    ev('tool/call', { callId: 'c', name: 'write' }),
    ev('tool/result', { message: { callId: 'c', isError: false } }), // 2 → 3，且水线升起
  ]
}

test('A: 阶段 3 + 改完没验证 → turn-stopping 驳回（steer）并计入 deliveryBlocked', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })

  assert.equal(calls.length, 1, '应恰好注入一条驳回消息')
  assert.equal(calls[0].via, 'steer', '必须用 steer（把轮次拽回来继续），不用 followup')
  assert.equal(calls[0].message.role, 'user', 'steer 收到的是完整的 user 角色消息')
  assert.ok(typeof calls[0].message.id === 'string' && calls[0].message.id.length > 0, '消息必须有 id（inbox 靠它去重）')
  assert.ok(calls[0].message.content[0].text.includes('交付门驳回'), '文案要说明这是驳回')
  assert.ok(calls[0].message.content[0].text.includes('bash'), '要点名验证类工具')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 1)
  assert.equal(countBumps(rec, 'deliveryGiveUp'), 0)
})

test('A: 驳回绝不用 followup（followup 会新开一轮，可能失控）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.filter((c) => c.via === 'followup').length, 0, 'followup 一次都不能出现')
})

test('A: 阶段 3 但改完有**成功的**验证工具调用 → 放行，不驳回', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // Task A1 后：验证必须**成功**才算数，所以这里显式补结果（裸 tool/call 不再作数）。
  const events = [...eventsWrittenWithoutVerify(), ...okCall('d', 'bash')]
  const session = fakeSession('s1', { events })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 0, '有成功的验证证据就该放行')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 0)
})

test('A1: 验证命令**报错**不算验证过 —— 交付门仍然驳回', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 跑了一条 bash 但它是失败的：什么都没验到，水线不得下降。
  const events = [...eventsWrittenWithoutVerify(), ...failCall('d', 'bash')]
  const session = fakeSession('s1', { events })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 1, '失败的验证不能放行，仍应驳回')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 1)
})

test('A: 五个验证类工具都算证据（bash / read / grep / glob / read_image）', async () => {
  for (const verifyTool of ['bash', 'read', 'grep', 'glob', 'read_image']) {
    const { service, rec } = recordingService()
    const stub = makeCtx({ service })
    presetApply(stub.ctx, {})
    const events = [...eventsWrittenWithoutVerify(), ...okCall('d', verifyTool)]
    const session = fakeSession('s1', { events })
    const { agent, calls } = fakeAgent(session)
    await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
    assert.equal(calls.length, 0, `${verifyTool} 应被认作验证类工具`)
    assert.equal(countBumps(rec, 'deliveryBlocked'), 0)
  }
})

test('A: 失败的 write 不算"需要验证的改动"（水线不升起）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const events = [
    ev('tool/call', { callId: 'a', name: 'todo_write' }),
    ev('tool/call', { callId: 'b', name: 'exit_plan_mode' }),
    ev('tool/call', { callId: 'c', name: 'write' }),
    ev('tool/result', { message: { callId: 'c', isError: true } }), // 失败！
  ]
  const session = fakeSession('s1', { events })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 0, '失败的 write 什么都没改，不需要验证')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 0)
})

test('A: 还没到阶段 3 → 门不管（不拦中间过程）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', {
    events: [ev('tool/call', { callId: 'a', name: 'todo_write' })], // 只到阶段 1
  })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 0)
  assert.equal(countBumps(rec, 'deliveryBlocked'), 0)
})

test('A: 连续驳回达上限（2 次）→ 放行，并只记一次 deliveryGiveUp', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent, calls } = fakeAgent(session)

  // 第 1、2 次驳回
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 2, '上限是 2 次驳回')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 2)
  assert.equal(countBumps(rec, 'deliveryGiveUp'), 0, '还没到上限就不该放弃')

  // 第 3 次：放行 + 记一次放弃
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 2, '到上限后必须放行，不再注入')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 2)
  assert.equal(countBumps(rec, 'deliveryGiveUp'), 1)

  // 第 4、5 次：继续放行，但「放弃驳回」**每会话只记一次**
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 2)
  assert.equal(countBumps(rec, 'deliveryGiveUp'), 1, '放弃驳回只记一次，否则语义变成"被放行了几次"')
})

test('A: 驳回之后真跑了一次验证 → 立刻放行', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const { session, push } = liveSession('s1')
  for (const e of eventsWrittenWithoutVerify()) push(e.type, e.data)
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 1)

  // 模型听了话，跑了一次 bash**并且成功**（Task A1 后：验证必须成功才算数）
  push('tool/call', { callId: 'd', name: 'bash' })
  push('tool/result', { message: toolResultMessage('d', false) })
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 1, '补了证据就该放行')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 1)
})

/* ══════════════════ A2/A3 流程完整性：报错不得跳过流程 ══════════════════ */

test('A2: 失败的非写工具**不推进阶段**（阶段推进一律以结果为凭）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // todo_write 报了错 → 什么都没完成，阶段必须停在 0。
  const session = fakeSession('s1', { events: failCall('c1', 'todo_write') })
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(
    rendered.includes('### 当前阶段：0 · 了解/对齐'),
    '失败的命令不该推进阶段 —— 否则"跑了个错的就算做完了"',
  )
})

test('A2: 成功的非写工具照常推进阶段（对照组）', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: okCall('c1', 'todo_write') })
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：1 · 拟合方案'))
})

test('A3: 报错不跳过流程 —— 失败的 write 之后，交付门仍然要求验证', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 完成的计划链 + 一次**失败**的 write：水线不该升起（没改成功），
  // 所以也不该出现"改完了没验证"的驳回 —— 这是"报错不跳过流程"的另一面：
  // 失败的步骤既不算完成，也不该被当成"有待验证的改动"。
  const events = [
    ...okCall('a', 'todo_write'),
    ...okCall('b', 'exit_plan_mode'),
    ...failCall('c', 'write'),
  ]
  const session = fakeSession('s1', { events })
  const { agent, calls } = fakeAgent(session)
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 0, '失败的 write 不产生待验证改动')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 0)
})

test('A3: 报错不跳过流程 —— 中途报错后，要求的步骤依然被要求', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 计划链里夹一次失败调用；阶段仍应正常走到 2，并要求继续走下去。
  const events = [
    ...okCall('a', 'todo_write'),
    ...failCall('x', 'bash'),
    ...okCall('b', 'exit_plan_mode'),
  ]
  const session = fakeSession('s1', { events })
  const rendered = stub.sectionByName('coding-mode:protocol').text({ agent: { session } })
  assert.ok(rendered.includes('### 当前阶段：2 · 开发'), '中途报错不该卡住流程')
  assert.ok(rec.stages.some((s) => s.stage === 2), '阶段变化仍应上报')
})

/* ══════════════════ B: flowGate=true 的硬门行为 ══════════════════ */

test('B(flowGate): 没有计划信号 → write/edit 被硬拒，且理由可操作', () => {
  const { service } = recordingService({ overrides: { flowGate: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: [] })
  const flowGuard = stub.guards[1]

  for (const name of ['write', 'edit']) {
    const reason = flowGuard({ name, agent: { session } })
    assert.equal(typeof reason, 'string', `${name} 应被硬拒`)
    assert.ok(/todo_write|exit_plan_mode/.test(reason), '理由必须告诉模型怎么解锁')
  }
  // 非写工具不受影响（计划期还要读码）
  for (const name of ['bash', 'read', 'grep', 'glob']) {
    assert.equal(flowGuard({ name, agent: { session } }), undefined, `${name} 不该被拦`)
  }
})

test('B(flowGate): 有计划信号后 write 放行', () => {
  const { service } = recordingService({ overrides: { flowGate: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: okCall('a', 'todo_write') })
  assert.equal(stub.guards[1]({ name: 'write', agent: { session } }), undefined)
})

test('B(flowGate): 失败的计划信号不算解锁（todo_write 报错 → 仍被拒）', () => {
  const { service } = recordingService({ overrides: { flowGate: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: failCall('a', 'todo_write') })
  assert.equal(typeof stub.guards[1]({ name: 'write', agent: { session } }), 'string')
})

test('B(flowGate): 阶段 3 有未验证的写 → 再写被拒（要求先验证）', () => {
  const { service } = recordingService({ overrides: { flowGate: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const reason = stub.guards[1]({ name: 'write', agent: { session } })
  assert.equal(typeof reason, 'string', '改完没验证前不该继续改')
  assert.ok(/验证|证据/.test(reason), '理由要点明需要验证')
})

test('B(flowGate): 守卫对残缺输入不抛（无 agent / 无 session / 空 exec）', () => {
  const { service } = recordingService({ overrides: { flowGate: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const flowGuard = stub.guards[1]
  for (const exec of [undefined, {}, { name: 'write' }, { name: 'write', agent: {} }, { name: 'write', agent: { session: {} } }]) {
    assert.doesNotThrow(() => flowGuard(exec), `输入 ${JSON.stringify(exec)} 不该抛`)
  }
})

test('B(flowGate): 服务缺失时守卫也保持惰性（退默认 flowGate=false）', () => {
  const stub = makeCtx() // 没有 service
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: [] })
  assert.equal(stub.guards[1]({ name: 'write', agent: { session } }), undefined)
})

test('A: stageGuide=false → 完全不做交付门', async () => {
  const { service, rec } = recordingService({ overrides: { stageGuide: false } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent, calls } = fakeAgent(session)

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 0, '关掉阶段指引就该连这道门一起关')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 0)
})

test('A: steer/inject 都不可用 → 不记账（统计绝不说谎）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent, calls } = fakeAgent(session, { noMethods: true })

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 0)
  assert.equal(countBumps(rec, 'deliveryBlocked'), 0, '没送进去就不能记"拦住了"')
})

test('A: steer 抛错时退回 inject（两者落地位置相同）', async () => {
  const { service, rec } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const calls = []
  const agent = {
    session,
    steer: () => {
      throw new Error('steer exploded')
    },
    inject: (message) => calls.push({ via: 'inject', message }),
  }

  await emit(stub, 'agent/turn-stopping', { agent, turn: 1, signal: undefined })
  assert.equal(calls.length, 1, 'steer 失败要退回 inject')
  assert.equal(calls[0].via, 'inject')
  assert.equal(countBumps(rec, 'deliveryBlocked'), 1)
})

test('A: 没有 agent / 没有 session / 服务缺失 → 都不抛', async () => {
  const { service } = recordingService()
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  await assert.doesNotReject(async () => {
    await emit(stub, 'agent/turn-stopping', {})
    await emit(stub, 'agent/turn-stopping', { agent: {} })
    await emit(stub, 'agent/turn-stopping', { agent: { session: null } })
  })

  // 完全没有服务时也不抛
  const bare = makeCtx()
  presetApply(bare.ctx, {})
  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent } = fakeAgent(session)
  await assert.doesNotReject(async () => {
    await emit(bare, 'agent/turn-stopping', { agent, turn: 1 })
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * B 项：阶段硬门控（可选开关，默认关）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 造一个 scoped 的 tools 服务替身。
 * 真实 `tools.restrict({allow})` 返回 disposer；这里同样返回，并记录调用顺序，
 * 以便断言"设新的之前先释放旧的"。
 * @param {object} [opts]
 * @param {string[]} [opts.names] `view().restrictableNames` 里可被限制的工具名
 * @param {boolean} [opts.throwOnRestrict] restrict 故意抛错（模拟 unknown global tool）
 * @param {boolean} [opts.noView] 不提供 view（验证"拿不到名单就不冒险"）
 */
function makeScopedTools({
  names = ['read', 'grep', 'glob', 'read_image', 'bash', 'ask_user_question', 'todo_write', 'exit_plan_mode', 'write', 'edit'],
  throwOnRestrict = false,
  noView = false,
} = {}) {
  const calls = []
  const service = {
    restrict: (filter) => {
      calls.push({ kind: 'restrict', filter })
      if (throwOnRestrict) throw new Error('tools.restrict() names unknown global tool "nope"')
      return () => calls.push({ kind: 'disposed' })
    },
  }
  if (!noView) service.view = () => ({ restrictableNames: new Set(names) })
  return { service, calls }
}

/** 造一个带 scoped ctx 的假 agent（restrict 必须在 agent.ctx 上调用）。 */
function agentWithTools(session, toolsService) {
  return { session, ctx: { get: (key) => (key === 'tools' ? toolsService : undefined) } }
}

test('B: stageRestrict=true → 阶段 0 按名单 restrict，且绝不出现 write/edit', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const tools = makeScopedTools()
  const session = fakeSession('s1', { events: [] })
  const agent = agentWithTools(session, tools.service)

  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })

  assert.equal(tools.calls.length, 1, '应恰好设一次 restrict')
  const allow = tools.calls[0].filter.allow
  assert.ok(Array.isArray(allow))
  assert.ok(allow.includes('todo_write'), '阶段 0 要能写计划')
  assert.ok(allow.includes('ask_user_question'), '阶段 0 要能问用户')
  assert.ok(!allow.includes('write'), '阶段 0 不该放 write')
  assert.ok(!allow.includes('edit'), '阶段 0 不该放 edit')
})

test('B: 阶段不变时不重复设置（避免每步释放-重设的 churn）', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const tools = makeScopedTools()
  const session = fakeSession('s1', { events: [] })
  const agent = agentWithTools(session, tools.service)

  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(tools.calls.length, 1, '阶段没变就只设一次')
})

test('B: 阶段推进 → 先释放旧 disposer 再设新的（restrict 是交集语义的坑）', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const tools = makeScopedTools()
  const { session, push } = liveSession('s1')
  const agent = agentWithTools(session, tools.service)

  // 阶段 0
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(tools.calls.length, 1)

  // 推进到阶段 1（todo_write 是 0→1 的完成信号）
  push('tool/call', { callId: 'a', name: 'todo_write' })
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })

  assert.equal(tools.calls.length, 3, '应有两步：先 disposed 再 restrict')
  assert.equal(tools.calls[1].kind, 'disposed', '设新的之前必须先释放旧的 —— 否则两个阶段的 allow 会取交集')
  assert.equal(tools.calls[2].kind, 'restrict')
})

test('B: 进入阶段 2 / 3（不限制的阶段）→ 释放旧限制，且不再设新的', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const tools = makeScopedTools()
  const { session, push } = liveSession('s1')
  const agent = agentWithTools(session, tools.service)

  // 阶段 0 → 设一次
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  // 推到阶段 2
  push('tool/call', { callId: 'a', name: 'todo_write' })
  push('tool/call', { callId: 'b', name: 'exit_plan_mode' })
  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })

  // 第 1 步：阶段 0 设了一次限制；第 2 步：进阶段 2 只需**释放**那一次，不再设新的
  assert.equal(tools.calls.length, 2, '共两次动作：设一次 + 释放一次')
  assert.equal(tools.calls[1].kind, 'disposed', '阶段 2 必须释放旧限制（工具面全量开放）')
  assert.equal(tools.calls.filter((c) => c.kind === 'restrict').length, 1, '全程只设过一次 restrict')
})

test('B: allow 会被 restrictableNames 过滤（平台缺 bash 时不能把 bash 写进去）', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  // 模拟 win32：没有 bash
  const tools = makeScopedTools({ names: ['read', 'grep', 'todo_write'] })
  const session = fakeSession('s1', { events: [] })
  const agent = agentWithTools(session, tools.service)

  await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  assert.equal(tools.calls.length, 1)
  assert.deepEqual([...tools.calls[0].filter.allow].sort(), ['grep', 'read', 'todo_write'], '只保留真实存在的工具')
})

test('B: 拿不到 restrictableNames（没有 view）→ 放弃门控，绝不冒险抛错', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const tools = makeScopedTools({ noView: true })
  const session = fakeSession('s1', { events: [] })
  const agent = agentWithTools(session, tools.service)

  await assert.doesNotReject(async () => {
    await emitWaterfall(stub, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] })
  })
  assert.equal(tools.calls.length, 0, '拿不到名单就不设限制')
})

test('B: restrict 抛错 → 静默放弃，pre-step 照常返回，不冒泡', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const tools = makeScopedTools({ throwOnRestrict: true })
  const session = fakeSession('s1', { events: [] })
  const agent = agentWithTools(session, tools.service)

  let decision
  await assert.doesNotReject(async () => {
    decision = await emitWaterfall(
      stub,
      'agent/pre-step',
      { agent, messages: [] },
      { kind: 'enter', messages: [], startsRequestSeries: true },
    )
  })
  assert.equal(decision.kind, 'enter', '门控失败不该改变 decision')
  assert.equal(decision.startsRequestSeries, true)
})

test('B: agent 没有 scoped ctx → 跳过门控，不抛', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const session = fakeSession('s1', { events: [] })

  await assert.doesNotReject(async () => {
    await emitWaterfall(stub, 'agent/pre-step', { agent: { session }, messages: [] }, { kind: 'enter', messages: [] })
  })
})

test('B: 不同会话各自一份限制，互不干扰', async () => {
  const { service } = recordingService({ overrides: { stageRestrict: true } })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const toolsA = makeScopedTools()
  const toolsB = makeScopedTools()
  const agentA = agentWithTools(fakeSession('sa', { events: [] }), toolsA.service)
  const agentB = agentWithTools(fakeSession('sb', { events: [] }), toolsB.service)

  await emitWaterfall(stub, 'agent/pre-step', { agent: agentA, messages: [] }, { kind: 'enter', messages: [] })
  await emitWaterfall(stub, 'agent/pre-step', { agent: agentB, messages: [] }, { kind: 'enter', messages: [] })

  assert.equal(toolsA.calls.filter((c) => c.kind === 'restrict').length, 1)
  assert.equal(toolsB.calls.filter((c) => c.kind === 'restrict').length, 1)
  assert.equal(toolsA.calls.filter((c) => c.kind === 'disposed').length, 0, 'A 的限制不该被 B 的会话释放')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 降级：4 个新字段在服务缺失 / 畸形时退默认（实验开关必须默认关）
 * ══════════════════════════════════════════════════════════════════════════ */

test('降级: 服务缺失时 4 个新字段退默认 —— 协议段开、档位 auto、两个实验开关关', async () => {
  const stub = makeCtx() // 完全没有 codingModeSettings
  presetApply(stub.ctx, {})

  // 协议段照常（默认开）
  assert.ok(stub.sectionByName('coding-mode:protocol').text().includes('## 编程模式'))

  // 档位 auto：复杂子任务走 pro
  const child = fakeSession('child', { parentSession: 'p' })
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: child },
    message: userMessage('帮我重构这个模块的并发架构，顺手把迁移方案也设计一下'),
  })
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child } }, { provider: 'seed', model: 'seed' })
  assert.equal(resolved.model, DEFAULT_TIERS.pro.model, '读不到服务时 tierPolicy 必须是 auto')

  // 两个实验开关关：既没有 restrict 调用，也没有统计摘要
  assert.equal(stub.tools.length, 0, 'stageRestrict 默认关 → 不调用 restrict')
  assert.equal(statsLineOf(stub.sectionByName('coding-mode:protocol').text()), '', 'statsFooter 默认关 → 不加摘要')
})

test('降级: 服务的 read() 返回垃圾形状时，4 个新字段也退默认', async () => {
  const service = { read: () => 'not-an-object', stats: () => ZERO_STATS }
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  const session = fakeSession('s1', { events: eventsWrittenWithoutVerify() })
  const { agent, calls } = fakeAgent(session)
  // 交付门默认开（stageGuide 读不到按 true）→ 应驳回
  await emit(stub, 'agent/turn-stopping', { agent, turn: 1 })
  assert.equal(calls.length, 1, '垃圾形状 → 按内置默认（行为层开关默认开）')

  assert.ok(stub.sectionByName('coding-mode:protocol').text().includes('## 编程模式'))
  assert.equal(statsLineOf(stub.sectionByName('coding-mode:protocol').text()), '')
})

test('降级: read() 抛错时 4 个新字段也退默认，且不抛', async () => {
  const service = {
    read: () => {
      throw new Error('read exploded')
    },
    stats: () => ZERO_STATS,
  }
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  assert.doesNotThrow(() => stub.sectionByName('coding-mode:protocol').text())
  assert.ok(stub.sectionByName('coding-mode:protocol').text().includes('## 编程模式'))
  assert.equal(statsLineOf(stub.sectionByName('coding-mode:protocol').text()), '', '读失败 → statsFooter 必须退 false')
  assert.equal(stub.tools.length, 0, '读失败 → stageRestrict 必须退 false')
})

// ─────────────────────────────────────────────────────────────
// 用户要求（原话）：「哪怕我 flash 和 pro 档位调的是一样的，也会正常工作，
// 正常派 flash 和 pro」+「flash 和 pro 都指的是用户在设置界面填写的对应的模型…
// 不要写死 ds 的 flash 和 pro 模型」
//
// 这两条是**契约**，不是实现细节：
//   · 档位路由必须**严格来自配置**，不得因为"两个档配了同一个模型"就跳过改写
//     （跳过会表现为：统计里没有档位记录、或子代理继承了错误的强度）
//   · 不得对 provider/model 做任何"是不是 DeepSeek"的假设
// ─────────────────────────────────────────────────────────────

test('⑦ 分档: flash 与 pro 配成**同一个模型**也必须正常分档派发', async () => {
  const same = { provider: 'some-relay', model: 'some-model' }
  const { service, rec } = recordingService({
    overrides: { tiers: { flash: { ...same, reasoningEffort: 'low' }, pro: { ...same, reasoningEffort: 'high' } } },
  })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})

  // 简单任务 → flash 档
  const childA = fakeSession('child-a', { parentSession: 'p' })
  await emit(stub, 'agent/inbox/claimed', { agent: { session: childA }, message: userMessage('改个字符串') })
  const a = await emitWaterfall(stub, 'agent/request', { agent: { session: childA }, turn: 1, step: 1 }, { provider: 'seed', model: 'seed' })

  // 复杂任务 → pro 档
  const childB = fakeSession('child-b', { parentSession: 'p' })
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: childB },
    message: userMessage('帮我重构并发架构，并设计完整的数据迁移方案与回滚策略'),
  })
  const b = await emitWaterfall(stub, 'agent/request', { agent: { session: childB }, turn: 1, step: 1 }, { provider: 'seed', model: 'seed' })

  // 两者 provider/model 相同（因为用户就是这么配的），但**档位记录必须不同**
  assert.equal(a.provider, same.provider)
  assert.equal(a.model, same.model)
  assert.equal(b.provider, same.provider)
  assert.equal(b.model, same.model)
  assert.deepEqual(rec.tiers, ['flash', 'pro'], '两个档位都必须被记录，不能因为模型相同而跳过')
})

test('⑦ 分档: 档位模型**不是 DeepSeek** 时照常工作（绝不写死 DS 的模型）', async () => {
  const { service, rec } = recordingService({
    overrides: {
      tiers: {
        flash: { provider: 'anthropic-relay', model: 'claude-haiku-5-5', reasoningEffort: 'low' },
        pro: { provider: 'openai-relay', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      },
    },
  })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'p' })
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: child },
    message: userMessage('帮我重构并发架构，并设计迁移方案与回滚策略'),
  })
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child }, turn: 1, step: 1 }, { provider: 'seed', model: 'seed' })
  assert.equal(resolved.provider, 'openai-relay')
  assert.equal(resolved.model, 'gpt-6.1-sol')
  assert.deepEqual(rec.tiers, ['pro'])
})

test('⑦ 分档: 两个档位 provider 相同但 model 不同时也按档位正确改写', async () => {
  const { service, rec } = recordingService({
    overrides: {
      tiers: {
        flash: { provider: 'one-relay', model: 'cheap-model', reasoningEffort: 'low' },
        pro: { provider: 'one-relay', model: 'strong-model', reasoningEffort: 'high' },
      },
    },
  })
  const stub = makeCtx({ service })
  presetApply(stub.ctx, {})
  const child = fakeSession('child', { parentSession: 'p' })
  await emit(stub, 'agent/inbox/claimed', {
    agent: { session: child },
    message: userMessage('帮我重构并发架构，并设计迁移方案与回滚策略'),
  })
  const resolved = await emitWaterfall(stub, 'agent/request', { agent: { session: child }, turn: 1, step: 1 }, { provider: 'seed', model: 'seed' })
  assert.equal(resolved.provider, 'one-relay', 'provider 按配置')
  assert.equal(resolved.model, 'strong-model', 'model 必须是 pro 档配的那个')
  assert.deepEqual(rec.tiers, ['pro'])
})
