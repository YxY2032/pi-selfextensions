# Spec: 节拍提示投递通道升级(轮边界消息)

Status: ready-for-agent
Date:2026-10-06
ADR: docs/adr/0004-hint-channel.md

## 问题

事实化提示在 tool_result 尾巴位置遵从率 59%:流中送达全无视、边界送达秒遵从,
注意力位置是残余未遵从的主要嫌疑;弱信号(工具耗时)与语义时机检测均被否决。

## 需求

- R1 status/review 提示经 pi.sendMessage(customType:"drift-guard-hint",
  triggerTurn)投递至轮边界;转向/建档提示维持尾巴通道(单变量纪律)。
- R2 PI_DRIFT_HINT_CHANNEL=tail 保留旧通道作对照。
- R3 trace-report 识别两种通道的提示(旧会话回归不变)。
- R4 提示形态不变(事实链/零祈使/标记与出处)。

## 验收

1. 套件 41/41(T7/T8/T20-T23 改验消息通道;新增 T29 旧通道对照)。
2. 旧会话 --compliance 回归仍为 13/22=59%。
3. 实机冒烟:checkpoint E2E 正常。
4. 测试场:下一场纯态靶场,对 59% 基线裁决通道增益与助推水分。
