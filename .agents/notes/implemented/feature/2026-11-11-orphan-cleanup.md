# Agent Note: 残留 MCP 子进程清理

Status: implemented

## Problem

stdio MCP 服务器是子进程。宿主重启、激活失败、或用户手动中断时，`npx → cmd → node` 这条链会留下一部分甚至全部：本机一天下来攒了 40 个孤儿进程（其中一批来自 `mcp-sequential-thinking-2` 那个重复 serverName、永远激活失败的条目）。它们不连任何会话、白占内存，用户在任务管理器里也分不清哪几个是 MCP、哪几个是别的工具。

## Decision

把这个能力做进能力库（`lib/orphans.js` + `POST /mcp/orphans` + MCP 页的「清理残留进程」）：

- **候选来源只有两类**：注册表里的 stdio 条目，和插件注入的 loader 行（`@deepseek-ai/dsh-mcp-client`）。不扫全系统。
- **签名要够特异**：专用二进制取完整路径 + basename；通用解释器（node/npx/cmd/python/pwsh…）只取「像路径或 npm 包」的参数，**绝不取裸解释器名** —— 否则 `node` 会匹配一切。
- **存活保护**：进程自身或其任一祖先属于运行中的 DSH（`DSH Tauri.exe` / `deepseek-harness-desktop` / `dsh/lib/bin.js` / `dsh-app-boot`）就保留；调用方自己的 pid 同样跳过。这条规则同时保护当前实例、其它正在跑的实例、以及用户正在用的连接。
- **两步动作**：默认 dry-run 只回候选列表，`confirm: true` 才 `SIGTERM`（1.5s 后补 `SIGKILL`）。UI 先列 pid 和命中的命令，确认按钮才出现。
- **跨平台**：Windows 只能靠 `Win32_Process` 拿命令行（`ps-list`/`tasklist` 系在 Windows 上 615 个进程 0 个带 cmd，试过 `ps-list@9` 后删掉了这个依赖）；POSIX 用 `ps -eo pid=,ppid=,args=`。

## Alternatives considered

- **用 `ps-list` 之类的现成包**：本来最符合「能用包就不手写」，但它 Windows 后端是 tasklist，没有命令行 —— 实测 615 个进程里 0 个带 `cmd` 字段，匹配无从谈起，所以只保留了两个平台各自的系统命令，把**匹配与保护判定做成纯函数**来测。
- **按进程名匹配（node.exe / mcp-server.exe）**：node.exe 有几十个，误杀面太大。
- **按「父进程已退出」判定孤儿**：Windows 上孤儿会被重新挂到 pid 1（或被回收），父 pid 不可靠；用「祖先链里有没有活着的 DSH」更直接。
- **自动在启动时清理**：启动路径只做必要且快的事（本项目有 120s 看门狗的历史教训），而且杀进程属于破坏性动作，必须由人确认。
- **前端自己调任务管理器**：插件拿不到系统进程表。

## Consequences

- 只清「本插件认识的命令」：别的工具链（比如用户自己起的 MCP）不会被误伤，也清不到。
- 签名是子串匹配：同一命令跑在两个不同项目下会一起被算作候选，但存活保护仍然生效。
- 进程列表要 spawn 一次 PowerShell/ps（约 0.3–1s），所以只挂在按钮上，不做定时扫描。
- 测试：`test/orphan-cleanup-smoke.mjs`（签名特异性 / 存活链保留 / 孤儿识别 / 空签名不误杀 / 路径归一化）；两处故障注入（去掉存活保护、让通用解释器贡献裸名字）都能打红。真机：用 WMI 造一个父进程不在 DSH 下的孤儿 → 扫描列出 → 确认后 PID 消失；另一个挂在 DSH 下的进程全程存活。