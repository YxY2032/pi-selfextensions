# Spec: 引导加固(ADR-0005)

Status: resolved
ADR: docs/adr/0005-bootstrap-hardening.md

## 任务

1. 建档提醒进消息通道(sendMessage);文案带绝对路径与"只从运行目录读取"。
2. 锚引导骨架、checkpoint 工具描述写明位置("运行目录根,勿放子目录")。
3. 空文档回顾事实:无文件时 review 到期降级为事实句,每 100 轮一条,
   建档即止;非旧提醒复读(T30 断言)。

## Answer

全部完成(2026-10-08):套件 42/42(drift-guard 30 + system-inject 12);
T9/T20 适配消息通道,新增 T30。1008b 已止损入账(RESULTS.md)。
阶段二(每 150 轮重申)按 ADR 搁置,待本场实测后裁决。
