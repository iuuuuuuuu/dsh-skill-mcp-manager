# Agent Note: 插件注入的 MCP 行进入能力库（分组 + 热开关）

Status: implemented

## Problem

bundle 可以在自己的 `cordis.patch.yml` 里 insert 一条 `@deepseek-ai/dsh-mcp-client` 行（box 就是这样）。这类行不进能力库 registry：`reconcile` 只读 profile patch，而 profile patch 里同 id 的 modifier 行盖不住 bundle 的 insert —— 试过两种写法，`--dump-config` 里 `disabled` 都不生效。结果是它们既不在能力库里显示，也没法从界面关掉；用户只能去改别人的包或者手改 profile。

## Decision

三件事分开做：

1. **发现**：`ctx.inject(["loader"])` 拿 `loader.entries()`，挑 `options.name === "@deepseek-ai/dsh-mcp-client"` 且没被 registry 认领（按 `systemEntryId` 过滤）的行。老宿主不暴露 loader 时返回 `native.supported=false`，UI 退化成只有「系统」组，不报错。
2. **归属**：读 `<profile>/package.json` 的 `dsh.profile.bundles`，逐个 parse `node_modules/<bundle>/cordis.patch.yml`，谁声明了这行 id 谁就是 owner。`resolveProfile()` 可能指错 profile（`--profile` 不一定传），所以再扫一遍 `profiles/*`，先到先得；都找不到显示「未归属插件」，不猜。
3. **热开关**：`POST /mcp/native {id, enabled}` → `entry.update({ disabled })`。loader 在 disabled 时 `fiber.dispose()`、恢复时 `init()`。真机实测：禁用后 MCP 子进程 PID 真实退出、marker 文件被删，启用后新 PID 起来，**DSH 不用重启**；bundle 的 patch 一个字不改（重启后回到插件默认，这是刻意的边界）。

这些行不进 registry、不写托管块、不参与 `mcp_register`/`mcp_load` 的按需加载：它们是插件的原生连接，能力库只负责显示与开关。

## Alternatives considered

- **在 profile patch 里写同 id 的 `disabled: true` 覆盖**：最省事，实测盖不住 bundle 的 insert（`--dump-config` 里没有 `disabled`），放弃。
- **改 bundle 自己的 patch 文件**：等效于改别人的包内容，升级即丢，且不再是我们能解释的状态。
- **把这些行收进 registry 当普通条目管理**：会与仍然挂着的原生行重复注册（同名 MCP 两个连接），而且接管要求原生行 disabled —— 又绕回第一条的死路。
- **要求重启才生效**：用户明确要求「热更新 mcp 开关，不必要重启」，loader 的 `update` 正好提供了热路径。
- **不归属、只列出来**：分组就没有意义（用户要的是「插件 · @simular/dsh-box」并能整组关掉）。

## Consequences

- 归属靠「bundle 的 patch 里声明了这行 id」；插件若用 `!!js` 或运行时拼 id，就会落到「未归属插件」，仍然可以开关。
- 开关状态只活到本次进程：重启后 bundle 的 patch 重新生效，行回到插件默认。要长期关掉，仍然得改插件或 profile（第 5.10 节那条路）。
- `native` 视图的 URL 只回 `protocol//host`，避免把 query 里的 token 带进浏览器。
- 测试：`test/mcp-native-smoke.mjs`（真 profile 目录做归属、假 loader 验 `update` 调用与视图回读、未知 id/缺 `enabled` 拒绝）；两处故障注入（去掉归属、去掉 update 调用）都能打红。真机验证用了一个临时 fixture 插件（它 insert 一行指向自写的 stdio MCP）：开关前后 PID 变化、marker 文件消失/重建，界面分组显示「插件 · fixture-mcp-plugin」。