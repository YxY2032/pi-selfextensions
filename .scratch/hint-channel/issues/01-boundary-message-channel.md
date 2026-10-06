# 01: 节拍提示搬家至轮边界消息通道

Status: resolved
Type: task
Spec: .scratch/hint-channel/spec.md
ADR: docs/adr/0004-hint-channel.md

## Answer

全部完成(2026-10-06):

- 通道实测先行:临时扩展 sendMessage + 迷你探针验证——消息以 user 角色落在
  请求末尾(steer 同座),模型读到并照办(暗号复述)。
- drift-guard:onToolResult 注入 sendHint;到期提示经消息通道送出,
  工具结果不再被改写;tail 开关保留对照。
- 套件 41/41;旧会话回归 59% 不变(trace-report 双通道识别);
  实机冒烟通过(checkpoint E2E + 四节骨架)。
- 等待:下一场纯态靶场出裁决。
