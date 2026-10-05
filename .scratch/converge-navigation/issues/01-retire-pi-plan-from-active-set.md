# 01: pi-plan 退出启用集,仓库文档与 ADR 对齐

Status: resolved
Type: task
Spec: .scratch/converge-navigation/spec.md
ADR: docs/adr/0001-single-navigation-system.md

## 任务

1. `~/.pi/agent/settings.json`:从 packages 数组移除 pi-plan 条目。
2. 根 README:分类总览/目录结构/注意事项/多机同步中 pi-plan 改为存档表述。
3. `pi-plan/README.md` 顶部加存档标注(指向 ADR-0001)。
4. `system-inject/README.md`:末节"与 pi-plan 的关系"改为已收敛,路线图第 3 项完成。
5. 新增单测 T12(system-inject.test.mjs):锚位于最终系统提示词尾部(尾部锚定不变量)。

## Answer

全部完成(2026-10-06):

- settings.json 已移除 pi-plan 条目;`pi list` 确认启用集为 pi-subagents /
  pi-web-access / system-inject。
- 三处 README 与 ADR-0001 对齐。
- T12 加入并通过;两套件 30/30。
- 实机验证证据见 test-plan.md:锚到达=true、preamble到达=true、plan_state 到达=false,
  write_plan 工具不再注册。
