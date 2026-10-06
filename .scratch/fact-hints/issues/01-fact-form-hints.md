# 01: 事实化提示家族 + 50/100 节拍 + 遵从率指标

Status: resolved
Type: task
Spec: .scratch/fact-hints/spec.md
ADR: docs/adr/0002-fact-form-hints.md

## 任务

1. drift-guard.ts:四条提示文案事实化(statusHint/reviewHint/docHint/steerHint);
   STATUS_EVERY 50 / REVIEW_EVERY 100;extractNow/quote/isDirectNavWrite;
   双时钟(lastNavWriteTurn/lastActualReviewTurn);工具描述同步 50/100。
2. 单测:T7/T8/T10/T12 适配新节拍与新文案;新增 T20 哲学红线 / T21 直接写重置
   陈旧事实 / T22 读失败降级 / T23 回顾对照物 / T24 转向无文档降级。
3. trace-report.mjs:新前缀 + 旧前缀兼容 + --compliance。
4. 文档同步:README(行为规格/术语/决策记录/测试数)、VERIFY.md 触发表、根 README。

## Answer

全部完成(2026-10-06):

- drift-guard 套件 24/24、system-inject 套件 12/12(T20 哲学红线固化:四类提示
  均无 建议/请/必须/应该/务必)。
- --compliance 对旧 tsecbench 会话复算:23/132 = 17%(基线入档,口径说明见 ADR)。
- 实机 E2E:checkpoint 调用正常落盘,工具声明含 checkpoint,探针链路无损。
- 证据与复现命令见 test-plan.md。
