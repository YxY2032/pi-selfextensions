# ADR-0001: 单一导航系统——pi-plan 退出启用集

日期:2026-10-06
状态:已接受

## 背景

本仓库长期并存两套"长任务导航"系统,同源同题(都为对抗工作记忆衰减,用转录外
状态存储 + 周期性重新呈现):

- **system-inject**:锚(读 `PROGRESS.md` 注入 Goal 到系统提示词尾部)+ drift-guard
  (checkpoint 工具 / 节拍器 / 转向确认);
- **pi-plan**:write_plan 工具 + 每轮把计划写入 `sections.plan_state` + 尾灯与 `/plan` 命令。

2026-10-06 诊断(方法与证据见 `system-inject/VERIFY.md`)证实:pi 宿主中
`before_agent_start` 返回 `systemPrompt` 即走 force 通道,宿主在每次 provider 请求时用
forced-prompt projection **整体替换** system message——pi-plan 写进 sections 的计划
写进了会话文件、到不了模型。四臂实验(仿制 sections 写入者 × 真实 pi-plan,单独
加载 × 同栈)全部符合该结论。也就是说,**自安装起 pi-plan 的每轮注入在本配置下
从未生效**;真实靶场会话(249 轮)中 write_plan 调用次数为 0,checkpoint 2 次、
节拍提示 32 次。

## 决策

**收敛为单一导航系统:system-inject。pi-plan 从启用集(settings.json packages)移除,
包体保留在仓库内作为存档。** 不迁移、不移植 write_plan。

## 理由

1. **preamble 决定了 force 通道不可放弃**:preamble(用户自加,设计上不可改动)需要在
   默认提示词中部原句后注入,只能整文替换(sections 通道拒绝名为 `preamble` 的节;
   `customPrompt` 会连坐删掉 tools/rules/docs 整段)。force 通道在,sections 注入就结构性死亡。
2. **实践已经投票**:真实工作量走了 PROGRESS.md 体系;pi-plan 注入死了数月无人察觉,
   恰说明其缺席无感知。
3. **less is more**:收敛后单一提醒源,消除两套导航的重复提醒;不移植未被使用的
   write_plan 是拒绝投机性复杂度。

## 被否决的替代方案

| 方案 | 否决原因 |
|---|---|
| 调换 packages 顺序(pi-plan 在前,其 sections 被 system-inject 渲染吸收进 force 整包) | 依赖隐式加载顺序,任何未来重排都会静默复发;且保留两套导航重复提醒,未收敛 |
| 锚改走 sections 通道 | 只解一半:preamble 仍需 force,压制依旧;复杂度不降反升 |
| 复用 pi-plan(把锚/drift-guard 迁入 pi-plan 包) | 丢弃 30/30 单测与实机验证过的实现;两种状态存储哲学(会话内 plan state vs 跨会话 PROGRESS.md 文件)强行合一,迁移风险大、功能零增益 |
| 把 write_plan 移植进 system-inject | write_plan 在真实会话中零使用,属投机性复杂度;若未来真需要步骤级执行清单,另立新 ADR |

## 后果

- `~/.pi/agent/settings.json` 的 packages 移除 pi-plan 条目(每台机器各自执行)。
- pi-plan 目录原样保留(代码、其自身 ADR 与测试),README 顶部加存档标注。
- 若未来出现新的 sections 注入型扩展:要么排到 system-inject 之前加载(脆弱,不推荐),
  要么重开本 ADR。
- 单测新增不变量:锚必须位于最终系统提示词的**尾部**(尾部锚定是近因对齐的载体;
  见 system-inject.test.mjs T12)。
