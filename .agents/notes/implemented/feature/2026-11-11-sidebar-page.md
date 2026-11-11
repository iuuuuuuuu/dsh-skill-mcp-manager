# Agent Note: 能力库注册成侧边栏页面

Status: implemented

## Problem

用户的原话是「然后我还要能注册到这个侧边栏」，配图是侧边栏的「插件 / 自动化任务 / 更多」三行。在这之前能力库只挂在 `settings.section` 上：要改一个 MCP 档位，得先开设置、滚到「能力库」。而 DSH 的侧边栏行是宿主的全局页面座位，插件装好就该像「插件」那样一点就到。

## Decision

注册宿主的两处座位，**内容复用同一个 `ManagerSection`**（一份实现两处渲染，不复制界面）：

- `sidebar.panellist`：`{ id: "skill-mcp-manager", order: 5, label: "能力库" }`，render 收到 `owner.size`（16），画一个 16px 的双层卡片线条图标，跟随 `currentColor` 与相邻行的线条重量一致。
- `main`：`{ key: "skill-mcp-manager" }`，渲染 `CapabilityPage` = `.smx-page` 外壳（顶带留白 `calc(28px + var(--dsh-frame-top-clearance,0px))`、居中列宽 `max(max(16px,min(4vw,48px)), 50% - 480px)`、自己管滚动）+ `ManagerSection`。

三条硬边界：

1. **惰性注入，绝不直接注册**：`ctx.slots.inject("main", () => ctx.slots.inject("sidebar.panellist", …))`。老宿主不声明这两个 slot 时整块静默不注册，设置页那条入口照旧——同步注册在不支持的主机上会抛错，而「单个插件加载失败 → 整棵插件树失败 → 安全模式」是这个项目已经踩过两次的坑。
2. **先面板、后行，失败要回滚**：行被拒绝时把面板撤掉，不允许留下一个没人能选中的 `main` 面板。
3. **卸载时先离开面板再撤座位**：`ctx.inject(["layout"]) ` 拿到 `layout`，清理时若 `panelInfo.getSnapshot().activePanelId === PANEL_ID` 就 `selectPanel(null)`，否则宿主会停在一个空白主区域。

## Alternatives considered

- **只加一行 sidebar.footer.action（侧边栏底部图标按钮）**：更省事，但那是 footer 的一个动作位，不是「页面」；用户给的参照物就是「插件」那种整行页面。而且旧 DESIGN 里写的 `sidebar.footer.action` 在这版宿主里并不是可用入口。
- **在侧边栏行里直接嵌抽屉/弹窗**：行只能选面板，宿主没有「点一行就开弹窗」的公开契约（dshmarket 的注释也写明「settings-dialog shortcut is not possible」）。
- **复制一份页面组件**：会把「卡片 + 检测」这套逻辑变成两份要同步维护的实现；`.smx-page` 外壳只负责布局，`ManagerSection` 本体不需要知道自己在哪儿渲染。
- **加一个「是否显示侧边栏行」的设置**：dshmarket 这么做是因为它的行默认关闭、且用户可能只想留设置入口；本插件的页面就是主入口，多一个开关只是多一个要解释的状态。

## Consequences

- 侧边栏行的位置由 `order: 5` 决定，实测落在「插件」与「自动化任务」之间；宿主以后调整自家行的 order 时要回来看一眼是否还挨在一起。
- 页面与设置页可以同时存在两个 `ManagerSection` 实例（各自的状态、各自的检测并发），这是有意的：它们读写同一份宿主注册表，各自刷新不影响对方的数据正确性。
- 清理分支（`layout.selectPanel(null)` + 撤座位）是防御性的，**本轮没有在真机上触发过**（需要宿主卸载插件）；它被 try/catch 包住，最坏情况是留下一个空主区域而不是抛错。
- 图标是手写 SVG（client bundle 只能 `require("react")`，拿不到宿主 primitives 里的图标组件）；换成宿主图标要等 client 允许 import 宿主包。
- `data-dsh-part="capability-sidebar-icon"` 留给测试与调试定位。