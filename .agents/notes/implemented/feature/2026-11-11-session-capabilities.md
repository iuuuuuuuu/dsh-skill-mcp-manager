# Agent Note: 会话级能力策略与对话内的「能力管理」视图

Status: implemented

## Problem

能力库只能改全局配置。但「这条对话先别让它用 reqable」「这条会话别给模型看这个技能」是会话级诉求：改全局再改回来既麻烦，又会在别的对话里生效。宿主这边 `skills.list/get` 的 `scope` 参数、`tools/pre-execute` 的 scope 过滤、`conversation.view` 槽位都在，缺的是把它们拼成一条可用的策略链。

## Decision

- **存储**：`session-caps.json`，`{ [sessionId]: { mcp: [denied], skills: [denied] } }`，记**拒绝项**，默认全开；空策略自动删掉该会话。
- **四处作用点**（都读实时策略，不缓存）：① `agent/pre-step` 的目录注入过滤被拒 MCP；② `ensureSessionRuntime` 跳过并断开被拒条目；③ `mcp_load` / `mcp_call` 对拒绝项报 `disabled in this conversation`；④ 技能侧两层：会话层影子（`ctx.skills.register()` 在 agent 自己的层注册同名 + `modelInvocable:false`）**加** `tools/pre-execute` 守卫（`"deny"`）。
- **为什么技能必须两层**：宿主的技能目录与 `skill` 工具同生共死，单个技能从目录消失要靠层优先级（影子），而层优先级是宿主内部规则，换版本可能变；守卫不依赖它，是硬保证。影子是加分项，守卫是底线。
- **scope 语义**：`scope` 直接吃 **agent 对象**（`skillTool` 就是这么传的），`cwd` 用 `ctx.workingDirectory.ensure(agent, signal)`；守卫注册在 `agent.ctx`，宿主按 scope 只派发该 agent 的调用，一个 agent 一次（WeakMap），随 agent 上下文回收。
- **UI**：注册 `conversation.view`（id `capability`、order 11、`label: () => "能力管理"`、`inject: (sessionId) => ({sessionId})`），两组行内开关，只写会话策略。

## Alternatives considered

- **只做影子**：代码最少，但依赖宿主的层合并规则；规则一变就静默失效，而用户以为已经关掉。
- **只做守卫**：确定性够，但技能仍会出现在目录里，模型会反复尝试并收到拒绝，体验差。
- **不改宿主、只在前端禁用按钮**：假的，模型仍能调用。
- **把策略写进会话日志**：更「正确」，但需要在宿主事件流里占位、还要处理压缩；一个按会话 id 的小 JSON 已经够，且不污染会话格式。
- **给 skill 加全局 frontmatter 开关**：那是全局生效，恰好是这次要避免的。

## Consequences

- 会话 id 来自 `agent.session.id`；拿不到 id 时策略整体失效（不猜、不误伤）。
- 被拒 MCP 的 eager 连接会立刻断开（`disposeSessionEntry`），重新允许时 eager 会重新挂载，on-demand 要等下一次 `mcp_load`。
- 影子注册需要技能正文（读一次 `skills.get`），读不到也照样注册一个占位描述的同名影子——名字被拒才是目的。宿主若改成「同层 runtime 一律不覆盖」，守卫仍然兜住。
- 测试：`test/session-caps-smoke.mjs`（假 agent：目录过滤、`mcp_load` 拒绝、守卫 allow/deny/不误伤其它工具、影子注册与释放、落盘与恢复、空策略删文件）。故障注入三条都会红（去掉目录过滤 / 去掉 `mcp_load` 守卫 / 不注册技能守卫）。
- 这一轮中途被打断过一次，恢复时发现文件里有两份 `applySessionSkillPolicy`（前一次尝试 + 恢复后的重写），已合并成一份并把守卫并进影子那份；教训：被打断后先 `git diff` 看现状，别直接重写。