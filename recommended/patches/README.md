# dsh-ops 本地补丁

本目录里的 `dsh-ops@0.2.9.patch` 是**本机对 dsh-ops 做的修改**，必须一起安装才有效果。

## 改了什么

从 `lib/policy.js` 的 `FILE_TOOLS` 里移除了 `inspect_local_file` 与 `glob`：

```js
- export const FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])
+ export const FILE_TOOLS = Object.freeze(['grep', 'replace'])
```

**原因**：宿主已有同功能的 `read` / `glob` 工具，dsh-ops 的这两个完全重叠，留着只占模型注意力。
保留 `grep` 与 `replace` 是因为它们**能力独有**：
- `ops_grep` —— 有 `count` / `summary` 模式（比取全量输出省 token）、支持 `glob[]` 批量与 `!` 排除
- `ops_replace` —— 唯一能做跨文件批量替换的（宿主 `write` / `edit` 只能单文件精确改）

**为什么改源码而不是用 `tools.restrict` 运行时屏蔽**：`FILE_TOOLS` 是**唯一事实源**，
同时决定「发布哪些工具」与「提示词表格列哪些」（见 `lib/tools.js:571` 与
`lib/policy.js:29`）。用 restrict 只隐藏工具、表格照列，模型会看到一张自己调不了的工具表，比不改更糟。

## 怎么装

在 profile 目录里：

```bash
mkdir -p patches
cp dsh-ops@0.2.9.patch patches/
pnpm patch-commit patches/dsh-ops@0.2.9.patch   # 或先 pnpm patch dsh-ops@0.2.9 再覆盖文件后 commit
pnpm install
```

pnpm 会把补丁记进 `pnpm-lock.yaml`，**以后重装/升级会自动重放**。

## ⚠️ 升级 dsh-ops 后要检查

上游升级后本补丁可能失配（`FILE_TOOLS` 那行的上下文变了），现象是
`ops_glob` 与 `ops_inspect_local_file` **又回来了**。自查：

```bash
grep FILE_TOOLS node_modules/dsh-ops/lib/policy.js
# 应输出 ['grep', 'replace']
```
