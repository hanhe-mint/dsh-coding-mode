/**
 * stub-schemastery.mjs — 测试用的最小 schemastery 替身。
 * 只实现本插件用到的链式 API：object / string / boolean / number + .default() + .volatile()。
 * 目的是让 index.js 能在 DSH 之外被真实 import 并执行 apply()。
 */
class Node {
  constructor(type, def, meta = {}) {
    this.type = type
    this.def = def
    this.meta = meta
  }
  default(v) {
    return new Node(this.type, v, this.meta)
  }
  volatile() {
    return new Node(this.type, this.def, { ...this.meta, volatile: true })
  }
}

export default {
  object: (shape) => new Node('object', shape),
  string: () => new Node('string', undefined),
  boolean: () => new Node('boolean', undefined),
  number: () => new Node('number', undefined),
}
