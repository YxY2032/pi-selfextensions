# 01: 三区制结构契约(受管节扩展 + 保留区)

Status: resolved
Type: task
Spec: .scratch/nav-structure/spec.md
ADR: docs/adr/0003-nav-structure-contract.md

## 任务

1. drift-guard.ts:分节解析(splitSections/reviewRanges/stripReviews)、
   三区制重建、成果/下一步受管节 + 占位提示、results/next 可选参数、
   改名容错、回顾解析收紧为编号锚定。
2. index.ts:引导形态骨架加成果/下一步与"自定义小节原样保留"承诺句。
3. 单测 T25-T28 + 全量回归。

## Answer

全部完成(2026-10-06):

- 套件 40/40(drift-guard 28 + system-inject 12)。
- 实机 E2E:种"已完成题目表 + 关键经验 + Now (最终) 改名"的真实形态文件,
  checkpoint(status + results + next)重建后:自定义两节原样保留并归位、
  改名 Now 被归并无双胞胎、成果/下一步正确替换、Goal 穿越。
- 模型按新参数表正确调用(工具描述引导生效)。

证据:/e/tmp/dg-adr3/PROGRESS.md(重建后全文见 test-plan.md)。
