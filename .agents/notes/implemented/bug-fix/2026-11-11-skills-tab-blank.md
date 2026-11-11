# Agent Note: 技能 tab 白屏（错把 MCP 面板的确认块插进了技能面板）

Status: implemented

## Problem

给 MCP 页加「清理残留进程」的确认面板时，我用 `notice/error/loading` 这一段骨架做替换锚点。`SkillsPanel` 和 `McpPanel` 的返回结构里都有逐字相同的这一段，`String.replace` 替换的是**第一个**匹配 —— 于是块被插进了技能面板，引用了 MCP 面板才有的 `orphans` / `scanningOrphans`。点开「技能」tab 就 `ReferenceError: orphans is not defined`，整个 slot 崩掉、页面一片空白。

## Decision

把块从 `SkillsPanel` 移到 `McpPanel`（定位靠「它引用了哪些变量」而不是再猜一次锚点），并在 AGENTS 里立了规矩：改 client 面板时锚点必须带所在函数名或独有字符串，改完必须真机点开那个 tab。

## Alternatives considered

- **只把 `orphans` 提到两个面板外层共享**：能让报错消失，但技能面板会多渲染一个它不该有的 MCP 确认框，属于把错误藏起来。
- **加 React error boundary 兜住**：真出问题时至少白屏变提示，但这次是**结构放错**，boundary 只会让错误更晚被发现。

## Consequences

- 这是本轮自己引入又自己修掉的回归：编译通过、单测全绿、之前那次 tab 验证也通过（都在这个改动之前）。教训已进 AGENTS 常见坑。
- 真机复现路径固定：打开能力库 → 点「技能」→ 控制台 `ReferenceError: orphans is not defined`；修复后技能页正常渲染（`系统 [1 个 · 开启 1]`，1 张卡）。