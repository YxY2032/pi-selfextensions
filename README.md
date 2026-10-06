# selfextensions — pi 扩展工作区

自管扩展的统一目录。每个子目录是一个独立的 pi 包(带 package.json 清单),
启停通过 `~/.pi/agent/settings.json` 的 `packages` 注册表控制。

## 分类总览

| 分类 | 扩展 | 来源 | 干什么 |
|---|---|---|---|
| **注入与导航** | [system-inject](./system-inject/README.md) | 自研 | preamble 投影 + 防漂移导航锚(读 PROGRESS.md 注入 Goal)+ checkpoint/节拍器/转向确认 |
| **工作流(存档)** | [pi-plan](./pi-plan/README.md) | 自研包 | 已停用(ADR-0001):write_plan 执行清单,注入通道与 force 冲突被压制 |
| **外部工具** | pi-web-access | npm(`npm:pi-web-access`) | web_search / fetch_content / source_check 等联网工具 |

## 目录结构

```text
selfextensions/
├── README.md / AGENTS.md / CONTEXT.md  ← 总索引 / 工程技能配置 / 术语表
├── docs/
│   ├── agents/             ← 工程技能消费规则(tracker / labels / domain)
│   └── adr/                ← 决策记录(0001: 单一导航系统,pi-plan 存档)
├── .scratch/               ← 本地工单与 spec(feature 目录制)
├── system-inject/          ← [注入与导航] pi 包(唯一导航系统,ADR-0001)
│   ├── index.ts            ←    preamble + 导航锚
│   ├── drift-guard.ts      ←    checkpoint 工具 + 节拍器 + 转向确认
│   ├── trace-probe.ts / trace-report.mjs / VERIFY.md  ← 实机追踪与验证(--compliance 遵从率)
│   └── *.test.mjs / bench-drift.mjs                    ← 单测(12+24)与行为基准
└── pi-plan/                ← [工作流] 已存档(ADR-0001)
```

## 多机同步(GitHub)

本目录是独立 git 仓库,远端:`YxY2032/pi-selfextensions`(私有)。

新机器初始化:

```bash
git clone git@github.com:YxY2032/pi-selfextensions.git ~/.pi/agent/selfextensions
```

`~/.pi/agent/settings.json` 的 `packages` 数组按上节配置即可(路径若用户名不同需相应调整)。
本机改动后同步:`git add <具体文件> && git commit && git push`;其他机器 `git pull` 后 `/reload` 或重启 pi。

## 启停管理

**注册表**:`~/.pi/agent/settings.json` → `packages` 数组,一条 = 一个启用的扩展:

```jsonc
[
  "/Users/yxy/.pi/agent/selfextensions/system-inject",  ← 目录(pi 清单解析)
  "npm:pi-web-access"
]
```

- **停用**:从数组删除该条(或注释式管理脚本),重启 pi 生效
- **启用**:数组加回路径 / `pi install <来源>`
- **临时验证单个扩展**:`pi -e ./某个扩展.ts`(绕过注册表)

## 注意事项

1. **导航体系已收敛为单一系统**(ADR-0001):pi-plan 已退出启用集存档。
   其 sections 注入与 system-inject 必需的 force 通道结构性冲突(被宿主
   forced-prompt projection 压制,从未到达模型);证据与复现方法见
   [system-inject/VERIFY.md](./system-inject/VERIFY.md)。
   若未来出现新的 sections 注入型扩展,先重开该 ADR。
2. system-inject 的快照与审计日志在 `/tmp/anchor-probe/`(滚动保留 20 份)。
3. 修改任何扩展代码后:`/reload` 或重启 pi 生效;改动后请跑对应测试。
4. `npm:pi-web-access` 要求 pi ≥ 0.86.1;旧版本 pi 启动会告警并降级(可忽略)。

## 测试与基准

```bash
cd system-inject
node system-inject.test.mjs   # 12 单元用例(无需网络)
node drift-guard.test.mjs     # 24 单元用例(无需网络)
node bench-drift.mjs          # 4 场景 A/B 行为基准(5 次真实 pi 调用)
```
