# dsh-training · DSH Agent 培训班

> 项目代号：**dsh-training** ｜ 风格：年轻时尚 · 极简主义 · 星辰特色（寻梦山海）

本仓库是 DSH Agent 培训班的**底层环境与插件源码目录**，位于
`C:\Users\29496\.dsh\plugin-sources\dsh-training`（DSH 的本地插件源目录，
可被 profile 以 `file:` 依赖引用）。

## 目录结构

```
dsh-training/
├─ plugins/                 # 全部功能板块（每个板块一个独立插件包）
│  └─ dsh-training-protocol/   # LV0→LV1 协议授权占位插件（当前唯一板块）
├─ packaging/               # 安装包工程（阶段二 IPC 完工；仍不产出 exe/zip）
│  ├─ distribution.json     # 版本唯一来源
│  ├─ boards.json           # 板块唯一事实源（必装/可选/占位）
│  ├─ boards/               # 9 个板块骨架（core + 3 角色 + 5 功能预览）
│  ├─ runtime/              # Node 检测（缺则提示，不静默安装）
│  ├─ installer/            # Electron 壳 + 向导页骨架
│  └─ scripts/              # build / version / verify / scaffold-boards
├─ characters/              # 角色设定（星辰 TxzF / 长征姬）
├─ assets/
│  └─ themes/               # 星辰主题 token 与视觉资源
├─ docs/                    # 文档
│  ├─ DSH 培训班环境部署手册.md
│  ├─ 安装包构建说明.md      # 维护者用
│  ├─ 下载者安装手册.md      # 学员用（零命令行）
│  ├─ 验收与回退手册.md      # A1-A6 验收 + 故障注入 + 回退操作
│  ├─ 发版测试报告模板.md    # 发版前逐项填写
│  └─ backlog.md
├─ scripts/                 # 运维/验证脚本
└─ README.md
```

## 当前状态

| 项 | 状态 |
|---|---|
| Node.js v24.21.0 / pnpm 12.9.1 | ✅ 满足 |
| Git | ✅ 已装（PortableGit 2.55.0.windows.5，经 PATH shim 接入） |
| Git 仓库 | ✅ 已初始化（分支 `main`，首次提交 `824f879`） |
| dsh-open-in-vscode 集成 | ⛔ **已关闭**（决策见 `docs/backlog.md` D-001，改用 VS Code 直接打开目录） |
| dsh-training-protocol 骨架 | ✅ 已生成并构建通过；已进 desktop profile 配置，**真机挂载待重启应用确认** |
| 适配 agent 列表 | ⬜ 配置位已就绪（`src/agents.config.ts`），**等你补充条目** |

详见 [docs/DSH 培训班环境部署手册.md](docs/DSH%20培训班环境部署手册.md)。

## 架构原则

一切功能板块化：模块间低耦合、可独立安装/卸载/更新，通过 DSH 插件标准接口通信。
禁止跨板块直接 import，板块之间只经宿主注入的 `ctx` 交互。
