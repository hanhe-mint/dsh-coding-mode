/**
 * register.mjs — 注册上面的解析钩子。
 * 用法：node --import ./register.mjs --test smoke.test.mjs
 */
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
