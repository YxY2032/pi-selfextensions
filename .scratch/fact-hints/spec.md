# Spec: 事实化提示家族与节拍重调

Status: ready-for-agent
Date: 2026-10-06
ADR: docs/adr/0002-fact-form-hints.md
决议过程:grill-with-docs 四问全决(B+Goal 形态 / 判据 / 50-100 同船 / 四条统一)

## 问题

964 轮真实会话实测:节拍机制正常但祈使式提示遵从率极低(3 次 checkpoint + 4 次
直接写 / 132 次提示),模型提示后直接继续任务流;10/20 轮节拍过于紧凑(≈7.3 轮/条)。

## 需求

- R1 四条提示统一三要素事实化:数字事实 + 对照物引用(截断/来源标注/降级)+ 疑问句
  或判断权声明;零祈使句(T20 固化)。
- R2 节拍 50/100;建档阈值 15 不变。
- R3 双时钟分离:陈旧事实只被真实导航更新推进(checkpoint 或直接 write/edit)。
- R4 遵从率可自动度量:trace-report --compliance(窗口 25 轮,status/review 计入,
  建档/转向不计入;兼容新旧前缀以复算历史基线)。
- R5 checkpoint 落盘行为、锚、preamble 零变化。

## 非目标

- 不动锚与系统提示词(缓存红线);不上升级阶梯;不改靶场任何 AGENTS.md。

## 验收标准

1. drift-guard 套件 24/24(含 T20-T24);system-inject 套件 12/12。
2. --compliance 对旧 tsecbench 会话复算出 17% 基线(逐字口径,见 ADR 已知限制)。
3. 实机:checkpoint E2E 正常、探针链路无损、工具声明含 checkpoint。
4. 测试场 = 下一场真实靶场;判据三分(≥40% / 10-40% / <10%)按 ADR-0002 执行。
