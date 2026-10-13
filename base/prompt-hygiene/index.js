/**
 * dsh-prompt-hygiene —— 提示词卫生（省 token 通用规则）Host 半侧。
 *
 * 做什么：在系统提示词里注册一段**与模式无关的省 token 规则**，order = 3200。
 *
 * ── 为什么是**顶层注册**而不是编进编程模式 ──────────────────────────────
 * 这些规则（不要灌全量输出、大读取交子代理、bash 输出截断、换任务开新会话）
 * 对**任何**模式都成立：QA 模式也在烧 token，Teams 模式也在跑子代理。
 * 顶层注册落在提示段的 `ScopedLayers.global` 全局层，被每个 agent 的装配继承，
 * 所以所有 preset（含子代理）都拿得到。写进 preset 半侧就只有编程模式有了。
 *
 * （判据与 `@local/dsh-language-guard` 同源：它注释里记了反例 —— 语言指令
 *   曾经写在编程模式的 preset 半侧，结果换 standard preset 就没有中文指令。）
 *
 * ── 为什么单独一个包，而不是并进语言闸 ──────────────────────────────────
 * 语言闸的职责是"输出语言"，本包是"上下文卫生"，两者失效场景与排查路径都不同；
 * 分开还能在「包含的组件」里**独立开关**，用户可只留一个。
 *
 * ── 为什么 order 取 -890 ────────────────────────────────────────────────
 * 取官方 order 表（`@deepseek-ai/dsh-system-prompt` 的 SECTION_ORDERS）的**负值区**，
 * 紧跟语言闸（-900）之后：
 *
 *     HARNESS_IDENTITY       -1000   身份句
 *     语言闸                  -900   「始终用简体中文」
 *     本段                    -890   ← 这里
 *     DEPLOYMENT_PERSONA_PREFIX  0
 *     PLAN_POLICY            500   …后面全是工具说明（1000~3000）与 SDK 段
 *
 * 为什么放负值区而不是夹在工具段里（我初版取 3200，是错的取向）：
 *   本段讲的是"**不要**怎么做"这类**系统级约束**，读者（模型）应当把它当成
 *   与身份句同级的规则，而不是"某个工具附带的说明"。放前面合规性更稳。
 *
 * ⚠️ 与缓存无关：前缀缓存命中的是**最长匹配前缀**，只要本段文本每次请求都相同
 *    （它是静态常量），排在哪个位置都照样命中。位置只影响模型注意力。
 *
 * ⚠️ -900 被语言闸占了，同值会撞"同名/同序"冲突，所以取 -890 紧邻它。
 *
 * @module dsh-prompt-hygiene
 */

/** 提示段名。DSH 对同名段会抛 "already registered"，所以必须唯一且稳定。 */
const SECTION_NAME = 'prompt-hygiene:token-rules'

/** 段顺序。见文件头说明。 */
const SECTION_ORDER = -890

/** 默认正文（用户可在设置页覆盖）。刻意极简：每多一行都是每个请求的固定成本。 */
const DEFAULT_TEXT = `### 上下文卫生（省 token，与模式无关）

- **不要往上下文里灌全量输出**（完整列表、完整 schema、整份配置文件）。大读取交给子代理做 —— 子代理上下文独立，主会话只收结论。
- **命令输出一律截断**：用 \`| head\` / \`| tail\`，不要让它整段进上下文。
- **换任务就开新会话**；长会话别挂着长时间不动（超过缓存 TTL 后回来是一次全量未命中）。
- 上下文越小，缓存未命中的代价越低；已读过的内容不要重复读。`

/**
 * 段文本的解析：配置里的 `text` 优先，为空则用默认。
 * @param {any} config
 * @returns {string}
 */
function resolveText(config) {
  const t = config && typeof config.text === 'string' ? config.text.trim() : ''
  const enabled = config?.enabled === false ? false : true
  return enabled ? (t.length > 0 ? t : DEFAULT_TEXT) : ''
}

/**
 * 插件入口。
 *
 * @param {any} ctx 插件上下文（顶层行 → 注册进全局层）
 * @param {any} config 该行配置
 */
export function apply(ctx, config) {
  // 用 `ctx.effect` 包一层：注册的 disposer 归本插件所有，卸载/热重载时自动注销。
  // 不包的话热重载会撞"同名段已注册"直接抛错。
  const register = () => {
    if (typeof ctx?.systemPrompt?.section !== 'function') return () => {}
    return ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      // `text` 用**函数**形式：每次装配求值 → 设置页改完配置下一个请求立即生效。
      text: () => resolveText(config),
      // 关掉 `{{变量}}` 插值：用户可自由编辑这段文本，而 DSH 默认插值遇到未知变量
      // 会**直接抛错**，一旦用户粘贴含 `{{` 的内容（代码/模板），之后每次装配都抛、
      // 整个会话报废。本段不需要任何变量，所以原样送出。
      interpolate: false,
    })
  }
  if (typeof ctx?.effect === 'function') ctx.effect(register, 'dsh-prompt-hygiene: section')
  else register()
}

export const name = 'prompt-hygiene'

/** 依赖 `systemPrompt` 服务；DSH 只在服务可用后调用 apply。 */
export const inject = ['systemPrompt']
