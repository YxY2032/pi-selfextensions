# selfextensions — pi 扩展工作区

自管扩展的统一目录。每个子目录是一个独立的 pi 包(带 package.json 清单),
启停通过 `~/.pi/agent/settings.json` 的 `packages` 注册表控制。

## 分类总览

| 分类 | 扩展 | 来源 | 干什么 |
|---|---|---|---|
| **注入与导航** | [system-inject](./system-inject/README.md) | 自研 | preamble 投影 + 防漂移导航锚(读 PROGRESS.md 注入 Goal) |
| **工作流** | [pi-plan](./pi-plan/README.md) | 自研包 | 长任务执行清单:write_plan 工具 + 每轮系统提示词注入 + 尾灯提示 |
| **外部工具** | pi-web-access | npm(`npm:pi-web-access`) | web_search / fetch_content / source_check 等联网工具 |

## 目录结构

```text
selfextensions/
├── README.md              ← 本文件:总索引
├── system-inject/         ← [注入与导航] pi 包
│   ├── package.json       ←    pi 清单(extensions: ./index.ts, ./drift-guard.ts)
│   ├── index.ts           ←    preamble + 导航锚
│   ├── drift-guard.ts     ←    checkpoint 工具 + 节拍器 + 转向确认
│   ├── README.md          ←    术语/行为规格/决策记录/路线图
│   ├── *.test.mjs         ←    单元测试(system-inject 11 + drift-guard 19 用例)
│   └── bench-drift.mjs    ←    A/B 行为基准(4 场景,5 次真实调用)
└── pi-plan/               ← [工作流] pi 包(自带 README/DESIGN/测试)
```

## 多机同步(GitHub)

本目录是独立 git 仓库,远端:`YxY2032/pi-selfextensions`(私有)。

新机器初始化:

```bash
git clone git@github.com:YxY2032/pi-selfextensions.git ~/.pi/agent/selfextensions
# pi-plan 有 npm 依赖,需安装(勿跑生命周期脚本以外的钩子):
cd ~/.pi/agent/selfextensions/pi-plan && npm install --ignore-scripts
```

`~/.pi/agent/settings.json` 的 `packages` 数组按上节配置即可(路径若用户名不同需相应调整)。
本机改动后同步:`git add <具体文件> && git commit && git push`;其他机器 `git pull` 后 `/reload` 或重启 pi。

## 启停管理

**注册表**:`~/.pi/agent/settings.json` → `packages` 数组,一条 = 一个启用的扩展:

```jsonc
[
  "/Users/yxy/.pi/agent/selfextensions/system-inject",  ← 目录(pi 清单解析)
  "/Users/yxy/.pi/agent/selfextensions/pi-plan",
  "npm:pi-web-access"
]
```

- **停用**:从数组删除该条(或注释式管理脚本),重启 pi 生效
- **启用**:数组加回路径 / `pi install <来源>`
- **临时验证单个扩展**:`pi -e ./某个扩展.ts`(绕过注册表)

## 注意事项

1. **system-inject 与 pi-plan 功能相邻**:两者都会向系统提示词注入导航类内容
   (锚 vs write_plan 计划),同时启用时注意观察是否重复提醒;
   详细边界分析见 [system-inject/README.md](./system-inject/README.md) 末节。
2. system-inject 的快照与审计日志在 `/tmp/anchor-probe/`(滚动保留 20 份)。
3. 修改任何扩展代码后:`/reload` 或重启 pi 生效;改动后请跑对应测试。
4. `npm:pi-web-access` 要求 pi ≥ 0.86.1;旧版本 pi 启动会告警并降级(可忽略)。

## 测试与基准

```bash
cd system-inject
node system-inject.test.mjs   # 11 单元用例(无需网络)
node bench-drift.mjs          # 4 场景 A/B 行为基准(5 次真实 pi 调用)
```
