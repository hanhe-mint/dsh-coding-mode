/**
 * mini-react.mjs — 自检用的极小 React 替身 + 极简渲染器。
 *
 * 目的：client.js 是浏览器半侧、只能在 DSH 页面里跑，而本机没有活动页面可供
 * 客户端 inspect（实测 client 侧查询 10s 超时）。为了不靠"肉眼看代码"交付，
 * 这里做一个够用的替身：实现 client.js 真正用到的那一小撮 API
 * （createElement / Fragment / Component / useState / useEffect / useMemo /
 *  useCallback），再配一个能跑 hooks、能派发事件的极简渲染器，
 * 于是「describe → 识别 ns → 渲染 → 点按钮 → mutate」这条通路可以在 Node 里被真断言。
 *
 * 它**不是** React 的完整实现，不追求正确性，只追求足以暴露我们代码里的低级错误。
 */

/* ────────────────────────── React 替身 ────────────────────────── */

const Fragment = Symbol('mini-react.Fragment')

let currentInstance = null
let dirty = false
let position = 0

const instances = new Map()

function createElement(type, props, ...children) {
	position += 1
	const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
	return { __mini: 'element', type, props: { ...(props ?? {}), children: normalized } }
}

function depsChanged(previous, next) {
	if (previous === undefined || next === undefined) return true
	if (!Array.isArray(previous) || !Array.isArray(next)) return true
	if (previous.length !== next.length) return true
	return previous.some((value, index) => !Object.is(value, next[index]))
}

function useState(initial) {
	const instance = currentInstance
	const index = instance.cursor++
	if (instance.hooks.length <= index) {
		instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
	}
	const slot = instance.hooks[index]
	return [
		slot.value,
		(next) => {
			const value = typeof next === 'function' ? next(slot.value) : next
			if (Object.is(value, slot.value)) return
			slot.value = value
			dirty = true
		},
	]
}

function useMemo(factory, deps) {
	const instance = currentInstance
	const index = instance.cursor++
	let slot = instance.hooks[index]
	if (slot === undefined || depsChanged(slot.deps, deps)) {
		slot = instance.hooks[index] = { value: factory(), deps: deps === undefined ? undefined : [...deps] }
	}
	return slot.value
}

function useCallback(callback, deps) {
	return useMemo(() => callback, deps)
}

function useEffect(effect, deps) {
	const instance = currentInstance
	const index = instance.cursor++
	let slot = instance.hooks[index]
	const changed = slot === undefined || depsChanged(slot.deps, deps)
	instance.hooks[index] = {
		deps: deps === undefined ? undefined : [...deps],
		effect,
		pending: changed ? effect : undefined,
		cleanup: slot?.cleanup,
	}
	if (changed) instance.pendingEffects.push(instance.hooks[index])
}

function useRef(initial) {
	const instance = currentInstance
	const index = instance.cursor++
	if (instance.hooks[index] === undefined) instance.hooks[index] = { value: { current: initial } }
	return instance.hooks[index].value
}

class Component {
	constructor(props) {
		this.props = props
		this.state = {}
	}
	setState(patch) {
		this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
		dirty = true
	}
}

const miniReact = {
	createElement,
	Fragment,
	Component,
	useState,
	useEffect,
	useMemo,
	useCallback,
	useRef,
}

/* ────────────────────────── 极简渲染器 ────────────────────────── */

function reset() {
	instances.clear()
	dirty = false
}

/** 把 children 折成数组。 */
function toArray(children) {
	if (children === undefined || children === null) return []
	return Array.isArray(children) ? children : [children]
}

/**
 * 渲染一个节点，得到一棵「宿主树」：{ type, props, children, text }。
 * 函数组件与类组件会被展开；hooks 按「实例 + 出现位置」分配槽位。
 */
function render(node) {
	if (node === undefined || node === null || typeof node === 'boolean') return null
	if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), props: {}, children: [] }
	if (Array.isArray(node)) return { type: '#frag', props: {}, children: node.map(render).filter(Boolean) }
	if (node.__mini !== 'element') return null

	const { type, props } = node
	const key = props.key === undefined ? String(position++) : String(props.key)

	if (type === Fragment) {
		return { type: '#frag', props, children: toArray(props.children).map(render).filter(Boolean) }
	}

	if (typeof type === 'function') {
		const instanceKey = `${key}`
		const isClass = type.prototype && typeof type.prototype.render === 'function'
		let instance = instances.get(instanceKey)
		if (isClass) {
			if (instance === undefined) {
				instance = new type(props)
				instances.set(instanceKey, instance)
			}
			instance.props = props
			const previous = currentInstance
			currentInstance = null
			const output = instance.render()
			currentInstance = previous
			return render(output)
		}
		if (instance === undefined) {
			instance = { hooks: [], cursor: 0, pendingEffects: [] }
			instances.set(instanceKey, instance)
		}
		instance.cursor = 0
		const previous = currentInstance
		currentInstance = instance
		let output
		try {
			output = type(props)
		} finally {
			currentInstance = previous
		}
		return render(output)
	}

	return {
		type,
		props,
		children: toArray(props.children).map(render).filter(Boolean),
	}
}

/** 收集并运行待执行的 effect（useEffect 的第一次/依赖变化）。 */
function flushEffects() {
	let ran = 0
	for (const instance of instances.values()) {
		const pending = instance.pendingEffects
		if (pending === undefined || pending.length === 0) continue
		instance.pendingEffects = []
		for (const slot of pending) {
			if (typeof slot.cleanup === 'function') slot.cleanup()
			const cleanup = slot.effect()
			slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
			ran += 1
		}
	}
	return ran
}

/** 让出一次事件循环，好让 await 之后的 setState 有机会生效。 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 反复「渲染 → 跑 effect → 让出」直到稳定。
 * @param factory 每次返回根元素的函数
 * @param rounds 最大轮次
 */
async function settle(factory, rounds = 40) {
	let tree = null
	for (let index = 0; index < rounds; index += 1) {
		dirty = false
		position = 0
		tree = render(factory())
		const ran = flushEffects()
		if (!dirty && ran === 0) {
			// 没有任何变化，也没有新 effect → 再渲染一次拿最终树并停
			position = 0
			tree = render(factory())
			if (!dirty && flushEffects() === 0) return tree
		}
		await tick()
	}
	return tree
}

/* ────────────────────────── 查询/交互 helpers ────────────────────────── */

function walk(node, visit) {
	if (node === null) return
	visit(node)
	for (const child of node.children ?? []) walk(child, visit)
}

/** 树里所有元素的文字（用于断言页面文案）。 */
function textOf(tree) {
	const parts = []
	walk(tree, (node) => {
		if (node.type === '#text') parts.push(node.text)
	})
	return parts.join(' ')
}

/** 按条件找第一个元素。 */
function find(tree, predicate) {
	let found = null
	walk(tree, (node) => {
		if (found === null && predicate(node)) found = node
	})
	return found
}

/** 找所有按钮，返回 { label, node } 列表。 */
function buttons(tree) {
	const list = []
	walk(tree, (node) => {
		if (node.type === 'button') list.push({ label: textOf(node), node })
	})
	return list
}

/** 点击文案匹配的按钮；找不到就抛（测试要立刻失败，而不是静默跳过）。 */
function click(tree, label) {
	const target = buttons(tree).find((entry) => entry.label === label)
	if (target === undefined) {
		throw new Error(`找不到按钮「${label}」；现有按钮：${buttons(tree).map((entry) => entry.label).join(' | ')}`)
	}
	target.node.props.onClick()
}

/** 往输入框里打字。 */
function type(tree, ariaLabel, value) {
	const input = find(tree, (node) => node.type === 'input' && node.props['aria-label'] === ariaLabel)
	if (input === null) throw new Error(`找不到输入框「${ariaLabel}」`)
	input.props.onChange({ currentTarget: { value } })
}

/** 找一个元素的宿主树节点（按 className + 文字）。 */
function hasText(tree, needle) {
	return textOf(tree).includes(needle)
}

export {
	Component,
	Fragment,
	buttons,
	click,
	createElement,
	find,
	hasText,
	reset,
	settle,
	textOf,
	type,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	walk,
}
