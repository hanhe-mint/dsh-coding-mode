/**
 * client.test.mjs — 浏览器半侧（bundle/client.js）的真实冒烟测试。
 *
 * 它真的执行 `window.__ModuleLoader__.load({...})`、真的用假 require 取出模块、
 * 真的调用 `apply(ctx)`、再用 build-check/mini-react.mjs 把页面渲染出来，
 * 断言「describe → 结构识别 ns → 渲染控件 → 点按钮 → 发 mutate ops」这条通路。
 *
 * 这不是替代真机验证：它不能证明 DSH 真的会把页面挂上去（那需要重启后的页面）。
 * 它能证明的是：模块格式对、注册参数对、渲染不抛、ops 形状对、只往自己的 ns 写。
 *
 * 用法：node --test client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { click, buttons, find, hasText, reset, settle, textOf, type, walk } from './mini-react.mjs'

const CLIENT = new URL('../bundle/client.js', import.meta.url)
const PACKAGE_NAME = '@local/dsh-coding-mode'

/** 本插件最早的 8 个「身份字段」（与 index.js 一致）——结构识别只用这 8 个。 */
const OURS = {
	flashProvider: 'dieqiyun',
	flashModel: 'deepseek-v4.1-flash',
	flashReasoningEffort: 'high',
	proProvider: 'dieqiyun',
	proModel: 'deepseek-v4-pro-0813',
	proReasoningEffort: 'high',
	planGate: true,
	loopGuard: true,
}

/** 本次新增的 4 个行为开关（默认全 true）。 */
const OURS_NEW = {
	stageGuide: true,
	taskEcho: true,
	nearFieldGuide: true,
	tierSubagents: true,
}

/**
 * 再新增的 4 个字段（D/C/B 三项）：协议段总开关 + 档位策略 + 两个**默认关**的实验开关。
 *
 * `statsFooter` / `stageRestrict` 默认**false** —— 这里显式写成 false，
 * 与 Host 半侧 `Config` 的 default 一致；测试里必须能区分"缺字段（→ 关）"
 * 与"显式 true（→ 开）"两种情形。
 */
const OURS_EXPERIMENT = {
	protocolSection: true,
	tierPolicy: 'auto',
	statsFooter: false,
	stageRestrict: false,
}

/**
 * 硬流程门 + 推理强度策略（B / C 两项）。
 *
 * `flowGate` 默认 **false**（它会直接拒绝 write/edit 并驳回轮次收尾，默认开就是惊吓），
 * `effortPolicy` 默认 **auto**（模型按任务自选强度）—— 都与 Host 半侧 `Config`
 * 的 default 一致，测试里必须能区分"缺字段"与"显式设置"两种情形。
 */
const OURS_GATES = {
	flowGate: false,
	effortPolicy: 'auto',
}

/** 19 个字段齐全的配置值（模拟真实 settings 文档：新字段也出现在 value 里）。 */
const OURS_FULL = { ...OURS, ...OURS_NEW, ...OURS_EXPERIMENT, ...OURS_GATES }

/** 一个别的插件的 ns，用来验证页面绝不碰别人。 */
const FOREIGN = {
	ns: 'include:ui-settings-account',
	revision: 7,
	autoGenerate: true,
	applies: 'live',
	secrets: [],
	schema: { type: 'object' },
	value: { enabled: true, version: 1 },
}

/**
 * 在一个干净的全局环境里加载 client.js 并取出模块。
 * @param {object} [options]
 * @param {boolean} [options.withDocument] 是否提供假的 document（用于验证 CSS 注入）
 */
function loadClientModule({ withDocument = false } = {}) {
	const originalWindow = globalThis.window
	const originalDocument = globalThis.document
	const styles = []

	let registration = null
	globalThis.window = {
		__ModuleLoader__: {
			load(value) {
				registration = value
			},
		},
	}
	if (withDocument) {
		globalThis.document = {
			querySelector: () => null,
			head: {
				appendChild(tag) {
					styles.push(tag)
				},
			},
			createElement: () => ({ dataset: {}, textContent: '' }),
		}
	}

	// eslint-disable-next-line no-new-func
	const source = readFileSync(CLIENT, 'utf8')
	const run = new Function('window', 'document', source)
	run(globalThis.window, globalThis.document)

	assert.ok(registration !== null, 'client.js 必须调用 window.__ModuleLoader__.load()')
	assert.equal(registration.id, PACKAGE_NAME, 'loader id 必须等于包名')

	const requested = []
	const module = registration.factory((specifier) => {
		requested.push(specifier)
		if (specifier === 'react') return miniReactShim
		if (specifier === '@deepseek-ai/dsh-client-ui-slots') return { resolveSlotLabel: (label) => (typeof label === 'function' ? label() : label) }
		throw new Error(`client.js 不应该 require("${specifier}")：只允许平台种子词 react / @deepseek-ai/dsh-client-ui-slots`)
	})

	globalThis.window = originalWindow
	if (withDocument) globalThis.document = originalDocument
	else delete globalThis.document

	return { module, requested, styles, registration }
}

/** 取 mini-react 的导出当作 react 替身。 */
const miniReactShim = await import('./mini-react.mjs')

/**
 * 造一个假的客户端 ctx：只提供 client.js 真正用到的 slots 与 remote.settings。
 * @param {object} options
 * @param {any[]} options.namespaces describe() 要返回的 namespaces
 * @param {number} [options.writable]
 * @param {(call:any)=>any} [options.onMutate] mutate 的应答器
 * @param {boolean} [options.describeFails]
 * @param {any} [options.stats] 传了就假装宿主暴露了统计服务，stats() 返回这个值
 * @param {boolean} [options.statsThrows] stats() 直接抛（验证页面不崩）
 */
function makeClientCtx({ namespaces, writable = true, onMutate, describeFails = false, stats, statsThrows = false } = {}) {
	const registrations = []
	const calls = { describe: 0, mutate: [], stats: 0 }
	const remote = {
		settings: {
			describe: async () => {
				calls.describe += 1
				if (describeFails) return { ok: false, error: { code: 'gateway/internal', message: '读取失败' } }
				return { ok: true, value: { writable, hasDocument: true, namespaces } }
			},
			mutate: async (ns, ops, revision) => {
				calls.mutate.push({ ns, ops, revision })
				if (onMutate !== undefined) return onMutate({ ns, ops, revision })
				return {
					ok: true,
					value: { ns, revision: (revision ?? 0) + 1, autoGenerate: false, applies: 'live', secrets: [] },
				}
			},
		},
	}

	// 只有显式要求时才挂统计命名空间：默认（不传）模拟真实环境 —— 宿主没暴露，
	// 客户端无论如何都读不到，页面必须如实显示「不可读」。
	if (stats !== undefined || statsThrows) {
		remote.codingModeStats = {
			stats: async () => {
				calls.stats += 1
				if (statsThrows) throw new Error('宿主统计读取爆炸')
				return stats
			},
		}
	}

	const ctx = {
		remote,
		slots: {
			inject(name, callback) {
				registrations.push({ name, callback })
				return () => {}
			},
			register(options, component) {
				registrations.push({ options, component })
				return () => {}
			},
		},
		logger: { error: () => {}, warn: () => {} },
	}
	return { ctx, registrations, calls }
}

/** 跑一次 apply，返回渲染上下文。 */
function setup(describeOptions) {
	const { ctx, registrations, calls } = makeClientCtx(describeOptions)
	const { module, requested } = loadClientModule({ withDocument: true })
	module.apply(ctx)

	// slots.inject("settings.plugins.tab", cb) → 手动触发一次（等于槽位声明完成）
	const injection = registrations.find((row) => typeof row.callback === 'function')
	assert.ok(injection !== undefined, '必须调用 ctx.slots.inject()')
	assert.equal(injection.name, 'settings.plugins.tab', '必须注册进 settings.plugins.tab')

	reset()
	injection.callback()

	const registered = registrations.find((row) => row.options !== undefined && row.component !== undefined)
	assert.ok(registered !== undefined, 'slots.inject 的回调里必须调用 ctx.slots.register()')

	return { ctx, calls, requested, registered, module }
}

/** 渲染并等待稳定。 */
async function mount(registered) {
	return settle(() => {
		const injected = typeof registered.options.inject === 'function' ? registered.options.inject() : {}
		return miniReactShim.createElement(registered.component, injected)
	})
}

/** 造一个「我们自己的」ns，value 可定制。 */
function oursNs(value, revision = 1, ns = 'include:coding-mode-settings') {
	return { ns, revision, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value }
}

/**
 * 点某个开关行右侧的按钮。
 * mini-react 的 click() 只按按钮文案匹配，而开关文案只有「已开启 / 已关闭」两组，
 * 分不清是哪一个开关 —— 所以这里按**行标题**先定位那一行，再点行内那个按钮。
 * @param tree 宿主树
 * @param title 开关标题（含字段名的那个）
 */
function clickToggle(tree, title) {
	let target = null
	walk(tree, (node) => {
		if (target !== null) return
		if (node.type !== 'div' || node.props.className !== 'dshcm_row') return
		if (!textOf(node).includes(title)) return
		const button = find(node, (child) => child.type === 'button')
		if (button !== null) target = button
	})
	if (target === null) throw new Error(`找不到开关行「${title}」`)
	target.props.onClick()
}

/** 让一次 async 保存跑完（settle 里已经让出事件循环，这里再补两拍给 await 链）。 */
async function pump() {
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))
}

/* ══════════════════ 模块格式 ══════════════════ */

test('client.js: 用 __ModuleLoader__.load 注册，id 等于包名', () => {
	const { registration } = loadClientModule()
	assert.equal(registration.id, PACKAGE_NAME)
	assert.equal(typeof registration.factory, 'function')
})

test('client.js: 只用平台种子词（react / ui-slots），绝不碰任何 Harness Client 组件包', () => {
	const { requested } = loadClientModule()
	assert.deepEqual([...requested].sort(), ['@deepseek-ai/dsh-client-ui-slots', 'react'])
	assert.ok(!requested.includes('@deepseek-ai/dsh-client-ui-primitives'), '禁止 require primitives')
	for (const specifier of requested) {
		assert.ok(!/dsh-client-ui-(?!slots)/.test(specifier), `不应依赖 ${specifier}`)
	}
})

test('client.js: 在 <head> 注入自己的样式表（data-plugin = 包名）', () => {
	const { styles } = loadClientModule({ withDocument: true })
	assert.equal(styles.length, 1, '应注入 1 个 style 标签')
	assert.equal(styles[0].dataset.plugin, PACKAGE_NAME)
	assert.ok(styles[0].textContent.includes('--dsw-alias-label-primary'), 'CSS 必须只用主题 token')
})

test('client.js: CSS 里没有任何字面颜色（只允许主题 token）', () => {
	const { styles } = loadClientModule({ withDocument: true })
	const text = styles[0].textContent
	const literals = text.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)
	assert.equal(literals, null, `不应出现字面颜色，实际出现：${literals?.join(', ')}`)
})

test('client.js: 导出注入依赖与 apply', () => {
	const { module } = loadClientModule()
	assert.deepEqual(module.inject, ['slots', 'remote', 'remote.settings'])
	assert.equal(typeof module.apply, 'function')
})

/* ══════════════════ 注册参数 ══════════════════ */

test('注册: 进 settings.plugins.tab，id/order/label 正确', () => {
	const { registered } = setup({ namespaces: [FOREIGN] })
	assert.equal(registered.options.name, 'settings.plugins.tab')
	assert.equal(registered.options.id, 'coding-mode')
	assert.equal(registered.options.order, 20)
	assert.equal(registered.options.label(), '编程模式')
	assert.equal(typeof registered.options.inject, 'function')
})

/* ══════════════════ 命名空间识别 ══════════════════ */

test('识别: 顶层条目 `include:coding-mode-settings` 能被找到并使用', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 3, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered, calls } = setup({ namespaces: [FOREIGN, ours] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '编程模式'), '应渲染出页面')
	assert.ok(hasText(tree, 'include:coding-mode-settings'), '应显示自己那个 ns')
	assert.ok(!hasText(tree, 'include:ui-settings-account'), '不应显示别人的 ns')
	assert.equal(calls.describe, 1)
	assert.ok(hasText(tree, 'dieqiyun'), '应显示当前生效值')
	assert.ok(hasText(tree, 'deepseek-v4.1-flash'))
})

test('识别: 条目 id 不带 include: 前缀时也能找到', async () => {
	const ours = { ns: 'coding-mode-settings', revision: 0, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered } = setup({ namespaces: [ours] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, 'coding-mode-settings'))
	assert.ok(hasText(tree, 'dieqiyun'))
})

test('识别: ns 名字陌生但字段齐全 → 靠 8 个字段结构识别', async () => {
	const ours = { ns: 'include:some-renamed-entry', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered } = setup({ namespaces: [FOREIGN, ours] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, 'include:some-renamed-entry'))
	assert.ok(hasText(tree, 'dieqiyun'))
})

test('识别: 只有别人的 ns → 显示「找不到命名空间」并把可用 ns 列出来，不抛', async () => {
	const { registered } = setup({ namespaces: [FOREIGN] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '没有找到本插件的配置命名空间'), '应给出明确诊断')
	assert.ok(hasText(tree, 'include:ui-settings-account'), '应列出可用的 ns 方便排查')
	assert.ok(!hasText(tree, '保存改动'), '没有 ns 时不应出现保存按钮')
})

test('识别: describe 失败 → 显示错误与重试，不抛', async () => {
	const { registered } = setup({ namespaces: [], describeFails: true })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '读取配置失败'))
	assert.ok(buttons(tree).some((entry) => entry.label === '重试'))
})

/* ══════════════════ 控件形态 ══════════════════ */

test('控件: 推理强度是按钮组，含（不设置）+ minimal/low/medium/high/max', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered } = setup({ namespaces: [ours] })
	const tree = await mount(registered)
	const labels = buttons(tree).map((entry) => entry.label)
	for (const expected of ['（不设置）', 'minimal', 'low', 'medium', 'high', 'max']) {
		assert.ok(labels.includes(expected), `应有推理强度按钮「${expected}」，实际：${[...new Set(labels)].join(' | ')}`)
	}
})

test('控件: 两个开关存在，文案显示当前状态', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS, planGate: true, loopGuard: false } }
	const { registered } = setup({ namespaces: [ours] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '计划门禁（planGate）'))
	assert.ok(hasText(tree, '循环守护（loopGuard）'))
	assert.ok(hasText(tree, '已开启'))
	assert.ok(hasText(tree, '已关闭'))
})

/* ══════════════════ 保存通路 ══════════════════ */

test('保存: 改 model 后点保存 → mutate 收到正确 ns / path 数组 / revision', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 5, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered, calls } = setup({ namespaces: [ours] })
	let tree = await mount(registered)

	type(tree, 'model', 'my-model')
	tree = await settle(() => {
		const injected = registered.options.inject()
		return miniReactShim.createElement(registered.component, injected)
	})

	assert.ok(hasText(tree, '保存改动（1）'), '应提示 1 项改动待保存')
	click(tree, '保存改动（1）')
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))

	assert.equal(calls.mutate.length, 1, '应发出 1 次 mutate')
	assert.equal(calls.mutate[0].ns, 'include:coding-mode-settings', '只写自己的 ns')
	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['flashModel'], value: 'my-model' }])
	assert.equal(calls.mutate[0].revision, 5, '必须带上读到的 revision')
})

test('保存: 推理强度「（不设置）」写空串（unset 的语义是恢复默认，不是清空）', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 2, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered, calls } = setup({ namespaces: [ours] })
	let tree = await mount(registered)

	click(tree, '（不设置）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['flashReasoningEffort'], value: '' }])
})

test('保存: 关掉 planGate → 发送布尔 false（不是字符串）', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 9, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered, calls } = setup({ namespaces: [ours] })
	const tree = await mount(registered)

	click(tree, '已开启') // 第一个开关是 planGate
	const next = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(next, `保存改动（1）`)
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['planGate'], value: false }])
})

test('保存: revision 冲突 → 明确提示 + 重新读取（用户可重试），不是静默失败', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 4, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered, calls } = setup({
		namespaces: [ours],
		onMutate: () => ({
			ok: false,
			error: { code: 'gateway/conflict', message: 'settings namespace "x" changed since it was read (expected revision 4, now 6)' },
		}),
	})
	let tree = await mount(registered)
	type(tree, 'provider', 'other-provider')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))

	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	assert.ok(hasText(tree, 'revision 冲突'), '应明确说是 revision 冲突')
	assert.ok(hasText(tree, '再次保存'), '应告诉用户怎么办')
	assert.equal(calls.describe, 2, '冲突后必须重新读取 describe')
})

test('保存: 没有改动时按钮禁用且不发请求', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered, calls } = setup({ namespaces: [ours] })
	const tree = await mount(registered)
	assert.ok(buttons(tree).some((entry) => entry.label === '没有改动'))
	assert.equal(calls.mutate.length, 0)
})

test('保存: profile 不可写时保存按钮禁用', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const { registered } = setup({ namespaces: [ours], writable: false })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '当前 profile 不可写'))
})

/* ══════════════════ 健壮性 ══════════════════ */

test('健壮性: describe 返回垃圾（null / 空对象）也不抛', async () => {
	const { registered } = setup({ namespaces: null })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '没有找到本插件的配置命名空间'))
})

test('健壮性: 候选列表能从别的 ns 的现值里动态采集', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const neighbour = {
		ns: 'include:agent-default-model',
		revision: 1,
		autoGenerate: true,
		applies: 'live',
		secrets: [],
		schema: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } },
		value: { provider: 'harvested-provider', model: 'harvested-model' },
	}
	const { registered } = setup({ namespaces: [ours, neighbour] })
	const tree = await mount(registered)
	const labels = buttons(tree).map((entry) => entry.label)
	assert.ok(labels.includes('harvested-provider'), `provider 候选应动态采集到，实际：${labels.join(' | ')}`)
	assert.ok(labels.includes('harvested-model'), 'model 候选应动态采集到')
})

test('健壮性: schema 里有 enum 时优先当候选', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 1, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS } }
	const withEnum = {
		ns: 'include:some-llm-plugin',
		revision: 1,
		autoGenerate: true,
		applies: 'live',
		secrets: [],
		schema: { type: 'object', properties: { provider: { type: 'string', enum: ['enum-provider'] } } },
		value: {},
	}
	const { registered } = setup({ namespaces: [ours, withEnum] })
	const tree = await mount(registered)
	assert.ok(buttons(tree).some((entry) => entry.label === 'enum-provider'))
})

test('健壮性: 渲染出的页面文案里能看到当前生效值与 ns/revision', async () => {
	const ours = { ns: 'include:coding-mode-settings', revision: 11, autoGenerate: false, applies: 'live', secrets: [], schema: {}, value: { ...OURS, proModel: 'pro-x' } }
	const { registered } = setup({ namespaces: [ours] })
	const tree = await mount(registered)
	const text = textOf(tree)
	assert.ok(text.includes('pro-x'), '应显示 pro 档当前生效模型')
	assert.ok(text.includes('当前生效：'), '应显示「当前生效」标注')
	assert.ok(text.includes('11'), '应显示 revision')
})

/* ══════════════════ 新增：4 个开关（阶段指引 / 任务回显 / 近场引导 / 子代理自动分档） ══════════════════ */

test('新开关: 4 个行为开关都渲染出来，且默认（value 里没有这些字段）按「开」处理', async () => {
	// 关键回归点：老 profile 补丁里只有 8 个字段，新字段靠 schema default 生效、
	// 不出现在 value 里。这时页面必须仍然识别成功，并把默认开的开关显示为「已开启」。
	const { registered } = setup({ namespaces: [oursNs({ ...OURS })] })
	const tree = await mount(registered)

	for (const title of ['阶段指引（stageGuide）', '任务回显（taskEcho）', '近场引导（nearFieldGuide）', '子代理自动分档（tierSubagents）']) {
		assert.ok(hasText(tree, title), `应渲染开关「${title}」`)
	}
	assert.ok(hasText(tree, '提示与路由开关'), '应有分组标题')
	// 默认开的开关：planGate / loopGuard / stageGuide / taskEcho / nearFieldGuide /
	// tierSubagents / protocolSection = 7 个「已开启」
	const switches = buttons(tree).filter((entry) => entry.label === '已开启')
	assert.equal(switches.length, 7, `应有 7 个开关处于开启，实际 ${switches.length}`)
})

test('新开关: 默认「关」的实验开关在字段缺失时显示「已关闭」（绝不被动进实验组）', async () => {
	// 这是 D/C/B 三项最重要的客户端回归点：
	// 老 profile 里没有 statsFooter / stageRestrict / flowGate，Host 半侧按 false 走。
	// 若页面用「!== false」求值，就会把缺失显示成「已开启」——
	// 用户以为自己开了实验开关，而宿主其实没开，这是最难查的一类不一致。
	const { registered } = setup({ namespaces: [oursNs({ ...OURS })] })
	const tree = await mount(registered)

	assert.ok(hasText(tree, '统计摘要（statsFooter）'), '应渲染统计摘要开关')
	assert.ok(hasText(tree, '阶段硬门控（stageRestrict）'), '应渲染阶段硬门控开关')
	assert.ok(hasText(tree, '硬流程门（flowGate）'), '应渲染硬流程门开关')
	assert.ok(hasText(tree, '实验与门控（默认关闭）'), '应有实验分组标题')

	const off = buttons(tree).filter((entry) => entry.label === '已关闭')
	assert.equal(off.length, 3, `默认关的三个开关应显示已关闭，实际 ${off.length}`)
})

test('新开关: 实验开关显式 true → 显示「已开启」；显式 false → 「已关闭」', async () => {
	const on = await mount(setup({ namespaces: [oursNs({ ...OURS_FULL, statsFooter: true, stageRestrict: true, flowGate: true })] }).registered)
	assert.equal(buttons(on).filter((entry) => entry.label === '已关闭').length, 0, '三个都开 → 不应有已关闭')

	const off = await mount(setup({ namespaces: [oursNs({ ...OURS_FULL })] }).registered)
	assert.equal(buttons(off).filter((entry) => entry.label === '已关闭').length, 3, '三个都关 → 恰好三个已关闭')
})

test('B: flowGate 缺字段时与显式 false 渲染一致（老 profile 绝不被动进硬门）', async () => {
	// flowGate 是**会拒绝工具调用**的硬门，缺字段时显示成"已开启"是最坏的一种误导。
	// 判据：18 项里只把 flowGate 删掉，页面其余部分必须与"显式 false"完全一致。
	const missingValue = { ...OURS_FULL }
	delete missingValue.flowGate
	const missing = await mount(setup({ namespaces: [oursNs(missingValue)] }).registered)
	assert.ok(hasText(missing, '硬流程门（flowGate）'), '应渲染硬流程门开关')
	assert.equal(
		buttons(missing).filter((entry) => entry.label === '已关闭').length,
		3,
		'缺字段 → 与 statsFooter / stageRestrict 一样显示已关闭（老 profile 不被动进硬门）',
	)

	const explicit = await mount(setup({ namespaces: [oursNs({ ...OURS_FULL, flowGate: true })] }).registered)
	assert.equal(
		buttons(explicit).filter((entry) => entry.label === '已关闭').length,
		2,
		'显式 true → 只剩另外两个默认关的还是关闭',
	)
})

test('C: effortPolicy 选择器有两项，缺字段时显示「模型自选」而不是空白', async () => {
	const { registered } = setup({ namespaces: [oursNs({ ...OURS })] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '推理强度策略（effortPolicy）'), '应渲染推理强度策略选择器')
	// 缺字段时 `asText(undefined)` 是空串 —— 必须靠 TEXT_FIELD_FALLBACK 显示真实生效值
	assert.ok(hasText(tree, '模型自选（按任务难度）'), '应显示 auto 选项')
	assert.ok(hasText(tree, '固定值（用上面的推理强度）'), '应显示 fixed 选项')
})

test('C: 点「固定值」→ mutate 收到 effortPolicy=fixed（字符串，不是布尔）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 9)] })
	let tree = await mount(registered)

	click(tree, '固定值（用上面的推理强度）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['effortPolicy'], value: 'fixed' }])
})

test('B: 打开硬流程门 → mutate 收到布尔 true（默认关的那一项）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 8)] })
	let tree = await mount(registered)

	assert.ok(hasText(tree, '硬流程门（flowGate）'), '应渲染硬流程门开关')
	clickToggle(tree, '硬流程门（flowGate）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['flowGate'], value: true }])
})

test('新开关: value 里显式给了 false → 对应开关显示「已关闭」', async () => {
	const value = {
		...OURS_FULL,
		planGate: false,
		loopGuard: false,
		stageGuide: false,
		taskEcho: false,
		nearFieldGuide: false,
		tierSubagents: false,
		protocolSection: false,
	}
	const { registered } = setup({ namespaces: [oursNs(value)] })
	const tree = await mount(registered)
	// 7 个默认开的全给 false + 3 个默认关的本来就是 false = 10 个已关闭
	const off = buttons(tree).filter((entry) => entry.label === '已关闭')
	assert.equal(off.length, 10, `10 个开关都应显示已关闭，实际 ${off.length}`)
	assert.ok(!hasText(tree, '已开启'), '不应残留「已开启」')
})

test('新开关: 关掉 4 个新开关 → mutate 收到 4 个布尔 false（顺序＝字段顺序）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 9)] })
	let tree = await mount(registered)

	// 逐个关掉（按行标题定位，避免 4 个「已开启」分不清谁是谁）
	for (const title of ['阶段指引（stageGuide）', '任务回显（taskEcho）', '近场引导（nearFieldGuide）', '子代理自动分档（tierSubagents）']) {
		clickToggle(tree, title)
		tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	}

	assert.ok(hasText(tree, '保存改动（4）'), '应提示 4 项改动')
	click(tree, '保存改动（4）')
	await pump()

	assert.equal(calls.mutate.length, 1)
	assert.equal(calls.mutate[0].ns, 'include:coding-mode-settings')
	assert.equal(calls.mutate[0].revision, 9)
	assert.deepEqual(calls.mutate[0].ops, [
		{ op: 'set', path: ['stageGuide'], value: false },
		{ op: 'set', path: ['taskEcho'], value: false },
		{ op: 'set', path: ['nearFieldGuide'], value: false },
		{ op: 'set', path: ['tierSubagents'], value: false },
	])
})

test('新开关: 从 false 打开 → mutate 收到布尔 true', async () => {
	const value = { ...OURS_FULL, stageGuide: false, taskEcho: false, nearFieldGuide: false, tierSubagents: false }
	const { registered, calls } = setup({ namespaces: [oursNs(value, 2)] })
	let tree = await mount(registered)

	for (const title of ['阶段指引（stageGuide）', '任务回显（taskEcho）', '近场引导（nearFieldGuide）', '子代理自动分档（tierSubagents）']) {
		clickToggle(tree, title)
		tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	}
	click(tree, '保存改动（4）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [
		{ op: 'set', path: ['stageGuide'], value: true },
		{ op: 'set', path: ['taskEcho'], value: true },
		{ op: 'set', path: ['nearFieldGuide'], value: true },
		{ op: 'set', path: ['tierSubagents'], value: true },
	])
})

test('新开关: 18 个字段齐全且都不改动 → 没有假改动，保存按钮保持禁用', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL })] })
	const tree = await mount(registered)
	assert.ok(buttons(tree).some((entry) => entry.label === '没有改动'), '字段齐全但没改 → 应显示「没有改动」')
	assert.equal(calls.mutate.length, 0)
})

test('新开关: 老值里只给 8 个字段 → 识别仍成功（身份字段只有 8 个）', async () => {
	const { registered } = setup({ namespaces: [FOREIGN, oursNs({ ...OURS })] })
	const tree = await mount(registered)
	assert.ok(hasText(tree, 'include:coding-mode-settings'), '只有 8 个字段的老 ns 也必须能被识别')
	assert.ok(hasText(tree, '阶段指引（stageGuide）'), '并且能渲染新开关')
})

/* ══════════════════ 新增：统计面板（可读 / 不可读 两种情形都不崩） ══════════════════ */

/** 一份形状正确的统计快照。 */
const STATS_OK = {
	protocolRendered: 12,
	classified: { build: 5, fix: 4, explore: 2, ambiguous: 1 },
	personaInjected: 7,
	guideInjected: 9,
	taskEchoed: 6,
	gateDenials: 3,
	gateAllows: 11,
	stageAdvances: 8,
	deliveryBlocked: 4,
	deliveryGiveUp: 1,
	flowBlocked: 2,
	stageBySession: { 'session-abc': 2 },
	tierRouted: { flash: 10, pro: 3 },
	startedAt: 1731000000000,
}

/**
 * 把页面里的统计格子折成「标签 → 值」的表。
 * 统计格子结构固定：.dshcm_stat > .dshcm_statKey + .dshcm_statValue。
 */
function statCells(tree) {
	const map = new Map()
	walk(tree, (node) => {
		if (node.type !== 'div' || node.props.className !== 'dshcm_stat') return
		const keyNode = find(node, (child) => child.type === 'div' && child.props.className === 'dshcm_statKey')
		const valueNode = find(node, (child) => child.type === 'div' && child.props.className === 'dshcm_statValue')
		if (keyNode === null || valueNode === null) return
		map.set(textOf(keyNode).trim(), textOf(valueNode).trim())
	})
	return map
}

test('统计: 宿主没暴露统计服务（本机真实情形）→ 明确说不可读，字段仍在，不崩', async () => {
	// 这就是本机实测的真实情形：ctx.remote 上没有任何提供 stats() 的命名空间。
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL })] })
	const tree = await mount(registered)

	assert.ok(hasText(tree, '运行统计（可观测性）'), '应有统计面板')
	assert.ok(hasText(tree, '统计需要宿主侧暴露，当前不可读'), '应如实说明不可读，而不是留空或画 0')
	assert.ok(hasText(tree, '本次进程内统计，重启归零'), '应标注进程内统计、重启归零')
	assert.equal(calls.stats, 0, '没有宿主统计服务时不应发出任何统计调用')

	// 字段名与形状仍然完整列出（只是没有值）
	const cells = statCells(tree)
	for (const label of ['协议段渲染', 'persona 注入', '引导注入', '任务回显', '门禁拒绝', '门禁放行', '阶段推进', 'build', 'fix', 'explore', 'ambiguous', 'flash', 'pro']) {
		assert.ok(cells.has(label), `应列出字段「${label}」`)
		assert.equal(cells.get(label), '—', `不可读时「${label}」应显示 —（不能画成 0）`)
	}
	assert.ok(buttons(tree).some((entry) => entry.label === '重新读取统计'), '应提供重新读取按钮')
})

test('统计: 宿主暴露了统计服务 → 显示真实数字，而不是占位符', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: STATS_OK })
	const tree = await mount(registered)

	assert.equal(calls.stats, 1, '应读一次统计')
	assert.ok(hasText(tree, '本次进程内统计，重启归零'))
	assert.ok(!hasText(tree, '统计需要宿主侧暴露，当前不可读'), '读到了就不该再说不可读')

	const cells = statCells(tree)
	assert.equal(cells.get('协议段渲染'), '12')
	assert.equal(cells.get('门禁拒绝'), '3')
	assert.equal(cells.get('门禁放行'), '11')
	assert.equal(cells.get('阶段推进'), '8')
	assert.equal(cells.get('build'), '5')
	assert.equal(cells.get('ambiguous'), '1')
	assert.equal(cells.get('flash'), '10')
	assert.equal(cells.get('pro'), '3')
	assert.ok(hasText(tree, 'session-abc → 2'), '应列出会话阶段')
	assert.ok(hasText(tree, '本进程起始时间：'), '应显示进程起始时间')
})

test('统计: stats() 返回形状不对（例如空对象）→ 归为不可读，绝不把垃圾当数字', async () => {
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: {} })
	const tree = await mount(registered)

	assert.ok(hasText(tree, '统计需要宿主侧暴露，当前不可读'))
	assert.ok(hasText(tree, '形状校验不通过'), '应说明是形状不对，便于排查')
	assert.equal(statCells(tree).get('协议段渲染'), '—')
})

test('统计: stats() 直接抛错 → 面板不崩，如实报错', async () => {
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL })], statsThrows: true })
	const tree = await mount(registered)

	assert.ok(hasText(tree, '统计需要宿主侧暴露，当前不可读'))
	assert.ok(hasText(tree, '宿主统计读取爆炸'), '应把底层错误透出来')
	assert.equal(statCells(tree).get('门禁拒绝'), '—')
})

test('统计: describe 失败时页面照样不崩（统计面板不在这一分支）', async () => {
	const { registered } = setup({ namespaces: [], describeFails: true, stats: STATS_OK })
	const tree = await mount(registered)
	assert.ok(hasText(tree, '读取配置失败'))
	assert.ok(!hasText(tree, '运行统计（可观测性）'), '配置读不到时不渲染统计区（没有配置上下文）')
})

test('统计: 重新读取按钮可用，点完再读一次且不崩', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: STATS_OK })
	let tree = await mount(registered)
	assert.equal(calls.stats, 1)

	click(tree, '重新读取统计')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	assert.equal(calls.stats, 2, '点一次应再读一次')
	assert.equal(statCells(tree).get('协议段渲染'), '12')
})

test('统计: 面板不会把统计值当成配置写回去（mutate 一次都不发）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: STATS_OK })
	await mount(registered)
	assert.equal(calls.mutate.length, 0, '只读展示，绝不写配置')
	assert.ok(buttons(await mount(registered)).some((entry) => entry.label === '没有改动'))
})

/* ══════════════════ 新增：D / C / B 三项的新控件与保存通路 ══════════════════ */

/** 取某个互斥选项组里处于「选中」状态的 chip 文案（ChoiceRow 用 data-active 标记）。 */
function activeChips(tree, label) {
	const group = find(tree, (node) => node.type === 'div' && node.props['aria-label'] === label)
	if (group === null) return []
	return buttons(group)
		.filter((entry) => entry.node.props['data-active'] === 'true')
		.map((entry) => entry.label)
}

test('D: tierPolicy 选择器有三项，且正确标注当前生效值', async () => {
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL, tierPolicy: 'pro' })] })
	const tree = await mount(registered)

	assert.ok(hasText(tree, '子代理分档策略（tierPolicy）'), '应渲染档位策略选择器')
	for (const label of ['自动（按复杂度）', '强制 flash', '强制 pro']) {
		assert.ok(hasText(tree, label), `应有选项「${label}」`)
	}
	assert.deepEqual(activeChips(tree, '子代理分档策略（tierPolicy）'), ['强制 pro'], '当前值 pro 必须被标为选中')
})

test('D: value 里没有 tierPolicy（老 profile）→ 选择器显示「自动」而不是空白', async () => {
	// 关键：schema default 是 auto，但缺字段时 asText 会给空串。
	// 页面必须显示真实的默认值，否则用户看到一个没有任何选中的选择器，不知道当前是哪一档。
	const { registered } = setup({ namespaces: [oursNs({ ...OURS })] })
	const tree = await mount(registered)
	assert.deepEqual(activeChips(tree, '子代理分档策略（tierPolicy）'), ['自动（按复杂度）'])
})

test('D: 点「强制 pro」→ mutate 收到 tierPolicy=pro（字符串，不是布尔）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 3)] })
	let tree = await mount(registered)

	click(tree, '强制 pro')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))

	assert.ok(hasText(tree, '保存改动（1）'), '应提示 1 项改动')
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['tierPolicy'], value: 'pro' }])
	assert.equal(calls.mutate[0].revision, 3)
})

test('D: 点「强制 flash」→ mutate 收到 tierPolicy=flash', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 4)] })
	let tree = await mount(registered)

	click(tree, '强制 flash')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['tierPolicy'], value: 'flash' }])
})

test('D: 关掉协议段总开关 → mutate 收到布尔 false', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 5)] })
	let tree = await mount(registered)

	assert.ok(hasText(tree, '协议段总开关（protocolSection）'), '应渲染协议段总开关')
	clickToggle(tree, '协议段总开关（protocolSection）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['protocolSection'], value: false }])
})

test('C: 打开统计摘要 → mutate 收到布尔 true（不是字符串）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 6)] })
	let tree = await mount(registered)

	clickToggle(tree, '统计摘要（statsFooter）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['statsFooter'], value: true }])
})

test('C: 从已开启关掉统计摘要 → mutate 收到布尔 false', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL, statsFooter: true }, 7)] })
	let tree = await mount(registered)

	clickToggle(tree, '统计摘要（statsFooter）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['statsFooter'], value: false }])
})

test('B: 打开阶段硬门控 → mutate 收到布尔 true（默认关的那一项）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 8)] })
	let tree = await mount(registered)

	assert.ok(hasText(tree, '阶段硬门控（stageRestrict）'), '应渲染阶段硬门控开关')
	clickToggle(tree, '阶段硬门控（stageRestrict）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '保存改动（1）')
	await pump()

	assert.deepEqual(calls.mutate[0].ops, [{ op: 'set', path: ['stageRestrict'], value: true }])
})

test('新字段: ops 顺序＝字段顺序（新字段排在旧字段之后）', async () => {
	const { registered, calls } = setup({ namespaces: [oursNs({ ...OURS_FULL }, 9)] })
	let tree = await mount(registered)

	// 一个旧的（protocolSection 之前的）+ 五个新的，验证相对顺序
	clickToggle(tree, '子代理自动分档（tierSubagents）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	clickToggle(tree, '协议段总开关（protocolSection）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	clickToggle(tree, '统计摘要（statsFooter）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	clickToggle(tree, '阶段硬门控（stageRestrict）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	clickToggle(tree, '硬流程门（flowGate）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))
	click(tree, '固定值（用上面的推理强度）')
	tree = await settle(() => miniReactShim.createElement(registered.component, registered.options.inject()))

	click(tree, '保存改动（6）')
	await pump()

	assert.deepEqual(
		calls.mutate[0].ops.map((op) => op.path[0]),
		['tierSubagents', 'protocolSection', 'statsFooter', 'stageRestrict', 'flowGate', 'effortPolicy'],
		'ops 必须按 FIELDS 顺序发出（两个新字段排在最后）',
	)
})

test('统计: 两个新增的交付门计数会显示在面板上', async () => {
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: STATS_OK })
	const tree = await mount(registered)
	const cells = statCells(tree)
	assert.equal(cells.get('交付门驳回'), '4', '应显示交付门驳回次数')
	assert.equal(cells.get('交付门放弃'), '1', '应显示交付门放弃次数')
})

test('统计: 硬流程门的驳回计数会显示在面板上（与交付门分开两格）', async () => {
	// 两道门的目标不同（"没计划就收尾" vs "没验证就交付"），必须分开显示，
	// 否则混在一格就看不出是哪一道门在起作用。
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: { ...STATS_OK, flowBlocked: 6 } })
	const tree = await mount(registered)
	const cells = statCells(tree)
	assert.equal(cells.get('流程门驳回'), '6', '应显示硬流程门驳回次数')
	assert.equal(cells.get('交付门驳回'), '4', '交付门计数不受影响')
})

test('统计: 老宿主快照缺 flowBlocked → 显示「—」而不是空格子', async () => {
	const legacy = { ...STATS_OK }
	delete legacy.flowBlocked
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: legacy })
	const tree = await mount(registered)
	assert.equal(statCells(tree).get('流程门驳回'), '—')
})

test('统计: 老宿主快照缺新计数 → 显示「—」而不是空格子', async () => {
	// 可观测性上「空」与「0」完全不是一回事：空格子会让人以为插件没在工作。
	const legacy = { ...STATS_OK }
	delete legacy.deliveryBlocked
	delete legacy.deliveryGiveUp
	const { registered } = setup({ namespaces: [oursNs({ ...OURS_FULL })], stats: legacy })
	const tree = await mount(registered)
	const cells = statCells(tree)
	assert.equal(cells.get('交付门驳回'), '—')
	assert.equal(cells.get('交付门放弃'), '—')
})
