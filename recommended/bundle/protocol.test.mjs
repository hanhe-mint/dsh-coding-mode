/**
 * protocol.test.mjs — protocol.js 的单元测试（纯函数，无外部依赖）。
 * 运行：node --test protocol.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTask, buildProtocol, buildNearFieldGuide, planGateDecision, TIERS, GATED_TOOLS, subagentEffortBand, parseFlowOverrides, parseEffortBandOverrides } from './protocol.js'

/* ---------------- classifyTask ---------------- */

test('classifyTask: 故障类识别为 fix', () => {
  assert.equal(classifyTask('登录接口报错了，一直返回 500，帮我修一下').form, 'fix')
})

test('classifyTask: 构建类识别为 build', () => {
  assert.equal(classifyTask('帮我实现一个用户导出 CSV 的函数').form, 'build')
})

test('classifyTask: 故障词优先于构建词', () => {
  assert.equal(classifyTask('实现的功能报错了，修复它').form, 'fix')
})

test('classifyTask: 极短且无动词 → ambiguous', () => {
  assert.equal(classifyTask('嗯？').form, 'ambiguous')
})

test('classifyTask: 长文本判为复杂任务', () => {
  assert.equal(classifyTask('a'.repeat(240)).complex, true)
})

test('classifyTask: 架构关键词判为复杂任务', () => {
  assert.equal(classifyTask('帮我重构这个模块的并发架构').complex, true)
  assert.equal(classifyTask('帮我改个按钮颜色').complex, false)
})

test('classifyTask: 空输入不抛异常', () => {
  assert.doesNotThrow(() => classifyTask(''))
  assert.doesNotThrow(() => classifyTask(null))
  assert.equal(classifyTask(undefined).form, 'ambiguous')
})

/* ---------------- 档位（flash / pro） ---------------- */

test('TIERS: 只有 flash 和 pro 两档', () => {
  assert.deepEqual([...TIERS], ['flash', 'pro'])
})

test('buildProtocol: 两档各渲染一行，含 provider / model / reasoning_effort', () => {
  const text = buildProtocol({
    tiers: {
      flash: { provider: 'dieqiyun', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      pro: { provider: 'dieqiyun', model: 'deepseek-v4-pro-0813', reasoningEffort: 'max' },
    },
  })
  assert.ok(text.includes('deepseek-v4.1-flash'))
  assert.ok(text.includes('deepseek-v4-pro-0813'))
  assert.ok(text.includes('reasoning_effort=`high`'))
  assert.ok(text.includes('reasoning_effort=`max`'))
  assert.ok(text.includes('**flash**'))
  assert.ok(text.includes('**pro**'))
})

test('buildProtocol: 未配置的档位明确提示去设置页，不静默省略', () => {
  const text = buildProtocol({ tiers: {} })
  const hits = text.match(/未配置/g) || []
  assert.equal(hits.length, 2, '两档都应出现"未配置"提示')
})

test('buildProtocol: 只配 provider+model、不配推理强度时，不渲染 effort 片段', () => {
  const text = buildProtocol({
    tiers: { flash: { provider: 'p', model: 'm', reasoningEffort: '' }, pro: { provider: 'p', model: 'm2' } },
  })
  assert.ok(!text.includes('reasoning_effort='), '空强度不应渲染出 effort 片段')
})

test('buildProtocol: 档位名固定为 flash/pro（用户可自配模型，但不改档位名）', () => {
  const text = buildProtocol({
    tiers: {
      flash: { provider: 'myprov', model: 'my-cool-model' },
      pro: { provider: 'myprov', model: 'my-strong-model' },
    },
  })
  assert.ok(text.includes('**flash**'))
  assert.ok(text.includes('**pro**'))
  assert.ok(text.includes('my-cool-model'), '自定义模型名应出现在协议里')
  assert.ok(text.includes('myprov'), '自定义 provider 应出现在协议里')
})

test('buildProtocol: 明确"默认用 flash 档，只在规划/红队才切 pro"', () => {
  assert.ok(buildProtocol({}).includes('默认用 flash 档'))
})

/* ---------------- 协议正文 ---------------- */

test('buildProtocol: 包含全部协议段落', () => {
  const text = buildProtocol({})
  for (const marker of [
    '## 编程模式',
    '### 思考纪律',
    '### 0 · 对齐',
    '### 1 · 发散',
    '### 2 · 计划锁定',
    '### 3 · 执行',
    '### 4 · 验证',
    '### 5 · 收敛',
    '### 档位',
  ]) {
    assert.ok(text.includes(marker), `缺少段落：${marker}`)
  }
})

test('buildProtocol: planGate 开关改变门禁文案，开启时说明是真拦截', () => {
  const on = buildProtocol({ planGate: true })
  assert.ok(on.includes('门禁已强制生效'))
  assert.ok(on.includes('直接拒绝'), '应说明是真拦截而非提醒')
  assert.ok(buildProtocol({ planGate: false }).includes('已关闭'))
})

test('buildProtocol: 明确要求用简体中文回复（避免 agent 一直说英语）', () => {
  assert.ok(buildProtocol({}).includes('用简体中文回复用户'))
})

test('buildProtocol: 图像任务必须用支持图像的模型', () => {
  assert.ok(buildProtocol({}).includes('图像'))
})

test('buildProtocol: loopGuard 开关改变收敛段文案', () => {
  assert.ok(buildProtocol({ loopGuard: true }).includes('不许结束回合'))
  assert.ok(!buildProtocol({ loopGuard: false }).includes('不许结束回合'))
})

test('buildProtocol: 不含长期记忆（防作弊：不做记忆回写）', () => {
  const text = buildProtocol({})
  assert.ok(!text.includes('长期记忆'), '协议不应再出现长期记忆段')
  assert.ok(!text.includes('记忆文件'), '协议不应要求写记忆文件')
})

/* ---------------- buildNearFieldGuide ---------------- */

test('buildNearFieldGuide: 简单任务走快收敛', () => {
  const g = buildNearFieldGuide({ form: 'build', complex: false })
  assert.ok(g.includes('简单任务'))
  assert.ok(g.includes('一步到位'))
})

test('buildNearFieldGuide: 复杂任务走决策闭合深引导', () => {
  const g = buildNearFieldGuide({ form: 'fix', complex: true })
  assert.ok(g.includes('复杂任务'))
  assert.ok(g.includes('一个决定或一个信息需求结尾'))
  assert.ok(g.includes('先定位真实根因'))
})

/* ---------------- planGateDecision（计划门禁真拦截逻辑） ---------------- */

test('planGateDecision: 门禁开 + 计划模式生效 + write → 拒绝', () => {
  const r = planGateDecision({ planGate: true, toolName: 'write', planActive: true })
  assert.equal(typeof r, 'string')
  assert.ok(r.includes('exit_plan_mode'))
})

test('planGateDecision: 门禁开 + 计划模式生效 + edit → 拒绝', () => {
  assert.equal(typeof planGateDecision({ planGate: true, toolName: 'edit', planActive: true }), 'string')
})

test('planGateDecision: 计划模式未生效 → 放行（正常写文件不受影响）', () => {
  assert.equal(planGateDecision({ planGate: true, toolName: 'write', planActive: false }), undefined)
})

test('planGateDecision: 计划状态不可判定 → 放行（失败开放，不卡死工作）', () => {
  assert.equal(planGateDecision({ planGate: true, toolName: 'write', planActive: undefined }), undefined)
})

test('planGateDecision: 门禁关闭 → 放行', () => {
  assert.equal(planGateDecision({ planGate: false, toolName: 'write', planActive: true }), undefined)
})

test('planGateDecision: 只拦 write/edit，不拦 bash / read（计划期仍可读日志列目录）', () => {
  for (const name of ['bash', 'read', 'glob', 'grep', 'todo_write', 'ask_user_question']) {
    assert.equal(planGateDecision({ planGate: true, toolName: name, planActive: true }), undefined, `${name} 不应被门禁拦截`)
  }
  assert.deepEqual([...GATED_TOOLS], ['write', 'edit'])
})

test('planGateDecision: 工具名缺失或非字符串 → 放行，不抛异常', () => {
  assert.doesNotThrow(() => planGateDecision({ planGate: true, planActive: true }))
  assert.equal(planGateDecision({ planGate: true, toolName: undefined, planActive: true }), undefined)
  assert.equal(planGateDecision({ planGate: true, toolName: 42, planActive: true }), undefined)
})

// ─────────────────────────────────────────────────────────────
// 子代理强度偏好：必须由**主会话档位**驱动（本轮用户新要求）
// ─────────────────────────────────────────────────────────────
test('subagentEffortBand: 主档位越高，推荐区间整体上移', () => {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const rank = (x) => order.indexOf(x)
  const tiers = ['low', 'medium', 'high', 'max']
  const bands = tiers.map((t) => subagentEffortBand(t))
  // 起手档位单调不降
  for (let i = 1; i < bands.length; i++) {
    assert.ok(
      rank(bands[i].prefer) >= rank(bands[i - 1].prefer),
      `档位 ${tiers[i]} 的起手 ${bands[i].prefer} 不该低于 ${tiers[i - 1]} 的 ${bands[i - 1].prefer}`,
    )
  }
  // 上界同样单调不降
  for (let i = 1; i < bands.length; i++) {
    assert.ok(rank(bands[i].ceil) >= rank(bands[i - 1].ceil), `档位 ${tiers[i]} 的上界应不低于前一档`)
  }
})

test('subagentEffortBand: 低档位偏省 token（上界不高于 medium）', () => {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const t of ['off', 'minimal', 'low']) {
    const b = subagentEffortBand(t)
    assert.ok(order.indexOf(b.ceil) <= order.indexOf('medium'), `${t} 的上界应 ≤ medium，实际 ${b.ceil}`)
  }
})

test('subagentEffortBand: 高档位偏稳妥但**不顶格起手**（顶格会挤掉收敛）', () => {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const rank = (x) => order.indexOf(x)
  for (const t of ['high', 'xhigh', 'max', 'ultra']) {
    const b = subagentEffortBand(t)
    // 起手不顶格：顶格实测会挤掉收敛，所以任何高档位都不该直接以 max 起手
    assert.notEqual(b.prefer, 'max', `${t} 的起手不该直接顶格`)
    // 下沿保底：高档位的下沿至少是 medium（低强度下不会去跑难题），且不高于起手
    assert.ok(rank(b.floor) >= rank('medium'), `${t} 的下沿应至少 medium，实际 ${b.floor}`)
    assert.ok(rank(b.floor) <= rank(b.prefer), `${t} 的下沿不该高于起手（${b.floor} > ${b.prefer}）`)
    // 上界不低于起手
    assert.ok(rank(b.ceil) >= rank(b.prefer), `${t} 的上界不该低于起手（${b.ceil} < ${b.prefer}）`)
  }
})

test('subagentEffortBand: 档位读不到时退回 medium 区间（不顶格）', () => {
  for (const bad of ['', undefined, null, 'NOPE']) {
    const b = subagentEffortBand(bad)
    assert.equal(b.prefer, 'medium', `未知档位 ${String(bad)} 应退回 medium`)
  }
})

test('auto 指引会带出主档位与推荐区间（模型真能看到）', () => {
  const tiers = { flash: { provider: 'p', model: 'm' }, pro: { provider: 'p', model: 'm' } }
  const text = buildProtocol({ tiers, tier: 'high', effortPolicy: 'auto' })
  assert.match(text, /建议区间/, 'auto 指引应给出推荐区间')
  assert.ok(text.includes('`high`'), '应回显主档位，让模型知道基调从哪来')
})

test('fixed 策略下不出现"自选"指引（避免自相矛盾）', () => {
  const tiers = { flash: { provider: 'p', model: 'm' }, pro: { provider: 'p', model: 'm' } }
  const text = buildProtocol({ tiers, tier: 'high', effortPolicy: 'fixed' })
  assert.ok(!text.includes('建议区间'), 'fixed 下不该再出现自选区间指引')
})

// ─────────────────────────────────────────────────────────────
// 用户自配的「档位 → 流程 / 强度区间」覆盖表
// 用户原话：「其他模型不用再适配，让用户自己在设置里调就行」
//          「不做适配了，直接写在设置页面里」
// ─────────────────────────────────────────────────────────────
test('parseFlowOverrides: 基本语法（; 分档位，, 分能力，all 与留空）', () => {
  const o = parseFlowOverrides('low=;medium=converge;high=cross,red,converge;xhigh=all;max=all')
  assert.deepEqual(o.low, { diverge: false, cross: false, red: false, converge: false })
  assert.deepEqual(o.medium, { diverge: false, cross: false, red: false, converge: true })
  assert.deepEqual(o.high, { diverge: false, cross: true, red: true, converge: true })
  assert.deepEqual(o.xhigh, { diverge: true, cross: true, red: true, converge: true })
})

test('parseFlowOverrides: 非法能力名整条忽略（宁可不改也不猜错）', () => {
  const o = parseFlowOverrides('bogus=x,y;high=all')
  assert.equal(o.bogus, undefined, '含未知能力名的整条应被忽略')
  assert.deepEqual(o.high, { diverge: true, cross: true, red: true, converge: true }, '合法条目照常生效')
})

test('parseFlowOverrides: 空串/非串/坏语法 → 空覆盖表（不改行为）', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}, 'no-equals-sign', '=all']) {
    assert.deepEqual(parseFlowOverrides(bad), {}, `输入 ${JSON.stringify(bad)} 应得到空表`)
  }
})

test('parseFlowOverrides: 接受 DS 没有的档位名（不做白名单校验）', () => {
  // 别的渠道可能只有 low/medium/high，或叫别的名字 —— 用户要能自己配
  const o = parseFlowOverrides('minimal=;custom-tier=all')
  assert.deepEqual(o['custom-tier'], { diverge: true, cross: true, red: true, converge: true })
})

test('parseEffortBandOverrides: 基本语法（下沿~上界@起手，@ 可省）', () => {
  const o = parseEffortBandOverrides('low=none~medium@low;high=medium~xhigh@high;ultra=xhigh~max')
  assert.deepEqual(o.low, { floor: 'none', ceil: 'medium', prefer: 'low' })
  assert.deepEqual(o.high, { floor: 'medium', ceil: 'xhigh', prefer: 'high' })
  assert.deepEqual(o.ultra, { floor: 'xhigh', ceil: 'max', prefer: 'xhigh' }, '@ 省略时起手＝下沿')
})

test('parseEffortBandOverrides: 坏语法整条忽略，空输入得空表', () => {
  assert.deepEqual(parseEffortBandOverrides('low=nostilde;high=low~high'), {
    high: { floor: 'low', ceil: 'high', prefer: 'low' },
  })
  for (const bad of ['', undefined, null, 7, 'low=']) {
    assert.deepEqual(parseEffortBandOverrides(bad), {})
  }
})

test('buildProtocol: 传覆盖表后生效，未列出的档位仍用内置默认', () => {
  const tiers = { flash: { provider: 'p', model: 'm' }, pro: { provider: 'p', model: 'm' } }
  // high 内置是「无发散」；覆盖成 all 后应出现发散章节
  const def = buildProtocol({ tiers, tier: 'high', effortPolicy: 'auto' })
  assert.ok(!def.includes('### 1 · 发散'), '内置 high 不应有发散')
  const over = buildProtocol({ tiers, tier: 'high', effortPolicy: 'auto', flowByTier: 'high=all' })
  assert.ok(over.includes('### 1 · 发散'), '覆盖 high=all 后应有发散')
  // medium 没被覆盖 → 仍按内置（无跨验）
  const m = buildProtocol({ tiers, tier: 'medium', effortPolicy: 'auto', flowByTier: 'high=all' })
  assert.ok(!m.includes('**跨验**'), '未列出的 medium 应沿用内置默认')
})

test('buildProtocol: 空覆盖串与不传字段**逐字相同**（保证"不配置=旧行为"）', () => {
  const tiers = { flash: { provider: 'p', model: 'm' }, pro: { provider: 'p', model: 'm' } }
  for (const tier of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const a = buildProtocol({ tiers, tier, effortPolicy: 'auto' })
    const b = buildProtocol({ tiers, tier, effortPolicy: 'auto', flowByTier: '', effortByTier: '' })
    assert.equal(a, b, `档位 ${tier}：空覆盖串必须产生完全相同的协议`)
  }
})
