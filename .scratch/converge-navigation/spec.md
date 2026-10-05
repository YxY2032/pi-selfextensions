# Spec: 收敛两套导航系统为单一系统

Status: ready-for-agent
Date: 2026-10-06
ADR: docs/adr/0001-single-navigation-system.md

## 问题

system-inject 与 pi-plan 是两套同源同题的长任务导航系统,同栈启用时发生通道冲突:
system-inject 的 preamble 部件必须走 force 通道(返回整份系统提示词),宿主的
forced-prompt projection 会把 system message 整体替换,pi-plan 写入 sections 的
每轮计划注入从未到达模型(2026-10-06 四臂实验证实,见 system-inject/VERIFY.md)。
同时两套导航构成重复提醒源,违背 less is more。

## 需求

- R1 启用集内恰好一套导航系统:system-inject(锚 + drift-guard)。
- R2 pi-plan 包体保留在仓库内作为存档(代码、其 ADR、测试不删),README 加存档标注。
- R3 决策与证据可追溯:ADR-0001 + VERIFY.md 已在位,本 spec 引用之。
- R4 验证可复现:测试计划(.scratch/converge-navigation/test-plan.md)记录方法与结果,
  依赖探针与会话分析器。
- R5 system-inject 行为零变化:两套件保持 30/30。

## 非目标

- 不修改 system-inject 任何运行时行为(仅新增尾部锚定不变量的单测 T12)。
- 不移植 write_plan(ADR-0001:真实会话零使用,拒绝投机复杂度;需要时另立 ADR)。
- 不触碰任何靶场目录的 AGENTS.md(用户明确指示)。

## 验收标准

1. `~/.pi/agent/settings.json` packages 无 pi-plan 条目。
2. `pi list` 输出不含 pi-plan;实机请求探针:锚到达=true,plan_state 到达=false。
3. 两套件 30/30(含新增 T12:锚位于最终提示词尾部)。
4. 根 README / system-inject README / pi-plan README 与 ADR-0001 一致(无"同时启用"指引残留)。
