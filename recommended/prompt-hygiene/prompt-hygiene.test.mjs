/**
 * dsh-prompt-hygiene 的契约测试。
 *
 * 为什么要测这段文本：它是**每个请求的固定成本**（进系统提示词），
 * 而且它的作用域（顶层 = 所有模式）是它存在的全部理由 —— 写错作用域就白做。
 * 所以锁住三件事：
 *   ① 必须顶层注册（patch 里是 insert 形态、id 唯一）
 *   ② 段注册的 order/name/interpolate 正确
 *   ③ 文本解析规则（enabled / 覆盖 / 空串）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, inject, name as pluginName } from '../prompt-hygiene/index.js'

const PATCH = readFileSync(new URL('../prompt-hygiene/cordis.patch.yml', import.meta.url), 'utf8')

/** 造一个最小 ctx，记录 systemPrompt.section 的调用参数。 */
function makeCtx() {
  const calls = []
  const effects = []
  const ctx = {
    systemPrompt: {
      section: (spec) => {
        calls.push(spec)
        return () => {}
      },
    },
    effect: (fn, label) => {
      effects.push(label)
      return fn?.()
    },
  }
  return { ctx, calls, effects }
}

test('prompt-hygiene: 导出的契约完整（name / inject / apply）', () => {
  assert.equal(pluginName, 'prompt-hygiene')
  assert.deepEqual(inject, ['systemPrompt'], '必须依赖 systemPrompt 服务')
  assert.equal(typeof apply, 'function')
})

test('prompt-hygiene: 注册进 systemPrompt，order/name/interpolate 正确', () => {
  const { ctx, calls, effects } = makeCtx()
  apply(ctx, {})
  assert.equal(calls.length, 1, '应恰好注册一段')
  const spec = calls[0]
  assert.equal(spec.name, 'prompt-hygiene:token-rules', '段名必须唯一且稳定（同名会抛 already registered）')
  assert.equal(spec.order, -890, 'order 必须固定为 -890（负值区＝系统级规则，紧跟语言闸 -900）')
  assert.ok(spec.order < 0, 'order 必须为负：本段是系统级约束，应排在 persona 与工具说明之前')
  assert.equal(spec.interpolate, false, '必须关掉 {{变量}} 插值（否则用户粘贴含 {{ 的文本会让每次装配抛错）')
  assert.equal(typeof spec.text, 'function', 'text 必须是函数，改配置无需重注册')
  assert.ok(effects.some((l) => String(l).includes('prompt-hygiene')), '注册必须包在 ctx.effect 里（否则热重载撞同名段）')
})

test('prompt-hygiene: 默认文本含 4 条省 token 规则的关键词', () => {
  const { ctx, calls } = makeCtx()
  apply(ctx, {})
  const text = calls[0].text()
  for (const kw of ['不要往上下文里灌全量输出', '子代理', '截断', '换任务就开新会话']) {
    assert.ok(text.includes(kw), `默认文本应包含「${kw}」`)
  }
})

test('prompt-hygiene: enabled=false 时渲染空串（DSH 会丢弃空段 = 净效果为不存在）', () => {
  const { ctx, calls } = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal(calls[0].text(), '', '关掉时必须返回空串')
})

test('prompt-hygiene: 用户在设置页覆盖 text 后生效，清空则回退默认', () => {
  const custom = '自定义规则：只用 head -50。'
  const a = makeCtx()
  apply(a.ctx, { text: custom })
  assert.equal(a.calls[0].text(), custom)

  const b = makeCtx()
  apply(b.ctx, { text: '   ' })
  assert.ok(b.calls[0].text().includes('不要往上下文里灌全量输出'), '空白文本应回退默认')
})

test('prompt-hygiene: 没有 systemPrompt 服务时不崩（只是不注册）', () => {
  let ran = false
  const ctx = {
    effect: (fn) => {
      ran = true
      return fn?.()
    },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.ok(ran, '应走到 effect 里而不抛')
})

test('prompt-hygiene: patch 用 insert 形态且 id 唯一（否则会被静默跳过 = 插件没加载）', () => {
  assert.ok(PATCH.includes('- insert:'), '补丁必须含 insert:（没有 insert 的是覆盖补丁，匹配不到会静默跳过）')
  assert.ok(PATCH.includes("id: prompt-hygiene"), '应插入 id: prompt-hygiene')
  assert.ok(PATCH.includes("name: 'dsh-prompt-hygiene'"), '插入行的包名必须是 dsh-prompt-hygiene')
  const idCount = (PATCH.match(/id: prompt-hygiene\b/g) ?? []).length
  assert.equal(idCount, 1, 'id 只能出现一次')
})
