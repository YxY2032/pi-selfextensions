# 03: 导航文件演化审计——探针快照 + 报告 --nav 回放

Status: resolved
Type: task
Spec: .scratch/fact-hints/spec.md
ADR: docs/adr/0002-fact-form-hints.md(判据配套:频率 --compliance,质量 --nav)

## 背景

用户需求:对 PROGRESS.md 复盘,观察代码是否生效(内容是否有帮助/有缺陷)。
否决的形态:把导航文件本身改为"文件夹+时间戳多文件"——那是改被测系统换观测,
稳定路径是系统契约(锚/切换提示/跨会话携带/信任门),不能为审计破坏;
正确形态是观测侧解决,被测系统零改动。

## 任务

1. trace-probe.ts:导航文件看门——每次 tool_result 后哈希 PROGRESS.md,
   变化即快照到 /tmp/pi-trace/nav-<ts>-<pid>-<位置>.md(哈希去重;
   probe 启动时留基线;按文件实际变化判定,bash 绕路写入也能捕捉);
   nav 快照独立滚动保留 60 份。
2. trace-report.mjs:--nav 从会话 JSONL 重建演化时间线
   (checkpoint 参数 / write 全文 / edit 新旧串);--trace 合并时列出
   探针快照清单(地面真值)。历史会话可无探针回放。

## Answer

全部完成(2026-10-06):

- 实机验证:种 PROGRESS.md 后跑 checkpoint + 手动 write,产生三份快照
  (init 37B 基线 → t1 102B 含 checkpoint 汇报 → t3 109B 含手动追加),
  哈希去重生效(无变化的 tool_result 不产生快照)。
- 对 tsecbench 历史会话(无探针)回放成功:7 次写入的完整时间线与内容可读。

## 审计发现(工具第一次使用即命中)

**checkpoint 的格式归位破坏模型自建的自定义节**:tsecbench 第 186 轮模型在
直接 write 中创建了 `## 已通关` 计分表与 `## 关键技术备忘`;第 248/366 轮
checkpoint 全文件重建将它们删除(规格内行为:骨架外自定义节被移除),当前文件中
两节已不存在,模型在最终 write 中被迫重造同类内容("通关清单 36 题")。
信息损失 + 重复劳动。修复方向(待裁决,建议下一工单):executeCheckpoint 重建时
保留未知 `## ` 自定义节(仅管理自己的骨架:title/Goal/Now/回顾),
与"宽容读入"哲学一致。
