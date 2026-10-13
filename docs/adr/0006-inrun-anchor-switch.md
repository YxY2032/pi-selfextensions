# ADR-0006: 锚的 run 内形态切换——文件创建即刻注入 Goal

日期:2026-10-13
状态:已实施(实测验证通过)
前置:ADR-0005(引导加固);靶场十场实测数据

## 背景

靶场全部是单 run 马拉松(一次提示词跑到底),`before_agent_start` 只触发一次。
锚的形态在 run 开始时冻结:开局无文件 → 引导形态;即使第 9 轮建了文件,
Goal 也**永远进不了系统提示词**——必须等用户发第二条消息(第二次
before_agent_start)才切为状态形态。靶场数据:第二场 Goal 仅由节拍提示
(每 50 轮一条消息)承载,锚全程为引导形态。

用户裁决:这是最严重的结构缺陷,必须修复——文件创建即刻注入 Goal。

## 决策

**利用 `event.systemPromptOptions` 的活引用特性,在 `tool_result` 钩子中
原地改写 `forceSystemPrompt` 字段,使下一个请求立即使用状态形态。**

机制:宿主 transformContext 每次请求从同一对象上现读
`_runSystemPromptOptions?.forceSystemPrompt`。before_agent_start 的
`event.systemPromptOptions` 就是这个对象的引用——持有它,在文件出现时
改写 `.forceSystemPrompt` 字符串,下一个请求即生效。

## 实现(index.ts)

1. before_agent_start:保存 `event.systemPromptOptions` 引用 + 锚追加前的
   基底 prompt(preamble 已注入)+ 开局时文件是否存在
2. tool_result(新增,index.ts 侧):文件从未有→有 且开局无文件 且未切过
   → 以 buildAnchor(ctx)(此时文件存在,返回状态形态)重建,
   写入 `liveOptions.forceSystemPrompt = promptBeforeAnchor + "\n\n" + anchor`
3. 每 run 仅切一次(anchorSwitched 标志);开局已有文件则 before_agent_start
   本身就返回状态形态,无需切;PI_DRIFT_GUARD=off 不触发。

## 验证

- 单测 T13/T14/T15(45/45 全绿):切换正确性/已有文件不重复切/off 不触发
- **实机 E2E**:模型 echo 20 次 → write PROGRESS.md → echo done,
  探针捕获到 `[system-inject] 锚已切换为状态形态(run 内,文件创建即刻)`,
  systemdump 尾部出现 `## 任务导航\n# 测试`(状态形态含标题)。

## 被否决的替代

| 方案 | 否决原因 |
|---|---|
| 等 before_agent_start(现状) | 单 run 马拉松全程不触发,Goal 永不进提示词 |
| before_provider_request 改写 payload | 需要感知 provider 格式(OpenAI/Anthropic 不同),脆弱 |
| 每个 tool_result 都重建锚 | Goal 变化会核销缓存;本方案仅在文件首次出现时切一次,缓存只失效一次 |
