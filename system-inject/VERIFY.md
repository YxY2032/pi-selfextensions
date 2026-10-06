# 实机验证手册

目的:三件套(锚 / checkpoint+节拍器 / 转向确认)与 preamble 的每次实机验证,
都用同一套可观测证据判定,不靠感觉。

## 工具

| 工具 | 用途 |
|---|---|
| `trace-probe.ts` | 探针扩展,`-e` 显式加载(不进 package.json,不加载即零开销)。记录模型每次请求实收的 system 标记、每次输入的 steer/followUp、每次工具调用。只记录,零修改,恒返回 undefined。 |
| `trace-report.mjs` | 会话分析器:checkpoint 调用、节拍/转向提示送达、工具统计;`--trace` 合并探针后输出"模型实收"判定。 |

日志位置:探针 `/tmp/pi-trace/`(Windows 为当前盘根 `\tmp\pi-trace`,滚动保留 20 份,
systemdump-<hash>.txt 为去重后的完整 system 文本);会话 `~/.pi/agent/sessions/--<cwd转义>--/`。

**为什么要探针**:锚与 preamble 经 forced-prompt projection 在请求时注入,
会话 JSONL 的 system 条目只记 sections 形态,看不到它们——"模型真正收到了什么"
只有 `before_provider_request`(projection 之后、HTTP 之前)能观测。

## 标准流程

```bash
# 1. 测试目录(可先种 PROGRESS.md)
cd /e/tmp/dg-verify && rm -f PROGRESS.md
# 2. 启动(探针显式加载,注册表扩展照常)
pi -e C:/Users/god/.pi/agent/selfextensions/system-inject/trace-probe.ts
# 3. 按下表触发各功能(交互操作)
# 4. 退出后出报告
node C:/Users/god/.pi/agent/selfextensions/system-inject/trace-report.mjs \
  <会话.jsonl> --trace <pi-trace 里最新 trace-*.jsonl>
# 不传参数时自动取 ~/.pi/agent/sessions 下最新会话
```

## 功能触发表

| 功能 | 交互操作 | 期望证据(trace-report 输出) |
|---|---|---|
| 锚·引导形态 | 无 PROGRESS.md 的目录里提问 | 判定 `锚到达=true`;systemdump 为引导骨架 |
| 锚·状态形态 | 种含 `## Goal` 的 PROGRESS.md 后提问 | 同上;systemdump 含 title+Goal |
| 缓存红线 | 同上 | 判定 `Now泄漏=false` |
| preamble | 任意提问 | `preamble到达=true` |
| 节拍·status(50 轮,ADR-0002/0004) | 连续跑 ≥50 轮工具调用 | 轮边界出现 drift-guard-hint 消息(TUI 可见):已 X 轮未更新 + Goal/Now 对照(标注轮距)+ 后果事实 + 判断权声明;同轮不重复 |
| 节拍·review(100 轮) | ≥100 轮未回顾 | 轮边界 drift-guard-hint 消息:已 X 轮未深度回顾 + 最近回顾自省引用 + 方向疑问句 |
| 建档提醒 | 无文档目录 ≥15 次工具调用 | `[导航状态] …无导航文件…` 恰一次 |
| 陈旧事实 | 提示后模型直接 write PROGRESS.md | 下次提示的"已 X 轮未更新"从直接写入轮起算(双时钟分离) |
| checkpoint | 对模型说"调用 checkpoint 汇报进展" | `[checkpoint 调用]` 列表 + PROGRESS.md 的 Now 更新 |
| 遵从率(ADR-0002 判据) | 会话结束跑 `--compliance` | status/review 提示后 25 轮内有导航更新的比例;≥40% 有效 / 10-40% 调参 / <10% 回滚 |
| 导航演化复盘(`--nav`) | 会话结束跑 `--nav`(可无探针,历史会话可回放) | 演化时间线:每次写入的轮次/途径/内容(checkpoint 参数、write 全文、edit 新旧串);探针在场时另有哈希去重的文件快照(地面真值,含 bash 绕路写入)。审阅四项:四要素覆盖/事实密度/增量性/时间线一致性 |
| 转向确认 | 流式回答进行中**直接 Enter** 提交新消息 | 探针 `输入 behavior=steer` → 下一个工具结果附 `[转向提示]`(含当前 Goal 对照),仅一次 |
| followUp 不触发 | 流式中 **Ctrl+Q** 提交 | `behavior=followUp`,无转向提示 |

Windows TUI 键位(0.86.1 默认):流式中 Enter=steer(打断当前流),Ctrl+Q=followUp(排队到轮末)。

## 已知事实(2026-10-06 实测,pi 0.86.1)

- **pi-plan 同栈注入压制 → 已由 ADR-0001 收敛解决**(pi-plan 退出启用集存档)。
  历史诊断结论保留如下:pi-plan 把计划写入 `systemPromptOptions.sections.plan_state`
  (会话文件里能看到该节),但 system-inject 的 before_agent_start 返回 forceSystemPrompt
  后,宿主在每次请求时用 forced-prompt projection **整体替换** system message——
  sections 全部被丢弃,模型收不到。pi-plan 单独加载(`pi --no-extensions -e pi-plan/index.ts`)
  时注入正常。报告里 `会话侧 plan_state=true` 而 `plan_state到达=false` 即压制的直接
  证据形态。若未来出现新的 sections 注入型扩展,先重开 ADR-0001。
- 扩展工具(checkpoint/write_plan 等)不在 system prompt 的 tools 节声明,
  而在请求级 `payload.tools`(探针已记录,trace-report 会打印工具声明清单)。
- 探针标记 `nowLeak` 已排除引导形态误报(骨架本身含 `## Now` 字样,不算泄漏)。
