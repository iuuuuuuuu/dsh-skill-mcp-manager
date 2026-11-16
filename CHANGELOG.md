# Changelog

All notable changes to dsh-skill-mcp-manager (能力库 / Capability) are documented here.

## [未发布] — 2026-11-11

### Added

- **能力库：MCP 新增入口**：MCP 页头部多了「新增 MCP」，右侧抽屉填名称 / 传输（stdio 命令 + 参数，或 streamable-http URL）/ 备注即可注册。
  - 宿主新增 `POST /mcp/add` → `addMcp()`，与 `mcp_register` 工具**共用同一个 `registerServerEntry()`**：**注册前真连一次 + 拉工具清单**，连不上就 400 且不写注册表；重名即更新；UI 是人点的，所以不弹「本地命令审批」（那道门是防模型的）。
  - 测试：新增 `test/mcp-add-smoke.mjs`（真 stdio fixture：注册成功并落盘、重名更新不产生重复、连不上 400 且注册表不变、非法名字/缺传输/缺 URL/缺命令全部拒绝），已加入发布基线。
- **能力库：插件组默认展开，只显示一行卡片，多的进「展开更多」弹窗**：技能页与 MCP 页的插件组（含「未归属插件」）默认展开，正文只放**一行卡片**（`PLUGIN_ROW_VISIBLE = 3`），组头出现「展开更多 N 个」→ 居中弹窗（`.smx-modal`）里仍是同一套卡片、可滚动；组本身仍可折叠。系统组 / 自定义分组不受影响。
  - 真机判读：MCP 页 `插件 · @simular/dsh-box 4 个 · 启用 2` 显示 3 张卡片 + 「展开更多 4 个」，弹窗里 4 张；技能页 `插件 · @simular/dsh-big 5 个` 显示 3 张 + 「展开更多 5 个」；两页 0 console 异常。
- **插件注入的 MCP 行没有描述时，卡片写明是谁注入的**：`由 <插件名> 注入 · 服务器未自报描述`（没有归属时 `由 未归属插件 注入 · …`）。原来留空，看起来像坏掉；loader 行在连接前确实没有 `serverDescription`，所以说的只是事实，不是功能简介。
  - 测试：`session-caps-smoke` 断言插件行带上这句话、注册表行仍用服务器自报描述。真机判读：`box` 显示「由 @simular/dsh-box 注入 · 服务器未自报描述」，`mystery` 显示「由 未归属插件 注入 · …」，0 console 异常。
- **修：能力管理里 MCP / 技能卡片没有描述**：两个原因叠在一起 ——
  1. `tile()`（会话视图的卡片）**从来没有渲染描述那一行**，技能的描述明明在数据里也被丢掉了；MCP 行更是**根本没带** `description`。
  2. 插件注入的 MCP 行（loader 行）**没有自报描述**：它不是注册表条目，没连接前拿不到 `serverDescription`；现在读 loader 行的 `config.description`（多数 bundle 不写），没有就**留空，不编造**。
  - 修法：注册表行取 `serverDescription`（截断 300）、工作区行取声明的 `notes`、插件行取 loader 配置里的 `description`；卡片在标题与元信息之间渲染一行描述（`-webkit-line-clamp:2`，两行封顶），完整内容与工具/正文仍看「详情」。
  - 真机判读：`reqable`、`web-search`、`agent-notes` 三张卡片都出描述了（两行内截断），`box`（插件 MCP）如实留空，0 console 异常。
- **能力管理里能看「详情」了**：每张卡片右下角多一个「详情」按钮，右侧抽屉显示 ——
  - **MCP**：传输/档位/来源、服务器自报描述、备注，以及它提供的**工具清单**（名称 + 描述，已禁用的工具不列）。没有工具快照时不装作「没有工具」，而是明确说「还没有工具快照：可以在能力库点「刷新快照」，或先在本对话打开它一次」。
  - **技能**：来源、是否随包只读、SKILL.md 路径、frontmatter 里的描述，以及 **SKILL.md 正文原文**（等宽、带边框、可滚动）。
  - 宿主新接口 `GET /skill-mcp-manager/capability-detail?session&kind&name`（只读，**不会**因为看详情而连接任何 MCP）；`kind`/`name` 与「是否可见」都走与开关同一套解析（作用域 + 工作区 cwd），未知技能 400。
  - 测试：`session-caps-smoke` 新增一节（MCP 详情列出 fixture 的工具并标注 `loaded`、技能详情回传正文与路径、未知技能 400、坏 kind 400）；`client-render-smoke` 断言每张卡片都有「详情」。真机截图判读：MCP 抽屉列出 3 个工具 + 「共 3 个工具」，技能抽屉渲染出带边框的 SKILL.md 原文，0 console 异常。
- **插件提供的分组默认展开、卡片样式不变（并入开启优先排序）** —— 收回前几轮的错误做法：
  - 插件组（MCP 与技能）**默认展开**，卡片就是能力管理原有的那张（`.smx-cap`：点 · 名称 · 徽标 · 说明 · 开关），**样式一行代码都没改**；组头仍可手动折叠。
  - 唯一保留的差异是**排序**：组内**开启的排最前、关闭的排后**，同状态按名字。
  - 作废并删除：一行的裸行、只有组头的折叠、`smx-card--line` / `smx-card--row` 变体、`smx-pluginbox` 固定高度盒子、「展开 K 个 / 收起」按钮与其状态、`PLUGIN_ROW_LIMIT`。真机判读：`插件 · @simular/dsh-box 1 / 2` 直接摊开两张卡（`box-on` 可用 / `box-off` 已关闭，开启在前），样式与 `我的 MCP 服务器` 的 `reqable` 完全一致，0 console 异常。
- **插件组的卡片：一行内容，开启的排最前**（能力管理，定稿口径）：
  - 卡片仍是能力库那一张（`.smx-card.smx-card--row`，边框/圆角/网格都在），但**内容固定一行**：状态点 · 名称 · 徽标 · `传输 · 来源说明`（`white-space:nowrap` + 省略号，不换行）。真机量到：描述再长，卡片高度也是 31–34px、描述行高恒 15px。
  - **最少一行 / 最多一行**：一组至少显示一张卡片（有条目就不会空），组内每张卡片只有一行；条数多时**开→关 排序**（开启的在前、关闭的在后，同状态按名字），再多的进「展开」的固定高度盒子内部滚动。
  - 真机验证（混合状态 fixture）：展开后 `box-on-1[on] → box-on-2[on] → box-off-1[off] → box-off-2[off]`，技能组 `agent-notes[on] → skill-off[off]`；折叠时每组只出现第一张（也就是第一个开启的）；0 console 异常。
- **插件提供的条目统一用能力库那张卡片**（能力管理）：插件组的 MCP 与技能都渲染成能力库同款卡片 —— 状态点 · 名称 · 徽标 / 副行（`streamable-http`、`来源 agent-notes`）/ 一句来源说明 / 状态行（`已启用 · 开关即时生效，无需重启`）/ 分隔线 · 开关（`启用中` / `已关闭`）。折叠只显示**第一张卡片**，组头「展开 K 个」把全部卡片放进固定高度（`min(46vh,320px)`）盒子内部滚动。
  - 来源说明由 `describeCapability()` 生成：插件注入的 MCP 行说「由插件注入的 loader 行（mcp-box），不在能力库注册表里。」，工作区声明的说文件路径，注册表的按 eager/on-demand 说语义；技能按 `filesystem` / 插件 provider 分别说明，只读的注明随包只读。为此 `getSessionCapabilities` 的 MCP 行新增 `id` 字段（loader 行 id）。
  - 副行改为**传输/来源**（原来写「插件自带」），与能力库一致。
  - 测试：`client-render-smoke` 断言折叠时出现能力库同款卡片（`.smx-card`，非 `--line`）、文案含「由插件注入的 loader 行」「已启用」「启用中」。真机截图判读：`box` 与 `agent-notes` 两张卡片结构与能力库一致，0 console 异常。
- **插件组的条目 = 一行高的卡片**（能力管理，定稿）：
  - 插件组的每个条目仍是**卡片**（`.smx-card.smx-card--line`：边框/圆角/网格都保留），只是**内容压成一行** —— 状态点 · 名称 · 徽标 · 来源 · 开关。
  - **折叠态显示第一张卡片**（开启的排最前），组头 `N / M  全开 全关 展开 K 个`；条目多于 1 时才有「展开」。**不是裸行，也不是只留组头。**
  - 「展开」把全部卡片放进**固定高度**盒子（`min(46vh, 320px)` + 盒内滚动），页面高度不随插件条目数变化；只有 1 条的插件没有「展开」，那张卡片就是一行的正常高度。
  - 踩坑：`.smx-card` 自身是 `flex-direction:column` 且声明在样式表更靠后，直接写 `.smx-card--line{flex-direction:row}` 会被覆盖（真机截图里卡片被撑成三层高）—— 必须 `.smx-card.smx-card--line` 提权。
  - 测试：`client-render-smoke` 折叠断言「恰好 1 张 `.smx-card--line` 卡片、且是开启的那条、无展开盒子」；展开断言「唯一 `is-open` 盒子内 6 张卡片、开启在前、组头变收起」。真机量测：折叠 `rows=1 box=no`、单条插件同样 1 张卡片且无「展开」、展开 `h=334 rows=3`，0 console 异常。
- **MCP 连接检测（卡片上的「检测」+ 头部「全部检测」）**：用条目自己配置的传输方式做一次**真握手**（stdio 起子进程、streamable-http 走 HTTP），回传是否连通、握手耗时、服务器本次实际暴露的工具数，以及服务器自报名。失败也是答案而不是 HTTP 错误：传输层/服务器原话直接显示在卡片上（默认截断，悬停看全文），因为「配置到底还能不能连」这个问题，工具快照回答不了——快照可能是一个月前的。结果按条目记进 `registry.json` 的 `lastCheck{at,ok,latencyMs,toolCount,serverName,toolsDiffer,error}`，所以重开页面也能看到「上次连通 · 371 ms · 2 分钟前」/「上次失败 · 5 分钟前」。检测**只探活**：不改写 `tools` 快照（刷新快照仍是单独动作，卡片在 `toolsDiffer` 时提示「工具已变化，建议刷新快照」）、不碰运行中的会话实例、不改 `eagerConnectFailed`（那是常驻注册在本进程里的状态）。超时用新配置项 `checkTimeoutMs`（默认 15s，短于 30s 试连：这次是人在等）。管理页一次最多并发 3 个检测，避免「全部检测」瞬间拉起十个子进程。检测失败的错误文本会落盘再回浏览器，所以**敏感值（敏感 env、headers、URL）在离开 Host 前被替换成掩码**（`reveal=1` 才给原文）。测试：`test/mcp-check-smoke.mjs`（真起两个 stdio fixture：一个正常服务器验连通/工具数/快照不被改写/落盘，一个立即退出的验失败答案；未知名字仍 400；掩码与 reveal 双向断言）。
- **新配置项 `checkTimeoutMs`（默认 `15000`）**：管理页检测的超时，只影响 UI 探活，不影响注册试连（`trialTimeoutMs`）与工具调用（`toolCallTimeoutMs`）。
- **修：「能力管理」里技能只列出一个（agent-notes）**：那栏原来用**会话层**（`skills.list({scope: agent})`）取列表，只看得到插件自己注册的那一个；能力库列出的是**常驻 preset 层**（`filesystem` / `~/.agents/skills` / 随包技能）。现在两边取并集（常驻层 + 会话层，按名字去重），视图、单条开关、一键全关/全开都用同一份列表——所以关掉一个只存在于常驻层的技能也不会再报「skill not found」。
- **修：技能服务偶发不可用（插件上下文失效）**：桌面端重载插件条目后 `ctx.skills` 会抛 `cannot get required service "skills" in inactive context`，而路由还在服务。`skillsService()` 现在按 `ctx.skills` → `ctx.get("skills")` → `ctx.root.skills` 依次取第一个可用的；全部不可用才报「重启 DSH」。(注：这条要重启宿主才生效。)
- **测试**：`test/session-caps-smoke.mjs` 的假 provider 现在按层返回不同集合（`only-standing` 只在常驻层、`only-agent` 只在会话层），断言并集且不重复；两处故障注入都会红（只取会话层 = 用户遇到的现象；只取常驻层）。
- **插件组改成「固定高度卡片盒子」**（已被上面最新一条取代）：
  - 一个插件组 = 一张卡片容器（`.smx-pluginbox`），**默认只渲染一行**（开启的排最前），组头有「展开 N 个 / 收起」。
  - 点「展开」把**同一个盒子**撑到固定高度（`min(46vh, 340px)`），其余条目在盒内滚动 —— 页面高度不随插件条目数变化，弹窗取消。
  - 第一版用「按高度裁剪」实现，主题字体行高一变就漏出第二行（真机实测 52px 的盒子露出 1.86 行），改成**折叠时只渲染一行**：行高由主题决定，列表才是契约。
  - 折叠时盒子自然高度（一行），展开时才是固定高度 —— 避免为了“固定”把折叠态撑出一个空盒子。
  - 非插件组（`我的 MCP 服务器` / `工作区自带` / `系统`）仍是卡片网格；插件组整体折叠（▸）与盒内展开是两层，各管各的。
  - 测试：`client-render-smoke` 三段断言 —— 折叠时 `.smx-pluginbox` 只有一个且无 `is-open`、页面只出现一行、组头写着「展开 6 个」；展开时出现全部 6 行且开启项在前、组头变「收起」。真机截图判读：折叠 `rows=1 h=52`、展开 `rows=6 h=350`（内部滚动）、0 console 异常。
- **插件提供的项改为「一行式 + 展开更多（modal）」**（已被取代）：插件组里的 MCP / 技能不再平铺卡片，改成一行一条（状态点 · 名称 · 说明 · 开关），组内**开启的排在最前**（同状态按名字）；超过 5 条的溢出进「展开更多 N 个」，点开是**居中 modal**（标题 + N/M 开启 + 逐条开关 + 关闭），页面高度不再随插件数量增长。折叠时按钮也不出现，组头计数与「全开/全关」照旧。非插件组（我的 MCP 服务器 / 工作区自带 / 系统）仍是卡片网格——那里条目少且每条信息更多。
  - 实现：`row()` 与卡片共用 `flip()`；`PLUGIN_ROW_LIMIT = 5`；modal 状态 `more`（`CapabilityView` 的第 6 个 hook）；行的容器 `.smx-caprows`（modal 内去掉容器样式）。测试：渲染冒烟新增一节——展开插件组后断言行数=5、开启项在前、`sequential`（第 6 条）不在页面上、出现「展开更多」；真机截图判读：页面上 `box-a,box-c`（开）在前、`box-b,box-d,box-e`（关）在后、按钮「展开更多 6 个」，点开后 modal 列出 6 条且标题/计数正确，0 console 异常。
- **能力管理的分组默认折叠规则与能力库一致**：`我的 MCP 服务器` / `工作区自带` / `系统` 默认展开，**每个插件组（含「未归属插件」）默认折叠**，组头可见计数与「全开 / 全关」，点标题行的箭头展开。空组保持展开（否则「还没有服务器」的提示看不见）。实现上把组头做成折叠开关（`.smx-capgroup__toggle` + 复用库页的箭头样式），状态记在 `openGroups`，默认值判据是 `key.startsWith("plugin:")`。测试：渲染冒烟断言「插件组头在、卡片不在」「非插件组卡片在」，故障注入两处会红（永不折叠 → `a folded plugin group must not render its cards`；全折叠 → `a registry tile must be rendered`）；真机截图判读：4 个插件组全部 `[folded] cards=0`，点第一组后变 `[open] cards=1`，0 console 异常。
- **工作区自带的 MCP（新增约定）**：宿主没有「工作区 MCP」这个概念，所以由本插件定义 —— 项目可以自带服务器，**不进**用户注册表、**不写** profile patch：
  - 认三个文件（同名先找到的赢）：`<工作区>/.dsh/mcp.json`、`<工作区>/.mcp.json`（Claude Code / Cursor 同款）、`<工作区>/.agents/mcp.json`。
  - 两种形状都收：`{ "servers": [{ name, transport, command, args, env }] }` 与 `{ "mcpServers": { name: { command|url, args, env, headers } } }`；`command` 推 stdio、`url` 推 streamable-http，名字必须 `[A-Za-z0-9_-]{1,32}`，坏条目**跳过并报原因**而不是整份失效。
  - 工作区服务器一律 **on-demand**：永不注册宿主原生工具，只走 `mcp_load`/`mcp_call`，并按会话开关（守卫认 `mcp__<name>__*`）。`mcp_load`/`mcp_call` 的名字解析顺序：注册表 → 会话工作区声明。
- **注册表条目可以「只在这个工作区生效」**：MCP 详情抽屉里选「仅 <工作区>」，该条目在别的工作区的对话里**既不列出也不挂载**；选回「全部工作区」即解除。持久化在 `registry.json` 的 `workspace` 字段。
- **工作区自带的东西默认开**：没有存过工作区默认时，新对话按「工作区自带的」起步 —— 工作区声明的 MCP 服务器、以及在**该工作区目录内**的技能（按路径判定，用户自己的 `~/.agents` / 随包技能不算）；其余依旧默认关。存过工作区默认则以那份为准。
  - 测试：新增 `test/workspace-mcp-smoke.mjs`（两种形状、推断传输、坏条目报错、文件优先级、坏 JSON 不致命）；`session-caps-smoke` 增加工作区自有默认开、注册表 pin 过滤、以及 `mcp_load` 解析工作区服务器的断言。故障注入四处会红（pin 不过滤 / 工作区自带不默认开 / `mcp_load` 不解析工作区 / 种子里不写 `seeded` 标记）。
- **工作区默认开启（「新对话默认开哪些」）**：能力管理头部多了「存为工作区默认 / 清除默认」和一个「新对话默认：N 项」的计数。点「存为工作区默认」就把**这个对话此刻开着的** MCP 与技能记成**这个工作区**的默认；以后在这个工作区新开的对话，第一轮就按这份默认起步（不是全关）。
  - 存储在 `~/.dsh/skill-mcp-manager/workspace-defaults.json`，以**工作区路径**为键（`resolve` 后小写化，与项目技能的 cwd 键一致）。
  - 只影响**新对话**：一个对话在它的第一轮被 `seeded: true` 标记，之后哪怕你把所有开关都关掉，也不会被默认值再覆盖回去（否则「我明明关了」会变成灵异事件）。这条是本功能的语义核心，测试专门盯着它。
  - 工作区靠 `ctx.workingDirectory.ensure(agent)` 取（与宿主自己的项目技能同一口径），取不到就当作没有默认、不写盘。
  - 接口：`GET/POST /skill-mcp-manager/workspace-defaults`（`action: "save-current" | "clear"`，save 需要 `session`）。测试：`session-caps-smoke` 增加一节（存默认 → 新对话继承 → 别的工作区不受影响 → 已有对话不被重写 → 清除生效 → 坏 action 400）；故障注入三处会红（不 seed / 不按工作区取键 / 忽略对话自己的选择）。
- **修：能力管理里切换技能时报 `cannot get property "skills" without inject`**：宿主的 **agent 上下文并不声明 `skills` inject**（这是常态），而我读 `agent.ctx.skills` 时没做保护 —— 一次切换就把 cordis 的原始异常冒到面板上。现在所有逐 agent 的技能读取都走 `agentSkills(agent)`：先在 try/catch 里试 agent 自己的服务，再用宿主上下文兜底，拿不到就当作「没有本地视图」，绝不抛；同时把 handler 里对 `applySessionSkillPolicy` 的调用也包起来（失败只记日志，不变成 400 横幅）。测试：`session-caps-smoke` 增加「agent 上下文不 inject skills」的用例，断言开关仍然 200、策略仍记录、守卫仍安装，且**不产生降级告警**；故障注入（改回裸读 `agent.ctx.skills`）会红，报的正是你截图里那条原文。
- **修：技能页白屏（`groups.map is not a function`）** —— 这次是**我的**回归，不是内核问题。给技能页加自定义分组时，把 `originSections = groups.map(...)` 里的 `groups` 留成了自定义分组的**状态对象**（`{groups, members}`），而原来的「系统/插件」分桶数组已改名 `originGroups`。渲染技能 tab 时 `groups.map` 直接抛 TypeError，整块 slot 崩掉 → 页面空白。已改成 `originGroups.map`。
- **新增 `test/client-render-smoke.mjs`（渲染冒烟，堵住这类）。** 之前所有客户端测试都停在「bundle 能解析 + 槽位注册对」，面板本身从没被**构建**过，所以这类渲染期错误一路绿灯发出去。新测试用最小 React 替身（真 state + 首轮跑 effect）把 `main` 面板的两个 tab 和 `conversation.view` **真的渲染成树**并断言关键节点。故障注入验证：把 `originGroups.map` 改回 `groups.map` → `FAIL: SkillsPanel threw on render: groups.map is not a function`；去掉每类批量开关 → `FAIL: both kinds need their own bulk switch`。
- **能力管理：默认全关 + MCP / 技能分开的批量开关 + 按插件分组**（本轮按 Owner 要求改）：
  - **新对话默认全部关闭**：策略文件从「记拒绝项」翻转成「记允许项」（`session-caps.json` 存 allow list，没有条目的会话就是全关）。新对话不再挂载任何常驻 MCP、目录注入为空、`mcp_load`/`mcp_call` 全拒、技能目录不列任何技能、`skill` 调用全拒。要用的东西在「能力管理」里开。
  - **批量开关按类型分开**：MCP 段与技能段各有自己的「全部开启 / 全部关闭」，一次只改一类（`POST /session-caps {kind, bulk:true, enabled}`）。再往下每**组**还有自己的「全开 / 全关」。
  - **按插件分组**：MCP 分成「我的 MCP 服务器」（注册表）与每个插件一组（插件注入的 loader 行，认不出归属时显示「未归属插件」）；技能沿用「系统 / 插件 · 包名」。
  - **插件自带的 MCP 也能按对话关掉**：这类行不是本插件挂的、不能卸载，所以改由 agent 上下文上的 `tools/pre-execute` 守卫拒绝 `mcp__<server>__<tool>` 调用——与技能的守卫是同一条。
  - 测试 `test/session-caps-smoke.mjs` 重写（默认全关、每类批量互不影响、插件行分组与守卫、跨会话隔离、失效上下文兜底），三处故障注入均能打红（默认放开 / 批量跨类型 / 去掉原生守卫）。真机截图判读：分段与分组、组级开关、全关态 0/N 显示均正确，无 console 异常。
- **能力管理视图：卡片化 + 一键全开/全关**：会话视图从「一行一条」改成和能力库一致的卡片网格（状态圆点、名称、档位/工具数徽标、开关与「本对话可用/不可用」），关掉的卡片虚线灰底；头部加「全部关闭 / 全部开启」（一次改这一类策略里的所有 MCP 与技能）与「N / M 可用」计数。宿主新增批量分支：`POST /session-caps {bulk: true, enabled}` 一次遍历两类策略、断开被关掉的 MCP 连接、重挂被重新开启的 eager 条目；**客户端在宿主没有批量分支时自动退回逐条调用**（老宿主也能用，不会把按钮变成报错）。
- **会话级能力管理（对话里新增「能力管理」tab）**：在对话的视图切换里（`conversation.view`，就在「轨迹」旁边）注册了第二张视图，按**当前对话**列出能力库里的 MCP 服务器与当前作用域的技能，每行一个开关。关掉只影响这个对话：MCP 会立刻断开该 agent 的连接、从本对话的目录注入里消失、`mcp_load`/`mcp_call` 直接拒绝；技能除了注册会话层的 `modelInvocable:false` 影子（尽力从目录里也去掉）之外，还在该 agent 上下文上挂了一个 `tools/pre-execute` 守卫，`skill` 工具调用一律拒绝——因为宿主的技能目录与 `skill` 工具是同生共死的，光靠影子会依赖层优先级。策略按会话 id 落盘（`session-caps.json`），重开对话仍然生效；默认全开，空策略自动从文件里删掉。新接口 `GET/POST /skill-mcp-manager/session-caps`（同一个 path 用方法分发）。测试：`test/session-caps-smoke.mjs`（目录过滤、`mcp_load` 拒绝、守卫 allow/deny、影子注册与释放、落盘与恢复；三处故障注入均能打红）。
- **技能服务失效时给出可执行的提示**：桌面端在 profile patch 变化后会重新应用 loader 条目，极端情况下插件上下文已失效、HTTP 路由却还在服务 —— 此时 `/skills` 抛的是 cordis 的 `cannot get required service "skills" in inactive context`，页面上只剩一句黑话。现在统一走 `skillsService()` 包装：服务不可用时回「DSH 的技能服务当前不可用（插件上下文已失效），重启 DSH 即可恢复」。测试：`test/skill-group-smoke.mjs` 增加一节，模拟「apply 之后上下文失效」→ 断言 400 且文案可执行、原始 cordis 文案不外泄；故障注入（改回直接取 `ctx.skills`）会打红。
- **MCP 页新增「清理残留进程」**：stdio MCP 每次异常退出/重启都可能在系统里留下整条 `npx → cmd → node` 链（本机实测一次累积 40 个）。现在 MCP 页头部有按钮：先**只扫描不杀**（列出 pid + 命中的命令），确认后才结束。候选只来自本插件管理的命令（注册表 stdio 条目 + 插件注入的 loader 行，按「完整命令路径」或「非通用解释器的脚本/包参数」生成签名 —— `node`/`npx`/`cmd` 这类裸解释器名绝不作为签名），**任何祖先链上有运行中 DSH 的进程都保留**（覆盖当前实例和其它正在跑的实例）。Windows 用 `Win32_Process`（`tasklist` 系的包拿不到命令行），POSIX 用 `ps -eo`；匹配与保护判定是纯函数。接口：`POST /skill-mcp-manager/mcp/orphans {confirm?: boolean}`。测试：`test/orphan-cleanup-smoke.mjs`（签名特异性、存活链保留、孤儿识别、空签名不误杀；两处故障注入可打红），真机验证：用 WMI 造一个父进程不在 DSH 下的孤儿 → 扫描列出、确认后 PID 消失，同时用另一个挂在本 DSH 下的进程证明保护生效。
- **修：技能页白屏**（本轮自己引入的回归）：新加的「残留进程」确认面板被插到了 `SkillsPanel` 里（两个面板共享同一段 `notice/error/loading` 骨架，锚点撞了），渲染即 `ReferenceError: orphans is not defined`，整块 slot 崩掉、页面空白。已移到 `McpPanel`；真机复现 → 修复后技能页正常渲染。
- **能力库默认打开 MCP 页，且 MCP 排第一个**：`ManagerSection` 的初始 tab 从「技能」改成「MCP」，tab 顺序也改成 MCP → 技能——侧边栏点进来通常就是来看 MCP 的，技能页一次点击可达。
- **前端兼容「新客户端 + 旧宿主」**：桌面端可以只重载 client bundle 而不重启 host（`link:` 装完刷新页面就是这种状态）。以前遇到这种情况，旧宿主不发 `origin`、也没有 `/skills/toggle-group`，结果所有技能都被算进「系统」、组开关直接报错。现在客户端自己按 `provider` 兜底归类（`filesystem` / `skill-mcp-manager-recursive` = 系统，其余 = 插件），组开关在批量路由不可用时退回逐个 `/skills/toggle`；真机实测（把宿主临时改回旧形状）分组正确、开关能写文件、关回来逐字节还原。
- **插件注入的 MCP 行进入能力库 MCP 页（按插件分组 + 热开关，不用重启）**：以前能力库只认识 registry 里的条目；由插件 bundle 自己 `insert` 的 `@deepseek-ai/dsh-mcp-client` 行（如 box）既看不见也关不掉（profile patch 里写同 id 的 modifier 盖不住 bundle 的 insert）。现在 MCP 页从**活着的 loader** 读这些行（`GET /mcp` 多返回 `native{supported, entries[]}`），按**声明该行的 bundle** 归属（读 profile `package.json` 的 bundles，逐个 parse 各包自己的 `cordis.patch.yml`；`resolveProfile()` 指错 profile 时回退扫其它 profile），渲染成「插件 · <bundle>」分组：默认折叠、组头总开关、卡片上有单条开关。开关走 `POST /mcp/native {id, enabled}` → `entry.update({ disabled })`，**loader 当场 dispose / 重建该 fiber**：实测禁用后 MCP 子进程（PID）真实退出、启用后新 PID 起来，DSH 不用重启；bundle 自己的 patch 一个字不改（重启后回到插件默认，属预期语义）。registry 已认领的行不会重复出现（按 `systemEntryId` 过滤）。测试：`test/mcp-native-smoke.mjs`（真 profile 目录做归属、假 loader 验 update、未知 id/缺 enabled 拒绝；两处故障注入可打红）。
- **技能列表按来源分组（系统 / 插件）**：能力库的「技能」页现在按来源分组渲染 —— 「系统」组放内建 filesystem provider 与能力库自己递归扫到的技能（你的目录），每个**插件**各成一组（组标题用 `provider` 名；能从路径或最近的 `package.json` 认出所属包时显示包名，例如「插件 · @acme/agent-notes」）。插件组**默认折叠**，组头有一枚总开关：关掉 = 把该插件下所有可写技能一次写成 `disable-model-invocation: true`（开回来就是移除该键，逐字节还原）。随包只读的技能（`node_modules` / `app.asar` 里）**不会被写**，组开关会回报「N 个随包只读，未改动」，全组只读时开关直接置灰。判定只看 `provider`（`filesystem` / `skill-mcp-manager-recursive` = 系统，其余 = 插件），路径只用来认包名 —— 因为有的插件把 SKILL.md 写到临时目录（`dsh-windows-acl` 每次启动换一个 `dsh-acl-skill-*` 目录），按路径分组会把它当用户技能、还会因为路径变化反复新建组。新增 `POST /skill-mcp-manager/skills/toggle-group {provider, enabled}` 与 `origin{kind,key,label,provider,package,runtime}` 字段。测试：`test/skill-group-smoke.mjs`（分类、组开关写真实文件、只读跳过、系统组与未知 provider 拒绝；三处故障注入均能变红）。
- **侧边栏入口（能力库作为独立页面）**：注册宿主的 `sidebar.panellist` 行（位于「插件」与「自动化任务」之间，16px 双层卡片线条图标）+ 它选中的 `main` 面板（key = `skill-mcp-manager`），点侧边栏那一行直接在主区域打开能力库，不再只能钻进设置弹窗。页面渲染的就是设置页那一个 `ManagerSection`（一份实现两处渲染），页面容器补上宿主主区域的顶带留白与居中列宽（`calc(28px + var(--dsh-frame-top-clearance))` 与 `50% - 480px`），实测 1158px 宽下卡片三列。两个座位都是宿主的**可选** slot：老宿主不声明它们时 `slots.inject` 不触发，设置页那条入口照旧工作，不会因为找不到座位而报错；注册顺序是先 `main` 面板、后侧边栏行，行被拒就撤掉面板（不留下「没人能选中的页面」）；插件卸载/禁用时若当前正停在该面板，先用 `layout.selectPanel(null)` 离开再撤座位，避免宿主留着一个空主区域。

### Changed

- **管理页改为卡片化**：Skill 与 MCP 都从「一行一条的列表」变成自适应卡片网格（`minmax(240px,1fr)`，设置页宽度下是两列）。卡片自带名字、路径/传输方式与工具数、档位下拉、状态圆点（绿=连通、红=失败、脉冲=检测中、灰=未检测）、结果行和操作按钮；描述最多三行、路径单行省略（悬停看全）。MCP 的环境变量、headers、工具清单、命令参数这类长内容移到右侧详情抽屉（fixed 覆盖层，不撑高卡片），抽屉里保留原有「检测连接 / 查看描述 / 刷新快照」与逐工具启停。头部计数从「N 个服务器」扩展为「N 个服务器 · 连通 x · 失败 y · 检测中 z · 未检测 w」。原来常驻在 MCP 页顶部的两条数字输入（工具描述截断、stdio 消息上限）收进可折叠的「高级设置」，避免把卡片挤到首屏之外。行为未变：启停/删除/档位切换/刷新快照全部沿用原来的 RPC。

## [1.2.2] — 2026-10-03

### Changed

- **撤掉 `@deepseek-ai/dsh-*` peer 声明，宿主版本门控永不拦截本插件**：宿主启动门控（`dsh-app-boot` 的 `evaluatePluginCompatibility`）对 `peerDependencies` 里每个 `@deepseek-ai/dsh-*` 条目做 semver 比对，范围外的宿主版本直接判「与当前 dsh 不兼容」并拒绝安装/加载。1.2.1 的放宽只是把上界往外推——宿主下次跨出声明范围时会原样再拦一次。本插件实际 import 的宿主 API（`dsh-llm` 的 `createUserMessage`、`dsh-tools` 的 `assertSupportedJsonSchema`、`dsh-subprocess` 的 `scrubbedParentEnv`——最后一个本就不在 peer 里且是可选导入）都是小而稳的面，**不再声明宿主版本：真不兼容时以运行时报错暴露，而不是明明可用却被版本号挡住**。两个声明挪进 `devDependencies`（门控不检查 devDeps），本地开发/测试的 `pnpm install` 照常安装。`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react` 不以 `@deepseek-ai/dsh-` 开头，不在门控检查范围，保留原位。

## [1.2.1] — 2026-10-03

### Fixed

- **peer 声明放宽，兼容 dsh 内核 0.2.0-rc 系列**：`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-tools` 两个 peer 从 `^0.1.0-rc.6` 放宽为 `^0.1.0-rc.6 || ^0.2.0-rc.1`。宿主启动门控对每个 `@deepseek-ai/dsh-*` peer 做 `semver.satisfies(runtime, range, { includePrerelease: true })` 比对，caret 上界 `<0.2.0-0` 把 `0.2.0-rc.2` 挡在门外——DSH Desktop 2.0.17（内核 `0.2.0-rc.2`）上 1.2.0 每次启动都被静默跳过（激活报告显示「已安装，与当前 dsh 不兼容」，重启也无法加载），SKILL/MCP 管理整体失效。仅放宽声明、不改任何代码；0.1.x 与 0.2.x 两个系列都覆盖。

## [1.2.0] — 2026-09-28

### Added

- **stdio 超限响应优雅拒绝，不再整条连接报废**：MCP 官方 SDK 的 stdio 传输在单条消息超过读缓冲上限（默认 10 MB）时直接报错并关闭连接——一个发大响应的服务器（如把 base64 图片内联进单笔回复的 MCP）会让该连接上所有在途调用一起死成 `-32000 Connection closed`，必须 `mcp_load` 重建。新增 `lib/stdio-transport.js`（`ResilientStdioTransport`，线协议与 SDK 完全一致）：超限消息只保留前 1 KB 用于恢复 JSON-RPC id，其余字节排空到帧换行（内存峰值是上限而非消息大小，字节流保持对齐），然后向协议层喂一条合成的 JSON-RPC 错误响应（`-32603`，`data` 带 `received`/`limit`，文案报出「收到 x MB > 上限 y MB」并提示可在设置调大 `stdioMaxBufferSizeMb` 后重新 `mcp_load`）——恰好发起那次调用拿到结构化报错，连接与子进程存活，其余调用不受影响。通知（无 id）与恢复不出 id 的消息直接丢弃、不合成回复。
- **新设置 `stdioMaxBufferSizeMb`（管理页 MCP tab）**：stdio 连接的读缓冲上限，单位 MB，正整数，留空 = SDK 默认 10 MB；**不设额外天花板，完全对齐 SDK 语义**（官方 `maxBufferSize` 本就是不设校验的自由数值，PR modelcontextprotocol/typescript-sdk#2239；gRPC 的 int32 上限在单进程 Node 里只是假保护，不采）。改动对之后 `mcp_load` 建立的连接生效。仅作用于 stdio 条目（streamable-http 无此参数）。测试：`test/stdio-transport-smoke.mjs`（流状态机单元节 + 需真实运行时的 e2e 节，沙箱内 spawn EPERM 时自动跳过）、`test/ui-smoke.mjs`（settings 路由 round-trip）。

### Fixed

- **注入 source 改用 v4 的生产者自有 kind，每一轮对话不再整轮失败**：会话格式 v4 的**写入端**废弃了裸 `kind:"plugin"` + `plugin` 组合——`dsh-session-format-v3-to-v4` 的 `source()` 只收非空且不等于 `"plugin"` 的 kind，命中就在 `encodeEvent` 落盘时抛 `format v4 message requires a producer-owned source kind`（写入链没有再包一层 try/catch，错误直接上抛成 `agent turn failed`）。本插件每轮 pre-step 注入的目录消息用的正是这个形状，因此只要 registry 里有非 disabled 条目，**每一轮对话都会在落盘阶段失败**（DSH Desktop 2.0.15 / 内核 `@deepseek-ai/dsh-* 0.1.7-rc.2`，2026-09-28 实测当日 42 次报错，手动会话 turn 1 step 1 与定时任务 turn 1 step 0 同样中招；同一轮次里另一个元凶是 `@opendsh/dsh-plugin-scheduled-tasks`，不属本仓库）。现在 source 是 `{kind:"plugin:dsh-skill-mcp-manager"}`：它正是内核 v3→v4 边对未登记第三方插件名的回退产物（`producerKind()` → `` `plugin:${plugin}` ``；`RENAMED_PRODUCERS` / `RELEASED_SAME_NAME_PRODUCERS` 里都没有本插件），所以旧日志迁移后与新写入逐字同形。`visibleCatalogText` / `pendingCatalogText` 的判据同步改为**只比 `source.kind`**（不再读 `source.plugin`）——否则旧会话里已被迁移的目录消息认不出来，会退化成每轮重复注入。GUI 上唯一可见变化：上下文注入卡片的来源标签由 `plugin` 变成 `plugin:dsh-skill-mcp-manager`，SourceFields 里那行 `plugin = dsh-skill-mcp-manager` 随之消失（`kind` 本身照旧永远隐藏）。测试：`test/catalog-smoke.mjs` 增两条回归守卫（kind 不得是裸 `"plugin"`、source 不得带 `plugin` 成员）。

## [1.1.7] — 2026-09-24

### Security

- **本地程序不再继承这台电脑上的密钥和 `DSH_` 变量**。stdio 子进程的环境与自带客户端的 `scrubbedParentEnv` 对齐：名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量、以及 `DSH_` 前缀（大小写不敏感）不继承。这个工具上特意填写的值仍会盖过同名项。远程地址的工具不走这条路。
- **配置里的 `$NAME` 在启动本地工具时换成环境真值**。只认整段就是 `$NAME` 的写法；环境里没有这个名字时换成空字符串，不把原文交出去。带前缀、后缀或 `${NAME}` 的仍按字面值。
- **管理页的读和写都拒绝来路不明的浏览器**。带 `Origin` 的请求必须同源，并且主机名是 localhost、本机名或直接写的 IP。局域网主机名要写进插件设置里的允许名单，默认空。不带 `Origin` 的调用保持原样。名单和「模型登记本地程序」的三档开关都在能力库设置页，不进安装配置。
- **模型新加或修改要执行的本地命令时先问人**。默认跟随当前对话的 DSH 权限：完全权限直接放行，工作区可写和只读先问。另两档是每次都问、始终放行。问的时候能看到程序、参数，以及之后还会再被启动。没有询问通道就保持静默放行；通道在但本会话把审批关掉时，宿主的拒绝会导致不保存、不启动。改备注、只改档位、换远程地址、从系统配置导入、在管理页里改，都不问。

### Fixed

- **MCP 工具结果不再把图片换成占位文本**。eager 和 `mcp_call` 改用宿主 `dsh-mcp-client` 的同一套投影：返回值保留原始 `content` 和 `structuredContent`；模型正文只放文本、`resource_link` 的名字和 URI，音频和内嵌 resource 用宿主那句说明。图片只在格式、当前模型的图像输入和附件库都通过时，按原位置交给模型；否则说明原因，原始数据留在返回值里。`isError` 里的图片不送进模型。`mcp_register` / `mcp_load` 仍只回文本。测试：`test/mcp-result-smoke.mjs`。
- **`/mcp prepare-uninstall` 会真正把托管条目交还原生客户端**，效果与 `/prepare-uninstall` 相同。`/mcp` 后面写了认不出的话会提示用法，不再静默列出服务器。不带参数的 `/mcp` 仍是列出服务器。
- **连不上的常驻工具不再每句话都重试**。配置没变且本会话已经挂好时，这一轮不再拆掉重挂。这一轮没连上就记为连接失败，档位仍是常驻，管理页标明按按需处理，后续回合不再干等。刷新快照或在对话里加载成功后恢复自动挂载。人改了命令、参数、环境或工作目录后会清掉失败状态并马上再试。只影响常驻。
- **系统配置备份只留最近 5 份**。
- **对外报的 MCP 客户端版本改为 `package.json` 的发行版本**，不再写死 `0.1.0`。
- **测试不再写死 `D:/Github/...`**。`session-audit` 原本已经换过。
- **删除条目不再被自己的影子行吸回来**。以前删掉后，同一次 reconcile 会把补丁里还没重写的托管行当成新手写配置，以「关闭」档重新加入。被删行的 id 在本次进程内不再吸收。

## [1.1.6] — 2026-09-23

### Fixed

- **npm 包缺 `lib/session-audit.js`，1.1.5 安装即无法加载（issue #5）**：1.1.5 的 `files` 白名单漏了当版新增的 `lib/session-audit.js`，而 `lib/index.js` 顶层 import 它——所有从 npm 安装的 1.1.5 启动即报 `ERR_MODULE_NOT_FOUND .../lib/session-audit.js`，整棵插件树加载失败（本地 `link:` 安装与仓库内测试都感知不到，文件在源目录里存在）。现把该文件补进 `files`。publish.yml 同步补上发布基线清单里已有、但工作流漏列的 `session-audit-smoke.mjs`。

## [1.1.5] — 2026-09-14

### Added

- **历史会话审核（只扫描提示，不修复）**：改掉写入格式只能保证"以后不再产生坏数据"，救不回已经落盘的旧会话。审核只读扫描 `~/.dsh/sessions` 里 v0 命名的日志，**由第一个 UI 请求触发**——启动路径里什么都不排：一次全量扫描本机 30–136 秒、单帧解压最长卡主线程 1.1 秒，而桌面端 host 的 `host-boot` 看门狗约 120 秒，插件的加载又发生在启动早期，所以 `await` 与 `setTimeout(8000)` **两种排法都落在窗口内、都会把 DSH 打进安全模式**（2026-09-14 两次实际发生）。以请求为触发点则天然安全：页面在问就说明 App 已经起来；`kick()` 每进程只跑一次，客户端在扫描进行期间轮询（答案落地即停）。检出受影响会话后在「设置 → 能力库」顶部显示提示、并弹浮层通知。浮层按状态分三种：**扫描中**报"正在检查、若历史会话较多请耐心等待、一次性动作"，并提醒**扫描期间历史会话目录可能暂时打不开**（可关闭，**关掉不中止检查**）；**有问题**报"有 N 个会话受影响"，设置页横幅同时展开完整说明；**没问题**报"没有会话受影响，请放心使用"，让这一次检查有始有终。**"结果"只在"本次进程里真的扫过"之后报一次**（宿主回报 `checked`，客户端据此判断；不写宿主状态，也不靠浏览器标记——浏览器每次重启都是全新会话存储，"已报过"跨不过一次重启），否则退休之后每次开机都会把"没有会话受影响"这个旧结论当新闻再报一遍（2026-09-14 真机踩到）。**三种提示各用各的"已展示"标记，绝不共用**：横幅与浮层是两个各自持有状态的组件，共用同一个标记会互相抵消——先挂载的那个写下标记，另一个读到时就被判成"已经报过"，于是两边都不显示（2026-09-14 真机踩到：只有"正在检查"，结果与横幅都没有）；横幅的显示只由宿主状态决定。关闭写在浏览器会话存储里而不是组件内存里，所以"本次不再显示"关掉后刷新真的不会又冒出来。整个机制只有记录文件里的一个布尔 `check`：只有显式的 `true` 才扫；扫到受影响就保持为真并重新提示；扫到 0 就把它改假、以后不再扫，但仍报一次"没有受影响"——这一条同时让"已修好"和"从来没有过旧日志"的机器都不再付扫描成本。宿主明确回报 `scanning` / `done` / `checked`；没有前两个的区分，"还在扫"和"永远不会再扫"在界面上一样，一台从没出现过旧日志的新装机就会被显示成"正在检查"并且永远等不到结果。schema-1 老记录按 `dismissedAt` **迁移**而不是丢弃：丢弃会让已经答复过的机器重启重扫，而一个重到会被杀死的扫描又写不完记录，就是死循环。只读，绝不写任何会话日志。**插件到提示为止：不附带修复脚本、不提供修复命令、不做自动修复**——修一批已落盘的会话是一次性、临时的活儿，为它往插件里塞可执行物会把一次性需求变成永久复杂度；修复由用户把报错交给 AI、由 AI 动手。修复脚本只放**仓库**一份（`tools/repair-legacy-sessions.mjs`），由 issue #2 指向它，**不随 npm 包发布**（`.npmignore` 排除，实测 `npm pack` 里没有任何 `tools/` 条目）：要修的人从 GitHub 取原文，装插件的人不会顺带得到它。测试：`test/session-audit-smoke.mjs`（含启动路径回归守卫、`running()`/`checked()` 三态断言、客户端"只报本次真扫过的结果 + 各用各的标记"守卫、老记录迁移）。
- **修复指引 issue**：https://github.com/alone-tree/dsh-skill-mcp-manager/issues/2 —— 含报错原文（供 AI/搜索命中）、根因与交给 AI 的处理说明；设置页横幅指向它。

### Fixed

- **注入 source 改用内核已认识的插件归属形态，历史会话不再整体打不开**：`mcp-catalog` 是插件自定义的 `source.kind`，既不在内核 released 迁移边的封闭集合（v2→v3 `SOURCE_KINDS`，15 个内置 kind）里，也不在 v0→v1 `pluginSourceValue` 允许的成员集内。DSH 桌面端 2.0.9 起打开旧会话必然走 v0→v3 迁移链，因此本机 574 个 v0 会话中 **552 个整体打不开**（`cannot safely transform unclassified message source`），而插件在 v3 新会话里一切正常——被拒的只有迁移这一条路径，因为 v3 读写不审计 kind（2026-09-11 事故）。现改为 `source: {kind:"plugin", plugin:"dsh-skill-mcp-manager"}`：`plugin` 是内核 `MessageSourceMap` 里正式建模的第三方插件形态，只带 `kind`/`plugin` 两个成员，落在每一条 released 迁移边的准入集合内。

### Changed

- **目录注入的判据从 digest 改为注入正文本身**：`plugin` 源只放行 `{kind, plugin}` + `form`/`sections`/`summary`，`digest` 无处安放；而 digest 本就只是 entries 投影的哈希形式，正文（同一份 entries 渲染而来）已随消息 content 持久化，属冗余副本。现在可见性判定取会话 surface 上仍可见的最新一条本插件目录消息，把它的正文与此刻渲染出的正文逐字比对，相同则跳过。业务行为不变：该注入才注入、压缩后重新追加、人类展开看到的仍是模型原文。副作用：2026-09-11 就地修复过的 552 个历史日志正是本形态，插件重新认得它们，续聊不再多注入一次目录。测试 mock 改为回写完整 message（content + source），并新增「source 无正文不得算可见」「他人 source 不得算本插件目录」「已修复的历史日志必须认得」三个用例。

## [1.1.4] — 2026-09-07

### Fixed

- **mcp-catalog 每轮重注（真机 bug）**：可见性判定读取了宿主 Session 上不存在的 `events` 属性（公开 API 是 `eventAt`/`seq`/`snapshotEvents`），导致 `visibleCatalogDigest` 恒为空、每轮对话都重新注入目录。现对齐内建 skill-catalog 模式：`session.eventAt` 倒序遍历持久日志、对 surface 上仍可见的最新 `mcp-catalog` 读 digest 字段对比（digest 缺失/损坏的记录视为「非本插件目录」）。测试 mock 同步改为真机 Session 形状——此前 mock 模拟了不存在的 `session.events` 数组，测试绿而真机每轮失效。

### Changed

- **注入零双重标准**：mcp-catalog 不再声明宿主的结构化 `form: "catalog"`（该表单只渲染 name+description 两列瘦摘要，且多数服务器无自报描述，人类展开只看到一列名字）——缺省/未知 form 由宿主 OpaqueBody 渲染模型正文原文，人类展开「上下文注入」卡片看到的就是模型收到的原文。source 收缩为 `{kind, digest}`：OpaqueBody 的 SourceFields 会显示 source 全部字段，此前携带的 entries JSON 会把同一信息渲染两遍（人类比模型多看一遍冗余）。注入正文与 digest 由同一份 entries 投影派生。升级后首轮会重新注入一次，之后恢复按需注入。

## [1.1.3] — 2026-09-07

### Added

- **`mcp_call` 参数形状守卫**：`tool` 缺失/非字符串、`args` 非对象（含数组/null）在桥接入口直接拒绝，报错附正确调用形状 `{"name","tool","args"}`，不做自动解包。真机实测：当前 DSH 宿主会对未通过工具 schema `required` 校验的调用先清洗参数再传给 handler，所以真实环境下主要由"缺 `tool`"分支拦截；"工具名嵌进 args"的错位形状识别保留为防御性分支（mock 测试直接调 handler 可达）。背景：issue #1（-32602 Invalid request parameters）的根因是调用参数形状错误而非桥接信封 bug——旧宿主+旧插件组合下 `{tool, args}` 被原样塞进 `arguments`，`params.name` 序列化丢失。
- **工具调用错误附上下文**：两类失败路径的错误消息统一追加 `called MCP tool: <server>/<tool>` 与实际发送的 `arguments` JSON（各截断 2000 字符）：① 协议层失败（-32602/-32603/超时等，另附该工具 `inputSchema`）；② 服务端 `isError` 业务错误结果（如"未知工具"——真机实测 Tavily 对未知工具走的就是这条路径，不附 inputSchema，模型刚 `mcp_load` 过已有 schema）。on-demand 桥与 eager 原生 `execute` 两条路径均生效，模型可对照"实际发送了什么"自我修正。代价：单次失败响应最多附加约 4 KB。测试：`test/mcp-call-guard-smoke.mjs`（新增，发布基线同步更新）。

### Fixed

- **`mcp_load` 返回与工具快照补回 `inputSchema`**：`snapshotTools` 与 eager `ensureEager` 此前把工具快照裁剪成 `{name, description}`，导致 `mcp_load`（load/peek 两条路径）与 `registry.json` 持久化快照自 M0 起永远不含参数结构——工具 description 声称 "parameter schemas"、设计文档写明 "return 完整定义"，但渲染层拿不到数据，模型只能靠调用报错反推参数（多动作型工具受影响最重）。现在快照保留服务器自报 `inputSchema`，`mcp_load` 逐工具渲染参数结构，`registry.json` 同步持久化；`mcp-catalog` 目录注入保持只含名称+描述不变。测试：`test/mcp-load-schema-smoke.mjs`（新增，发布基线同步更新）。

## [1.1.2] — 2026-09-02

### Added

- 技能管理页头部计数显示模型可见数量：「N 个技能 · 模型可见 M 个」。M 由前端按每条 Skill 的 `modelInvocable` 过滤得出，随启停操作刷新，关闭部分技能后不再只显示总数。

### Fixed

- Skill 模型可见性开关成功后仅局部更新对应行，不再全量刷新列表或显示成功提示，滚动位置保持不变。

## [1.1.1] — 2026-08-31

### Fixed

- MCP 接管改为**全量合并架构**：吸收阶段扫描整个补丁文件并按行 id（systemEntryId）认领，未认领行吸收进注册表；托管块由注册表整体重生成（每条目恰好一行、disabled，重复 loader id 拒绝写盘），托管块外被认领的原生行从原位置移除（空 insert 块一并清理，非 MCP 内容原样保留）。修复"重命名 MCP 后重启出现同 id 双 insert、DSH 无法启动"的故障类——改名、手写新行、serverName 漂移均安全。测试：`test/import-smoke.mjs`（新增改名安全与重复 id 自检用例）。
- `prepare-uninstall` 把托管块整体交还：所有条目以完整、启用的 insert 写回，disabled 档保留 disabled，不再遗漏。

## [1.1.0] — 2026-08-31

### Added

- MCP 按会话隔离运行实例：同一配置在每个 DSH 会话（含子代理）各自启动 stdio 子进程或 HTTP 连接；eager 工具注册到该会话的 `agent.ctx`。`mcp_load` / `mcp_call` 只作用于当前会话的实例。真机验证：双会话独立进程、并发读取互不干扰、子代理实例随会话自动回收。测试：`test/session-isolate-smoke.mjs`。
- 管理页删除「已连接」「断开」，原「加载」改为「刷新快照」：一次性试连并更新 `registry.json`，不留下运行实例。
- README 补充按会话隔离特性与工具面会话级语义说明。

## [1.0.1] — 2026-08-28

### Added

- MCP 单工具启停：每个条目以 `disabledTools` 黑名单持久保存禁用工具，新发现工具默认启用。管理页在每个工具名前增加“启用/禁用”二档下拉框，禁用项文字变灰。
- 禁用工具不进入 eager 原生注册、`mcp-catalog` 或 `mcp_load`/peek 返回；`mcp_call` 与 eager `execute` 在实际调用前强制检查黑名单，历史工具名或旧 schema 无法绕过。已开始的调用不强制中断。测试：`test/tool-disable-smoke.mjs`。

### Fixed

- 上下文压缩后 `mcp-catalog` 不再注入：改为按会话 surface 上可见的 digest 判断是否重注（对齐内建 `skill-catalog`），不再用进程内 WeakMap。压缩把旧目录移出 surface 后会重新追加。测试：`test/catalog-smoke.mjs`。
- 管理页 Skill 列表看不到 AI 能看到的 Skill（如经 `~/.dsh/skills` Junction 接入的 `capability-entry`）：内建 `dsh-skill-filesystem` 挂在 agent preset 层，`listSkills` 改为用 `agentPresets.standingKeyFor()` 作为 `ctx.skills.list/get` 的 scope。

## [1.0.0] — 2026-08-19

### Added

- **Client UI (能力库 / Capability)**:
  - A single Settings section ("能力库") with **SKILL** and **MCP** tabs.
  - SKILL management: frontmatter model-visibility switch, open in system editor, cross-platform delete (recycle bin / trash). Shipped/read-only skills (under `node_modules`/`app.asar`) are view-only.
  - MCP management: tier switching, entry details, secret masking/reveal, load / peek / disconnect, delete entry. Adjustable **tool-description truncation** in the UI (persisted to `settings.json`, hot for the catalog).
- **Native MCP import + takeover** (`importNativeMcp`, default on): on boot, every `@deepseek-ai/dsh-mcp-client` row in the profile's `cordis.patch.yml` is imported into the registry (on-demand by default; already-disabled stays disabled) and taken over via an id-targeted `disabled: true` override — the capability library becomes the single entry point after one restart.
- **Boot warm-up**: entries without a cached snapshot (or without fetched metadata) are connected once, concurrently, to capture real tool names/descriptions — the catalog is useful from the first session.
- **Server metadata capture**: the initialize handshake's `serverName / serverVersion / serverTitle / serverDescription / websiteUrl / instructions / capabilities` are stored per entry (read-only) and surfaced in `mcp_load` and the UI. `metaFetchedAt` tracks when metadata was last attempted.
- **Tool descriptions in the catalog**: each tool is listed with its (truncated) description — the model can see what a tool does without `mcp_load`. Truncation default 150 chars (`toolDescriptionMaxLength`).
- **Removed the local `description` field**: `mcp_register` no longer takes a `description`; descriptions come from the server (`serverDescription`). `notes` is documented as user-maintained and never overwritten.
- Documentation: `AGENTS.md`, screenshots in README, `CHANGELOG`.

### Fixed

- `webServer` is acquired via `ctx.inject(["webServer"], …)` (it is provided lazily); a synchronous `ctx.get("webServer")` returned `undefined`, so routes never registered and the browser received the SPA fallback instead of JSON.
- `webServer.register` rejects duplicate `(kind, path)`: the `GET`/`POST /skill-mcp-manager/settings` routes are now one handler dispatching on method (previously the POST returned 405).
- Tests now run against an isolated profile (`__test__`) with `importNativeMcp: false`, so they no longer mutate the real web/desktop `cordis.patch.yml`; the import test uses a local dead-port URL to avoid real network calls.

## [0.1.2] — M1/M2 backend

### Added

- **M1 Skill**: recursive skill provider that scans `customRecursiveDirs` for `<dir>/SKILL.md` at any depth (including the root directory itself), parses YAML frontmatter (mirroring dsh-skill-filesystem), and derives kebab-case names from the relative path when `name` is absent.
- **Watcher**: `fs.watch` on configured roots with a 200ms debounce → `control.invalidate()`, so added/edited/deleted skills are re-discovered without a restart.
- **M2 reconcile**: writes a `disabled: true` shadow entry per active (non-disabled) registry entry into the profile's `cordis.patch.yml`, so config survives uninstalling the plugin as a static dsh-mcp-client fallback. Writes only on change, with a `.bak-<timestamp>` backup.
- **`/prepare-uninstall` command**: hands managed entries back to the native dsh-mcp-client (drops `disabled: true`) before uninstalling the plugin. Registered via `ctx.commands` when available.

### Fixed

- Discovered a skill located at the recursive root itself (e.g. `global-skills/SKILL.md`), which the initial scan missed.

## [0.1.0] — M0

### Added

- `registry.json` (version 1) as the authoritative MCP registry.
- Three tiers: `eager` / `on-demand` / `disabled`.
- Model-facing tools: `mcp_register` (trial-connect + persist), `mcp_load {name, peek?}` (load/hot-reload), `mcp_call {name, tool, args}` (on-demand bridge).
- Pre-step `mcp-catalog` injection (digest-driven, append-only).
- Eager native registration as `mcp__<server>__<tool>`; on-demand via the `mcp_call` bridge (prefix-stable).
