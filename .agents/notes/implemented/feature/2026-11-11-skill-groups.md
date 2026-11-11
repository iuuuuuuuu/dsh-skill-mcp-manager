# Agent Note: 技能列表按来源分组（系统 / 插件）

Status: implemented

## Problem

能力库的技能页把所有技能平铺成一张卡片网格。用户看不出「哪些是我自己的、哪些是某个插件塞进来的」，也就没法按插件整体处置；而「插件塞进来的」恰恰是最需要整体关闭的一类（装一个插件就多几个技能，关起来要一个个点）。用户给的排版是：一个「系统」组，之后每个插件一组，插件组默认折叠、组头带一个总开关，关掉就让该插件下的技能全部不可见。

## Decision

分组键是 provider，不是路径：

- `filesystem` / `skill-mcp-manager-recursive` → 「系统」组（内建 filesystem provider 读的 `~/.dsh/skills`、`~/.agents/skills`，以及能力库自己扫的 `customRecursiveDirs`）。
- 其余任何 provider 名 → 插件，一个 provider 一组。

路径只用来给组起名字：先看 `node_modules` / `app.asar` 段，再向上找最近的 `package.json`，并要求技能位于 `<pkg>/skills/` 下（否则用户仓库的 package.json 会被当成归属）。`link:` 安装的插件落在 node_modules 之外，只有后一条规则能认出它，所以两条都要。

组开关是一次批量写：`POST /skill-mcp-manager/skills/toggle-group {provider, enabled}` 把该 provider 下所有**可写**技能的 `disable-model-invocation` 一次写好/删掉；随包只读（路径含 `node_modules` / `app.asar`）的**绝不写**，放进 `skipped` 回报，全组只读时前端把开关置灰并写「随包只读」。

## Alternatives considered

- **按路径分组**：最直观，但错得离谱。`dsh-windows-acl` 每次启动把 SKILL.md 写到一个新的 `%TEMP%\dsh-acl-skill-*` 目录，按路径会把它算成用户技能，而且每重启一次就多出一个「新组」。provider 名字才是稳定的。
- **前端自己分组**：provider 与包名解析都要读文件系统（找 package.json），client bundle 没有 fs 也没有权限；放 host 端一次算清更省。
- **组开关逐条复用 `/skills/toggle`**：N 次往返、部分失败时状态难解释；一个批量接口才能给出准确的 `updated/skipped`。
- **组开关连只读技能一起「关」并提示失败**：会让「整组已关」变成一句谎话——技能根本关不掉。宁可置灰 + 明说。
- **系统组也给一个总开关**：那等于「把所有自己的技能一次关掉」，风险高、需求没提；保持无开关。

## Consequences

- 组名对 `link:` 插件依赖它自己的 package.json；包名缺失时退回 provider 名（`插件 · agent-notes`），不影响分组正确性。
- 插件组默认折叠，折叠状态只存在于本次页面（不落盘）；重开页面回到默认。
- 组开关一次写多个文件，中途失败会停在那里并把错误抛到横幅；已写的保持已写（与逐条开关一致，不做事务）。
- 第一版踩过一个坑：`nearestPackageName` 里用 `const relative = relative(dir, path)` 遮蔽了导入的 `relative`，TDZ 异常被 `catch` 吞掉，包名永远是 null 而测试全绿。现在 `catch` 只包 `readFile`，并且测试里加了一条 `link:` 布局的断言专门守它。
- 测试：`test/skill-group-smoke.mjs`（provider 分类、组开关写真实文件并逐字节还原、只读跳过、系统组与未知 provider 拒绝）；三处故障注入均能打红（全归系统 / 去掉只读护栏 / 去掉 provider 过滤）。