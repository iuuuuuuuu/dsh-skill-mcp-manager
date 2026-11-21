# Agent Note: 按既有 tag 手动重跑发布工作流

Status: implemented

## Problem

fork 可能在首次 tag 事件后才启用 Actions，既有正式 tag 不会自动重放。需要复跑精确版本的发布流程，而不是改写已发布 tag。

## Decision

publish.yml 保留 tag push 触发并增加 workflow_dispatch 的必填 tag。Checkout 使用指定 tag；安装和发布前校验该 tag 与 package.json 的版本完全相等。手动路径执行同一套语法检查、全部发布基线和 npm publish，不跳过测试，也不把 GitHub Release 视为 npm 成功。

## Alternatives considered

- 删除再推同名正式 tag：能重新产生事件，但让消费者面对变化的发布引用，故保留既有 tag 不动。
- 只重跑本机 npm publish：可以绕开工作流事件问题，但依赖本机凭据且少了同一条 CI 验证链，故保留作为正常 CI 发布。

## Consequences

- 收益：按不可变发布源重跑，具备独立版本一致性检查；推 tag 和手动操作共享全部门禁。
- 代价：需在仓库启用 Actions，且 npm Trusted Publisher 或发布权限仍须单独配置；手动入口不创造包权限。

## Related notes

本条只改变发布流程，不改变[自有能力编辑](../feature/2026-11-21-own-capability-editing.md)的运行行为。
