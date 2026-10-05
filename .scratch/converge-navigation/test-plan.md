# Test Plan: 收敛两套导航系统(spec: .scratch/converge-navigation/spec.md)

日期:2026-10-06。环境:Windows,pi 0.86.1(zai-coding-cn / glm-5.3)。

## 范围与原则

本变更是**配置与文档变更 + 一条新增不变量单测**:system-inject 运行时行为零变化,
pi-plan 退出启用集。因此单测层只新增 T12(尾部锚定不变量,ADR-0001 的可执行载体),
其余验证为回归(两套件全绿)与实机证据(探针/分析器,方法见 system-inject/VERIFY.md)。

## 单元测试

| 项 | 命令 | 结果 |
|---|---|---|
| system-inject 套件(含新增 T12 尾部锚定) | `node system-inject.test.mjs` | **12/12 通过** |
| drift-guard 套件(回归,零改动) | `node drift-guard.test.mjs` | **19/19 通过** |

T12 断言:构造含多个 XML 节的系统提示词,锚(`## 任务导航`)必须位于全部节之后,
且锚之后不得再出现任何节——尾部锚定是近因对齐的载体,也是 ADR-0001 保留 force
通道的唯一理由,故固化为不变量。

## 实机验证(全部已执行)

| 验收项 | 方法 | 证据 |
|---|---|---|
| 启用集无 pi-plan | `pi list` | 输出仅 pi-subagents / pi-web-access / system-inject |
| settings 无 pi-plan 条目 | 读 `~/.pi/agent/settings.json` | packages 数组 3 条,无 pi-plan |
| 锚与 preamble 正常到达 | 临时目录 `pi -e trace-probe.ts -p`,trace-report `--trace` | 请求#1/#2 命中 `anchor,preamble`;判定 锚到达=true preamble到达=true |
| plan_state 不再出现 | 同上 | `plan_state到达=false`,Now泄漏=false |
| checkpoint 在、write_plan 不在 | 探针记录的请求级 `payload.tools` | 工具声明(12):bash,bg_wait,**checkpoint**,edit,fetch_content,get_search_content,read,source_check,subagent,subagent_supervisor,web_search,write —— **无 write_plan** |
| checkpoint 端到端可用 | 提示词要求调用 checkpoint | 会话含真实 checkpoint 调用(请求#2 为其工具往返) |

补充事实(验证中厘清,非回归):0.86.1 里扩展工具声明走请求级 `payload.tools`,
不进 system prompt 的 tools 节(tsecbench 旧会话同样如此);探针已增加工具声明记录。

## 复现手册

任何机器上重复本验证:

```bash
cd <临时目录>
pi -e <selfextensions>/system-inject/trace-probe.ts --session-dir ./sess \
   -p "用 checkpoint 工具汇报一下现状(内容随意),然后回答 1+1=?"
node <selfextensions>/system-inject/trace-report.mjs <sess 里最新 jsonl> \
   --trace <pi-trace 里最新 trace-*.jsonl>
# 期望:锚到达=true;工具声明含 checkpoint、不含 write_plan;plan_state到达=false
```
