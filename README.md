# dsh-coding-mode · 编程模式

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的**编码专用工作流模式**。

它把「怎么把编码任务做对」这件事固化成一套**注入到系统提示词的协议**，
并把全部旋钮交给用户在设置页调 —— 不做长期记忆，不做黑盒。

> 本仓库含**两个版本**，装哪个都行。区别见下面「两个版本的区别」。
> 零运行时依赖（推荐版会多一个 `dsh-ops`，见下）。全部中文输出。

---

## 它解决什么问题

编码 agent 有四类常见失效，协议针对性地各治一种：

| 失效 | 表现 | 协议对策 |
|---|---|---|
| **反刍** | 想得太久、反复怀疑自己、绕圈 | 思考纪律 + 按推理强度**裁剪流程** |
| **深度不匹配** | 简单任务用牛刀，复杂任务敷衍 | 首轮任务分类 + 人格按任务形态注入 |
| **只走一条思路** | 方案上限不够高 | 1·发散（多角度各起一稿再比较取舍） |
| **声称完成但没证据** | "改好了"但文件没动、命令没跑过 | 交付门（**有牙齿**，无证据直接驳回） |

---

## 主要功能

1. **首轮分类与人格** —— 首条消息判成 build / fix / explore / ambiguous，据此选人格
2. **中文协作协议**（注入系统提示词，可整体开关）：
   `思考纪律 → 0 对齐 → 1 发散 → 2 计划锁定 → 3 执行 → 4 验证 → 5 收敛 → 工程卫生`
3. **计划门禁**（真拦截）—— 计划模式下 `write` / `edit` 被**直接拒绝**，不是提醒
4. **交付门**（有牙齿）—— 刚写完文件还没验证就声称完成 → 驳回并拽回本轮
5. **按推理强度裁剪流程** —— 主会话强度自动决定协议裁到哪一步（见下）
6. **子代理分档** —— flash / pro 两档路由；两档模型在设置页配，**不写死厂商**
7. **档位映射可自配** —— 换 OpenAI / Claude / 自己的中转站时，按它**真实支持的档位**填即可
8. **20 个配置字段**，全部可在设置页编辑、即时生效

---

## 按推理强度裁剪流程

主会话的推理强度档位**自动决定协议裁剪到哪一步**。低强度下不派子代理去跑昂贵的审查：

| 档位 | 1 发散 | 跨验 | 红队 | 收敛 | 说明 |
|---|---|---|---|---|---|
| `low` | — | — | — | — | 只留基础章节 |
| `medium` | — | — | — | ✅ | 基础 + 收敛 |
| `high` | — | ✅ | ✅ | ✅ | 去掉发散，保留双重审查 |
| `xhigh` | ✅ | ✅ | ✅ | ✅ | 完整流程 |
| `ultra` | ✅ | ✅ | ✅ | ✅ | 完整流程 |

**基础章节（思考纪律 / 对齐 / 计划锁定 / 执行 / 自验）在任何档位都保留** —— 去掉它们会让
agent 退化成瞎猜、不问歧义、不用精确编辑、声称完成无证据。

设计依据：**ARES**（arXiv:2603.07915, ICML 2026）证明恒定低强度会掉 **20%** 准确率，
而**过度思考同样真实存在**（TAU-Airline 上高强度 38.0% 反而低于中强度 42.0%）。

### 子代理强度也跟随主档位

派子代理时给模型一个**推荐强度区间**（不是写死一个值 —— 区间内的活儿难度不同）：

| 主档位 | 子代理建议区间 | 起手 |
|---|---|---|
| `low` | `none` ~ `medium` | `low` |
| `medium` | `low` ~ `high` | `medium` |
| `high` | `medium` ~ `xhigh` | `high` |
| `xhigh` | `high` ~ `xhigh` | `high` |
| `ultra` | `xhigh` ~ `max` | `xhigh` |

**高档位也不顶格起手** —— 实测顶格会挤掉收敛（想得越久越容易反复怀疑自己）。
读不到档位时退回 `medium` 区间：**强度是真金白银，读不到就不该顶花**。

---

## 两个版本的区别

两个版本**共用同一份插件代码**，区别只在「包含的组件」多了哪些：

| | **基础版**<br>`base/` | **推荐版**<br>`recommended/` |
|---|---|---|
| **编程模式** | ✅ | ✅ |
| **提示词卫生**<br>（`dsh-prompt-hygiene`，本仓库自带） | ✅ | ✅ |
| **推理强度滑动条**<br>（`@local/dsh-effort-switcher`，本仓库内联） | — | ✅ |
| **bash / PowerShell 工具链**<br>（`dsh-ops`，需另装，见下） | — | ✅ |
| 外部依赖 | 无 | `dsh-ops` |

两个版本的组件都能在 **设置 → 插件 → 本插件 → 「包含的组件」** 里**逐个开关** ——
不想要的组件直接关掉，不用重装。

### 推荐版多出来的两样东西

#### ① 推理强度滑动条 —— `@local/dsh-effort-switcher`（已内联在 `recommended/vendor/`）

上游项目：**[lemonorangeapple/dsh-effort-switcher](https://github.com/lemonorangeapple/dsh-effort-switcher)**

它把模型/推理强度入口换成滑动条，**全局生效**（抢 `conversation.input.model` 席位并遮蔽
DSH 内置选择器），与当前处于什么模式无关。**本仓库对它做了 5 处修改**：

1. **适配 DSH 0.2.0** —— 上游取服务的方式在 0.2.0 上拿不到，改为官方
   `ui-model-selection` 的做法，并补齐 `exports.name` / `exports.inject`。
2. **补齐 `remote.session` 依赖** —— `modelDirectories.directoryFor()` 内部要访问
   `ctx.remote.session`，而经 `scope.get()` 拿到的服务是 Proxy、调用时 `this` 会被重绑回
   本插件上下文；不声明该依赖会抛 `cannot get property "remote.session" without inject`，
   被槽位错误边界"让位"，表现为**滑动条完全不出现**。
3. **末档显示名改为 `Ultra`** —— DSH 的档位显示名是机械生成的（`max` → "Max"），配置层改不了，
   所以只在**显示层**改写；提交时仍用 id `max`，再由渠道映射成线上值 `ultra`。
4. **面板改为不透明实色** —— 上游用 `--dsw-specific-menu`（深色下 `#43454a73`，仅 45% 不透明）
   且漏了配套的 `backdrop-filter`，菜单会透视、模型名看不清；改为官方 neutral-bluish-875
   （`#232324`）并加两级兜底。
5. **删掉两处英文描述**（模型列表的描述、档位描述）与配套的死 CSS 类。

#### ② bash / PowerShell 工具链 —— `dsh-ops`（**必须另外安装**）

上游项目：**[T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)**

> ### ⚠️ 推荐版**必须安装** `dsh-ops`，否则推荐版里那两个 shell 组件不会生效
>
> ```bash
> dsh plugin --profile desktop add dsh-ops
> ```
>
> **为什么不能随本仓库一起装**：`dsh-ops` 自带约 **600MB** 二进制载荷
> （bash 307M + PowerShell 7 245M + FastCtx 48M），无法内联进本仓库。
> 装完之后，`ops_bash` 等工具由它提供。

它提供独立的 **bash 5.3.15**（Git for Windows PortableGit）与 **PowerShell 7.6.6**，
以及一批 Rust 写的文件工具。**不依赖系统 PATH**，也不改系统默认终端。

**本仓库对它的补丁**（`recommended/patches/dsh-ops@0.2.9.patch`，pnpm 会按
`patchedDependencies` 自动重放）：从 `FILE_TOOLS` 里移除了 `inspect_local_file` 与 `glob`
—— 因为宿主已有同功能的 `read` / `glob`，留着只占模型注意力；保留 `ops_grep`
（有省 token 的 `count` / `summary` 模式）与 `ops_replace`（唯一能做跨文件批量替换的）。
详见 `recommended/patches/README.md`。

---

## 安装

### 基础版

```bash
git clone https://github.com/<你的用户名>/dsh-coding-mode.git
dsh plugin --profile desktop add ./dsh-coding-mode/base
```

### 推荐版

```bash
git clone https://github.com/<你的用户名>/dsh-coding-mode.git
# 推荐版依赖 dsh-ops，先装它（必需，见上）
dsh plugin --profile desktop add dsh-ops
dsh plugin --profile desktop add ./dsh-coding-mode/recommended
```

**装完必须完全重启 DSH**，再在设置页确认已启用。

---

## 配置

设置页位置：**设置 → 插件 → 编程模式**。20 个字段：

| 分类 | 字段 |
|---|---|
| **模型路由** | `flashProvider` `flashModel` `flashReasoningEffort` `proProvider` `proModel` `proReasoningEffort` |
| **子代理分档** | `tierSubagents` · `tierPolicy`（`auto`/`flash`/`pro`）· `effortPolicy`（`auto`/`fixed`） |
| **档位映射** | `flowByTier` · `effortByTier`（见下） |
| **流程开关** | `planGate` `loopGuard` `stageGuide` `taskEcho` `nearFieldGuide` `protocolSection` `stageRestrict` `flowGate` |
| **统计** | `statsFooter` |

### ⚠️ `flash` / `pro` 只是**名字**

它们**不绑定任何厂商** —— 指的是你在设置页填的那两个 `provider` + `model`。
把 `pro` 填成 Claude 的模型，派 pro 时就走 Claude；**两者填成同一个模型也能正常工作**。

### 换成别的渠道时怎么配档位

内置默认按 DeepSeek 的 5 档给的。用 OpenAI / Claude / 自己的中转站时，
**在 `flowByTier` 与 `effortByTier` 里按它真实支持的档位填** ——

```
flowByTier    档位 → 流程
              low=;medium=converge;high=cross,red,converge;xhigh=all;max=all
              能力名：diverge(发散) / cross(跨验) / red(红队) / converge(收敛)
              all = 四项全开；等号右边留空 = 四项全关

effortByTier  档位 → 子代理强度区间
              low=none~medium@low;high=medium~xhigh@high;ultra=xhigh~max@xhigh
              ；@ 可省略（默认起手＝下沿）
```

**未列出的档位沿用内置默认；留空 = 与不配完全一样。**

> ### 🔴 不要给模型"强行改名"
>
> 如果某个模型只支持 `low` / `medium` / `high`，就**只声明这三档**。
> **不要**为了凑出 5 档而把 `xhigh` 映射到 `high` —— 那会让模型收到一个
> 它并没有的强度，实际行为是"档位能动但不起作用"，比不配更难查。
> 这里的设计取向是：**有什么适配什么**。

### 实测提醒：部分中转站会**静默忽略**强度参数

本项目实测（判据：给端点发一个**必然非法**的强度值）：

| 渠道 | 结果 |
|---|---|
| DeepSeek 官方 Messages 端点 | ✅ 真支持（9 档全接受，切档不破前缀缓存） |
| GPT 系（有效 `max_tokens` + 需推理的任务） | ✅ 真支持（返回 `reasoning_tokens`，各档有差异） |
| Claude 系（同上） | ✅ 真支持（各档输出长度有稳定差异） |

**自查方法**：发一个必然非法的强度值 —— 报 400/422 说明真在解析；
仍 200 说明端点**宽松接受**（可能是静默忽略后回退默认）。
但注意：**`max_tokens` 太小时各档位看起来会完全一样**（模型没空间产出思考 token），
所以要把 `max_tokens` 给足、并用需要推理的任务来对比。

---

## 推理强度档位怎么声明

DSH 的档位名是**封闭集合**：`off / minimal / low / medium / high / xhigh / max`。
`reasoningEfforts` 的**键**必须是集合里的名字，**值**是线上真实发出的值：

```yaml
reasoningEfforts:
  low: low
  medium: medium
  high: high
  xhigh: xhigh
  max: ultra      # 显示 Max，实际发 ultra
```

⚠️ **`xhigh` 与 `max` 必须显式声明**才会出现在可选列表里。

---

## 测试

```bash
cd base        # 或 recommended
npm test       # 268 项：protocol 42 + smoke 164 + client 55 + prompt-hygiene 7
```

单独跑：

```bash
npm run test:protocol
npm run test:smoke
npm run test:client
```

---

## 目录结构

```
base/                     基础版
recommended/              推荐版
  bundle/                 插件本体
    index.js                Host 半侧：设置宿主（20 个 volatile 字段）
    preset.js               preset 半侧：协议注入 + 计划门禁 + 交付门 + 子代理分档
    protocol.js             纯函数：协议文本、分类、档位裁剪（可单测）
    client.js               设置页 UI
    cordis.patch.yml        装配补丁
    locale/                 中英词典
  prompt-hygiene/         提示词卫生组件（顶层注册，所有模式生效）
  vendor/                 内联的滑动条（仅推荐版）
  patches/                dsh-ops 的本地补丁（仅推荐版）
  test/                   测试与桩
```

**为什么编程模式拆两半**：DSH 设置页的表单只认「可独立寻址的 profile 条目」。
嵌在 preset 的 `plugins` 列表里的行不是这样的条目，它的 Config 在设置页看不到。
所以设置宿主做成**顶层行**，preset 半侧通过 `ctx.get('codingModeSettings')` 读配置。

---

## 已知限制

- **preset 的 `plugins` 是整块替换语义** —— 上游改了官方 preset 的工具清单不会自动跟进，
  需要重新抄一份。
- **推理强度对模型行为的影响是非单调的** —— 实测同一档位在不同请求间思考长度波动很大，
  档位之间没有稳定的大小关系。所以本项目的档位差异**主要落在"流程文本"上**（确定性生效），
  而不是指望模型因为档位不同就真的想得更久。
- `stageRestrict` 与 `flowGate` **默认关闭** —— 它们会拒绝工具调用、驳回轮次收尾，
  默认打开对既有工作流是惊吓。需要"硬"的时候再开。
- 推荐版依赖的 `dsh-ops` 会拉取约 600MB 载荷。

---

## License

MIT
