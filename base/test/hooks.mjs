/**
 * hooks.mjs — Node 模块解析钩子：把 '@deepseek-ai/schemastery' 映射到本地替身，
 * 这样插件的 index.js 可以在 DSH 之外被真实 import。
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./stub-schemastery.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
