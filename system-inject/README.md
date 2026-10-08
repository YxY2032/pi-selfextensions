# system-inject — 系统提示词注入扩展(注入与导航类)

一个扩展,三个部件:

1. **preamble 注入**(`index.ts`)——把任务执行者定位与 Response rules 投影进请求头部(自源码修改意图迁移,零构建生效);
2. **任务导航锚(防漂移)**(`index.ts`)——每次提问时读取工作目录的 `PROGRESS.md`,把任务目标注入系统提示词尾部,使模型在长链路任务中每轮都能重新对齐目标;
3. **防漂移·动态部件**(`drift-guard.ts`)——checkpoint 工具 + 节拍器 + 转向确认,把导航文件从"只读"变为"活的"。

preamble 与锚共用唯一的 `before_agent_start` 处理器。

**为什么必须合并为一个处理器**:`before_agent_start` 的 `systemPrompt` 返回值是单槽覆盖制
(runner 里 `forceSystemPrompt = result.systemPrompt`,后者覆盖前者),
多个扩展各自返回会互相清零——preamble 与锚必须在一个处理器内合成、一次返回。

## 术语表

| 术语 | 定义 |
|---|---|
| 导航文件 | 工作目录下的 `PROGRESS.md`;任务的单一事实源 |
| 锚 | 每次提问时注入到系统提示词尾部的导航文本 |
| 引导形态 | 导航文件不存在(或项目未信任)时,锚呈现的骨架引导文案 |
| 状态形态 | 导航文件存在时,锚呈现的标题 + Goal 注入 |
| Goal | 任务目标与完成标准;任务内稳定——锚只注入它,保住提示词前缀缓存 |
| Now | 当前状态;**刻意不进系统提示词**(见缓存分离决策),经消息流与文件承载 |
| 切换提示 | 锚尾常驻一行:新对话目标与导航不符时,以对话为准,覆盖 Goal |
| checkpoint | 阶段性导航维护工具(status/review 双模式);汇报自动落盘 PROGRESS.md 并格式归位 |
| 节拍器 | tool_result 点的节奏提醒:50 轮轻检查 / 100 轮深度回顾 / 无文档 15 次工具调用后提醒建文档(仅一次);间隔依据与降噪账见 ADR-0002 |
| 事实化提示 | 节拍到期的播报形态:事实链(陈旧数字 + Goal/Now/回顾对照 + 后果事实)+ 恰一个判断权声明或疑问句,全家族零祈使句(单测 T20 固化);详见 ADR-0002 |
| 遵从率 | 提示送达后 25 轮内发生导航更新(checkpoint 或直接写导航文件)的比例;`trace-report --compliance` 自动出数 |
| 转向确认 | 用户 steer 输入落地后的中性提示(附当前 Goal 作对照):方向变了就更新导航,只是细化就继续;硬/软由模型自判 |

## 行为规格

| 条件 | 锚内容 |
|---|---|
| 无文件 / 空文件 / 项目未信任 / `PI_DRIFT_GUARD=off` | 引导形态 |
| 文件存在且项目已信任 | 标题 + Goal 节(上限 800 字符,超出截断标注) |
| 文件存在但无 Goal 节 | 原文头部 400 字符兜底 |

- 信任门:未信任项目的文件内容**绝不进入**系统提示词(防仓库预埋注入)。`isProjectTrusted` 为同步 boolean(types.ts:1756,已核实)。
- CRLF 归一后提取;读文件失败显式上报(stderr),按无文件降级。
- preamble 部件不受 `PI_DRIFT_GUARD` 开关影响。
- 每次触发向 `/tmp/anchor-probe/` 写全量快照与审计日志(端到端证据);**滚动清理只保留最新 20 份**,文件名含 pid 防多进程碰撞。
- 无任何修改(开关关闭且原句未命中)时返回 `undefined`,不强制投影。
- 真实环境已验证:任务切换时模型会依据锚尾提示自行覆盖 Goal(含自发状态落盘)。

### drift-guard(checkpoint 工具 + 节拍器 + 转向确认)

**checkpoint 工具**——模型自决调用,execute 内置落盘。**三区制结构契约(ADR-0003)**:

- 受管节:`# 标题`/`## Goal` 穿越保留;`## Now`(status 整节替换)、`## 成果`(可选参数 results)、`## 下一步`(可选参数 next)提供才替换、缺省保留存量,空节带占位提示;`### 回顾 #N` 追加、限留最近 3 段(最新在前)。
- **保留区**:其余 `## ` 节(模型自建的表格/清单/经验)原样穿越,统一归位到受管节之后——实测中曾被重建删除、模型两次重造,此契约终结该损失。
- 改名容错:`Now (最终)` 类(名后跟空格/括号)视为本体,`Now备忘` 类为保留区;回顾解析行首+编号双锚定。
- 契约可见:引导形态骨架与工具描述均声明"自定义小节更新时原样保留"。

**节拍器**(tool_result 点,优先级从高到低,同轮去重 `lastNudgedTurn` 守卫):

1. 转向确认(armed 时,一次性消费)
2. 无文档 + ≥15 次工具调用 → 建档提醒(仅一次;模型自决建不建)
3. ≥100 轮未回顾 → review 提醒
4. ≥50 轮未检查 → status 提醒

失败结果不计次、不提示。**status/review 提示经轮边界消息通道投递(ADR-0004)**:
`pi.sendMessage(customType:"drift-guard-hint", triggerTurn)`——实测以 user 角色
落在请求消息末尾(与用户 steer 同座,模型必读),工具结果不再被改写;
`PI_DRIFT_HINT_CHANNEL=tail` 回退旧的工具结果尾巴通道(追加语义,绝不替换)作对照。
转向提示维持尾巴通道;建档提醒自 ADR-0005 起同样走消息通道,且无文件时 review 节拍降级为空文档事实句(每 100 轮一条,建档即止)。`before_agent_start` 复位运行计数(reviewCount 除外)。

**提示形态(ADR-0002,事实化家族)**:事实链 = 陈旧数字(已 X 轮未更新)+ 对照
(Goal / 上条 Now(标注轮距) / 最近回顾自省,截断、注明来源、读失败降级)+ 后果事实
(未记入的进展压缩后可能丢失),收于恰一个判断权声明或疑问句;全家族零祈使句。
**双时钟分离**:节拍时钟(提示即消费,防逐轮轰炸)与陈旧事实基准
(仅真实导航更新——checkpoint 或直接 write/edit 导航文件——才推进)分开;
"已 X 轮未更新"反映文件内容新旧,提示本身绝不重置事实。
**问题分工**:status 问记录差距(Now 落后现实多远),review 问方向(路线是否仍通向
Goal)。总结的内容形状不归提示管——在 checkpoint 工具的参数描述里(四要素:
正在做什么、成果、关键工作、下一步;对照上条 Now 只记增量)。

**转向确认**:input(`streamingBehavior==="steer"` 时武装)→ message_start(首条 user 是提问本人,跳过;后续 user 且 armed → 落地)→ 下一个 tool_result 一次性附中性提示。硬转向(改目标)与软细化(补充细节)由模型依提示自判。

- 全部事件签名已对照 `packages/coding-agent/src/core/extensions/types.ts` 核实(input 的 `streamingBehavior`/`InputEventResult`、message_start 的 `message.role`、tool_result 的 `isError` 与 `content` 改写、before_agent_start 返回 undefined 不碰 systemPrompt 槽)。

## 文件清单

| 文件 | 说明 |
|---|---|
| `index.ts` | preamble + 锚实现 |
| `drift-guard.ts` | checkpoint 工具 + 节拍器 + 转向确认实现 |
| `system-inject.test.mjs` | index.ts 单元测试,12 用例(运行:`node system-inject.test.mjs`) |
| `drift-guard.test.mjs` | drift-guard 单元测试,30 用例(运行:`node drift-guard.test.mjs`) |
| `bench-drift.mjs` | A/B 行为基准,4 场景(锚遵循/因果对照/零干预/任务切换;运行:`node bench-drift.mjs`,会发起 5 次真实 pi 调用) |
| `trace-probe.ts` | 实机追踪探针(`-e` 显式加载):记录模型实收的 system 标记/steer 事件/工具调用时间线,附导航文件看门(哈希变化即快照);只记录零修改 |
| `trace-report.mjs` | 会话分析器:checkpoint 调用、提示送达、工具统计;`--trace` 出"模型实收"判定,`--compliance` 出遵从率,`--nav` 出导航演化复盘(历史会话可无探针回放) |
| `VERIFY.md` | 实机验证手册:标准流程 + 功能触发表 + 已知事实(pi-plan 同栈压制等) |
| `package.json` | pi 包清单(`pi.extensions: ["./index.ts", "./drift-guard.ts"]`,探针刻意不在列) |

单测导入策略:drift-guard.ts 依赖裸导入 `typebox`(运行时由 pi 虚拟模块提供宿主同一实例),
单测把它拷贝进带 typebox 桩的临时目录再导入——真实扩展目录保持零 node_modules,避免物理副本遮蔽虚拟模块。

## 安装与启停

```jsonc
// ~/.pi/agent/settings.json → packages
[ "/Users/yxy/.pi/agent/selfextensions/system-inject", ... ]
```

- 临时停用锚(保留 preamble):`PI_DRIFT_GUARD=off pi ...`
- 整体停用:从 packages 数组移除对应条目

## 决策记录(含被否决方案)

| 决策 | 理由 | 被否决的替代 |
|---|---|---|
| Goal 进锚,Now 不进 | 缓存分离:Now 每次 checkpoint 都变,会使整个前缀缓存失效,每边界多付近全价;Goal 稳定,缓存全保 | Now 也注入(每 10 轮核销一次全部缓存) |
| 信任门拦截文件内容 | 仓库预埋的 PROGRESS.md 会直入系统提示词,绕过 Project Trust | 仅加"数据非指令"标注(不够,标注可被内容淹没) |
| 无 Goal 时原文兜底 | 尊重模型/用户的自由书写,信息继续流动 | 视为无文件(丢失意图) |
| 合并单处理器 | 单槽覆盖制的必然结论 | 拆成两个扩展(互相清零,已实证否决) |
| 无文件格式校验 | 格式乱无害且自愈(checkpoint 归位),宽容读入符合 less is more | 开局格式校验/强制模板 |
| checkpoint execute 内落盘 | 格式归位由代码保证,模型只交内容;工具回执短,省 token | 返回文件内容让模型自己写回(多一轮、易漂格式) |
| 提示追加不替换 | tool_result 返回值是整体替换语义,裸提示会丢当轮工具输出(审查发现,已被 T7/T8/T12 固化为断言) | 直接返回 `{content:[hint]}`(初版实现,已证伪) |
| 读失败即中止 | 文件在但读不了时用占位符覆写 = 破坏性自愈;checkpoint 抛错走 isError,模型可重试 | readNav 失败折叠为 null 继续重建(初版实现,已证伪) |
| 节拍提示即消费时钟 | 逐轮轰炸违背零强制;提示后模型自决何时真的调用 | 到期后每轮重复提示 |
| 转向中性文案 | 硬转向/软细化边界模型比规则清楚;规则判(重叠度)已实证误伤"看A段→看A段几行" | 代码检测新旧指令重叠度 |
| drift-guard 独立文件 | 事件钩子多槽叠加,无 systemPrompt 单槽问题;与 index.ts 同包避免装两份 | 并入 index.ts(混合两类职责) |
| 事实化提示家族(ADR-0002) | 祈使式建议在高强度任务流中注意力权重趋零(964 轮实测遵从率极低);三要素事实句让对照当场可完成,判断权仍归模型 | 提示升级阶梯(施压轨道,违最高原则) |
| 三区制结构契约(ADR-0003) | 模型自建节两场被删、两次重造(实测);骨架最小封闭+保留区开放,位置即格式的一部分 | 原位保留(复杂度翻倍);领域节升骨架(焊入领域假设) |
| 轮边界消息通道(ADR-0004) | 尾巴位置遵从率 59%,流中送达全无视、边界送达秒遵从;消息座位与 steer 同座,模型必读(实测暗号验证) | 语义时机检测(猜=脆弱);工具耗时代理(数据否决);进系统提示词(缓存红线) |
| 节拍 50/100(ADR-0002) | 模型自然维护节奏 ≈140 轮/次,10/20 是其 7~14 倍;提示 132→~29 降噪约 78%,降频提高单条被读概率 | 保持 10/20(习惯化继续拉低权重) |
| 双时钟分离(ADR-0002) | "已 X 轮未更新"必须反映文件内容新旧;提示若重置事实,数字永远≈间隔,失去意义 | 复用节拍时钟作事实基准 |

已知取舍:extractTitle/extractGoal/readNav 在 index.ts 与 drift-guard.ts 各有一份
(锚只读、checkpoint 读写,容错语义不同),改 Goal 正则须两处同步;未提取共享模块是为
了不引入扩展内相对导入的加载面。骨架外自定义小节在全文件重建时被移除(格式归位的规格内行为)。

## 测试

`node system-inject.test.mjs` — 12 用例:preamble 注入位置、引导/状态两形态、
Now 分离、无 Goal 兜底、信任门、截断、总开关、CRLF、空文件、无修改返回 undefined、
快照滚动清理、尾部锚定(ADR-0001 不变量)。
`node drift-guard.test.mjs` — 30 用例:工具注册/骨架/Now 覆盖/回顾落盘/折叠保留/宽容占位、
节拍 50/100 与同轮去重/时钟复位/失败不计次、转向全链(带 Goal 对照)/首条不误触/followUp 不武装、总开关
(含无文档路径)、Goal 尾随空格防覆写、内联"### 回顾"防幻影块、读失败防覆写、
提示追加保留工具输出(T7/T8/T12)、哲学红线零祈使句(T20)、直接写重置陈旧事实(T21)、
读失败降级(T22)、回顾对照物(T23)、转向无文档降级(T24)、
自定义节保留与归位(T25)、改名容错(T26)、results/next 参数(T27)、空占位提示(T28)、消息通道投递与旧通道对照(T29)、空文档回顾事实·非重发(T30)。
端到端:种带标记的 PROGRESS.md 后跑 `pi -p`,核验快照含 preamble+Goal+切换提示、不含 Now;
实机追踪与"模型实收"判定见 [VERIFY.md](./VERIFY.md)(探针 + 会话分析器)。
行为基准:`node bench-drift.mjs` — B1 锚遵循(含关阔回归对照)/ B2 零干预 / B3 任务切换。

## 路线图

1. ~~checkpoint 工具~~ / ~~节拍器~~ / ~~转向确认~~ / ~~结构化回顾史~~ — 已实现(见 drift-guard.ts)
2. 真实环境长任务验证:节拍触发下 PROGRESS.md 自动演化、转向提示在 steer 场景落地
3. ~~若与 pi-plan 重叠过大,收敛为一套~~ — 已收敛(ADR-0001,pi-plan 存档)

## 与 pi-plan 的关系(已收敛,ADR-0001)

pi-plan 曾是与本扩展锚部件**同源同题**的第二套导航系统(write_plan 工具 + 每轮
sections.plan_state 注入 + 尾灯)。2026-10-06 证实其注入与 force 通道结构性冲突:
preamble 必须走 force 通道,宿主 forced-prompt projection 在每次请求时整体替换
system message,pi-plan 的计划从未到达模型(四臂实验证据见 VERIFY.md)。
导航体系已收敛为单一系统:pi-plan 退出启用集存档,本扩展为唯一导航系统。
决策全文见 [docs/adr/0001](../docs/adr/0001-single-navigation-system.md)。
