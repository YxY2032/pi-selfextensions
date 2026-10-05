# selfextensions

pi 自管扩展工作区。本仓库的改动遵循工程技能流程:spec/工单在 `.scratch/`,
决策在 `docs/adr/`,术语在 `CONTEXT.md`。改动后必须跑对应扩展的测试套件
(见各包 README),实机行为验证用探针与手册(system-inject/VERIFY.md)。

红线(继承自设计史,违反即返工):

1. less is more:不约束模型,只划边界;提示即建议、即事实播报,到期即消费,不轰炸。
2. 信任门:未信任项目的文件内容绝不进系统提示词。
3. 单槽覆盖制:systemPrompt 只能由 system-inject/index.ts 的单处理器返回。
4. 缓存经济学:动态内容(Now)不进系统提示词。
5. 提示追加不替换(tool_result 的 content 是整体替换语义)。
6. 读失败即中止,不用占位符覆写已有文件。
7. 扩展目录零 node_modules(typebox 由 pi 虚拟模块提供)。
8. erasable TS only、无内联 import;export default function (pi) 的 pi 参数无类型标注。

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
