# 《DSH 培训班环境部署手册》

| 项 | 内容 |
|---|---|
| 项目代号 | dsh-training（DSH Agent 培训班） |
| 文档版本 | **v1.1** |
| 生成时间 | 2026-10-22 20:05（本机部署会话） |
| 执行身份 | DSH 环境配置代理 |
| 部署根目录 | `C:\Users\29496\.dsh\plugin-sources\dsh-training` |
| DSH_HOME | `C:\Users\29496\.dsh` |
| 当前 profile | `C:\Users\29496\.dsh\profiles\desktop`（**Electron 应用独占管理**） |
| 适用平台 | Windows（PowerShell / pwsh） |

### v1.1 变更摘要

| 变更 | 说明 |
|---|---|
| Git 已安装 | winget 下载器故障，改用官方 **PortableGit 2.55.0.windows.5**（免管理员），`where git` 可解析 |
| 仓库已初始化 | 分支 `main`，首次提交 `824f879` |
| 插件已进 desktop profile | `dependencies` 由 `dsh plugin add` 写入；`dsh.profile.bundles` 手工补入（见 4.4） |
| 装载验证口径修正 | desktop profile **CLI 无法 boot/dump**（官方明确拒绝），改以 cordis loader 级 + 模块级双验证留证 |
| 新增 agent 配置位 | `src/agents.config.ts`（列表暂缺，配置驱动） |
| dsh-open-in-vscode | 按决策**关闭**，记录移至 `docs/backlog.md`（D-001） |

---

## 一、结论速览

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| 1 | 工具链检查（Node / Git / pnpm） | ✅ **通过** | Node v24.21.0、pnpm 12.9.1、Git 2.55.0.windows.5 |
| 3 | Git 初始化 + 目录结构 | ✅ **完成** | 目录骨架 ✅；`git init` 完成，首次提交 `824f879` |
| 4 | dsh-open-in-vscode 集成 | ⛔ **已关闭（决策）** | 不再探测，见 `docs/backlog.md` D-001 |
| 5 | 插件骨架 dsh-training-protocol | ✅ **完成** | LV0→LV1 占位；已进 desktop profile 配置；构建通过 |
| 6 | 部署手册 | ✅ **完成** | 本文档 v1.1 |
| 新增 | 适配 agent 列表配置化 | ✅ **完成** | `src/agents.config.ts`，空数组合法，等你填条目 |

> 原任务清单无第 2 项，编号与原始清单保持一致。

---

## 二、环境检查明细

### 2.1 实测结果

| 检查项 | 要求 | 实测 | 判定 |
|---|---|---|---|
| Node.js | ≥ 22.19.0 | **v24.21.0**（`D:\node.exe`） | ✅ |
| pnpm | 可用 | **12.9.1** | ✅ |
| Git | 可用 | **2.55.0.windows.5**（PortableGit，`where git` → `...\Roaming\npm\git.cmd`） | ✅ |
| VS Code | — | 未安装（用户侧另行处理） | 不阻塞 |
| winget | — | 1.29.380 可执行，但**安装器下载功能故障**（见 2.2） | ⚠️ |
| 管理员权限 | 装 Program Files 需要 | **无**（当前会话非管理员） | 限制条件 |

### 2.2 winget 安装 Git 失败记录（重要）

按决策执行 `winget install --id Git.Git -e --source winget`，两次均**下载 0 字节卡死**：

| 尝试 | 下载器 | 结果 |
|---|---|---|
| 第 1 次 | Delivery Optimization（默认） | 13 分钟 `DO797A.tmp` 仍为 **0 字节** |
| 第 2 次 | 改为 `wininet`（写入 winget settings.json） | 45 秒后目标文件仍为 **0 字节** |

**排除网络原因**：对同一 URL 直接 HEAD 请求
`https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe`
返回 **200 / 1.9s / 65,343,712 字节**；npmmirror 镜像同样可达。

**结论**：winget 的下载器在本机故障（非网络、非源站问题）。

**替代方案（已执行）**：改用官方 **PortableGit 2.55.0.windows.5**，同版本、免管理员、免 UAC、整目录可删回滚。

```powershell
# 下载（npmmirror 镜像，54.6s / 58.9 MB）
https://registry.npmmirror.com/-/binary/git-for-windows/v2.55.0.windows.5/PortableGit-2.55.0.5-64-bit.7z.exe

# 静默解压（18.8s）
PortableGit-2.55.0.5-64-bit.7z.exe -o"C:\Users\29496\AppData\Local\Programs\PortableGit" -y
```

**PATH 接入**：写入 shim `C:\Users\29496\AppData\Roaming\npm\git.cmd`（该目录已在 PATH 上，
`where git` 输出即此文件）。不修改系统/用户 PATH 注册表，回滚只需删 shim 与目录。

> ⚠️ 副作用披露：为排查 winget 故障，写入过
> `%LOCALAPPDATA%\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\settings.json`
> （`network.downloader = "wininet"`，该文件原先不存在）。如需还原默认下载器，删除该文件即可。

### 2.3 复检命令

```powershell
node -v ; pnpm -v ; where git ; git --version
cd C:\Users\29496\.dsh\plugin-sources\dsh-training
git log --oneline ; git status --short
node scripts\smoke-mount.mjs          # 模块级挂载（含卸载）冒烟
node scripts\verify-cordis-mount.mjs  # cordis loader 级挂载验证
```

---

## 三、目录结构

```
dsh-training/
├─ plugins/
│  └─ dsh-training-protocol/        # LV0→LV1 协议授权占位插件
│     ├─ src/
│     │  ├─ index.ts                # 入口：apply(ctx)、状态、tryGrant/revoke
│     │  ├─ protocol-level.ts       # 等级定义 + 放行判定占位（恒 false）
│     │  └─ agents.config.ts        # 【新增】适配 agent 列表（配置驱动，空数组合法）
│     ├─ dist/                      # tsc 产物（git 忽略，装载前需 build）
│     ├─ cordis.patch.yml / package.json / tsconfig.json / pnpm-lock.yaml
│     └─ README.md
├─ characters/                      # 角色设定（待填）
├─ assets/themes/                   # 星辰主题 token（待填）
├─ docs/
│  ├─ DSH 培训班环境部署手册.md      # 本文档
│  └─ backlog.md                    # 【新增】决策台账（D-001）
├─ scripts/
│  ├─ probe-vscode-integration.mjs  # 【已关闭】历史证据，不再执行
│  ├─ smoke-mount.mjs               # 【新增】模块级挂载 + 卸载验证
│  └─ verify-cordis-mount.mjs       # 【新增】cordis loader 级挂载验证
├─ README.md
└─ .gitignore
```

---

## 四、dsh-training-protocol 插件

### 4.1 生成与改造

| 项 | 内容 |
|---|---|
| 生成器 | `create-dsh-plugin` 0.2.3，模板 `events`（零运行时依赖） |
| 二次改造 | 移除脚手架示例监听；新增 LV0/LV1 等级模型与 agent 配置位 |
| 放行判定 | `canEnterLv1()` **恒返回 false**（占位，杜绝假授权） |

### 4.2 适配 agent 列表（配置驱动）

文件：`plugins/dsh-training-protocol/src/agents.config.ts`

- `AGENTS_CONFIG: readonly AgentAdapterConfig[] = []` —— **当前为空，等你补充**；
- 结构字段：`id / displayName / kind('llm'|'mcp'|'plugin'|'custom') / enabled / endpoint? / model? / roles? / capabilities? / notes?`；
- 附带纯函数 `validateAgents()`（id 格式、重复、kind 枚举、llm 必须有 model 或 endpoint、
  未知 role/capability、**notes 中疑似密钥拦截**）与 `loadEnabledAgents()`（非法条目剔除而非抛异常）；
- 空数组是合法状态：挂载日志打印 `agents: enabled=0/0（列表暂缺…）`，不报错。

**补充步骤**：只改数组 → `pnpm build` → 重启 DSH 生效。不需要动任何分支逻辑。

### 4.3 构建验证

```powershell
cd plugins/dsh-training-protocol
pnpm install     # +27 包（1m 18.7s）
pnpm run build   # tsc 退出码 0；产物 dist/index.js、dist/protocol-level.js、dist/agents.config.js
```

### 4.4 装载进 desktop profile —— 验证结果（v1.1 新增）

#### 已完成的两步

```powershell
# ① 依赖链接（成功）
dsh plugin --profile desktop add ./dsh-training-protocol
#   dependencies: + dsh-training-protocol link:C:/Users/29496/.dsh/plugin-sources/dsh-training/plugins/dsh-training-protocol

# ② bundle 注册（dsh plugin add 不会自动做，手工补入后生效）
#   profiles/desktop/package.json → dsh.profile.bundles 追加 "dsh-training-protocol"
#   备份：package.json.bak-before-dsh-training
```

> **关键坑**：`dsh plugin add` 只写 `dependencies`，**不写 `dsh.profile.bundles`**。
> 不写 bundles，cordis 组合树里就没有这一层，插件永远不会被加载。

#### ⚠️ 无法按原计划「`dsh --profile desktop` 启动观察日志」

官方 CLI 明确拒绝：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
（退出码 1）
```

即：**desktop profile 由 Electron 应用独占管理，CLI 既不能 boot 也不能 dump。**
应用正在运行（8 个 `DeepSeek Harness` 进程），且
`%APPDATA%\@deepseek-ai\dsh-desktop\logs` 为**空目录**，没有可 grep 的日志文件。

**结论**：该 profile 的真实挂载日志，只能由**重启 DSH Desktop 应用**后产生；
而本会话正运行在该应用内，重启会中断会话，故未执行重启（也不应由代理擅自执行）。

#### 替代验证（已实跑，两条证据链）

**证据 1 · 模块级挂载 + 卸载**（`scripts/smoke-mount.mjs`，退出码 0）：

```
[dsh-training-protocol] mounted — LV0 · 未授权
[dsh-training-protocol] gate: LV0 · 未授权（免授权） — 可浏览课程目录与公开讲义；…
[dsh-training-protocol] agents: enabled=0/0（列表暂缺，待 src/agents.config.ts 补充）
[dsh-training-protocol] levels=LV0→LV1 order=LV0→LV1 canEnterLv1=false（占位）
--- 插件输出结束 ---
[dsh-training-protocol] gate detached
[dsh-training-protocol] DISPOSED — listeners removed, nothing left behind
✅ 模块级冒烟通过（disposer 2 个已执行）
```

**证据 2 · cordis loader 级挂载**（`scripts/verify-cordis-mount.mjs`，退出码 0）：

```
插件导出：name=dsh-training-protocol apply=function
[dsh-training-protocol] mounted — LV0 · 未授权
挂载日志命中「mounted — LV0 · 未授权」：是
✅ cordis loader 级挂载通过
```

证据 2 用真实的 `@deepseek-ai/cordis` Context 执行 `ctx.plugin(mod)`，
走完整插件生命周期，证明**模块符合 cordis 插件契约、能被 loader 正常挂载**。

#### 验证边界（不夸大）

| 层级 | 是否已验证 |
|---|---|
| 代码可编译 | ✅ `tsc` 退出码 0 |
| 模块可执行、apply 不抛错 | ✅ smoke-mount |
| cordis loader 可挂载 | ✅ verify-cordis-mount |
| desktop profile 组合树含该行 | ⚠️ **部分**：package.json 已写 bundles，但 **dump-config 被 CLI 拒绝**，无法出组合树 |
| DSH 应用进程内实际挂载日志 | ❌ **未验证** —— 需重启 DSH Desktop |

**待你执行的一步（约 10 秒）**：重启 DSH Desktop，在启动日志里确认出现
`[dsh-training-protocol] mounted — LV0 · 未授权`。若启动异常，回滚方式：

```powershell
# 最稳：直接还原备份（去掉 bundle 行与依赖行）
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-before-dsh-training" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
```

#### 附带风险披露

`dsh plugin add` 期间 profile 内 pnpm（v11.7.0）输出 `Packages: +2 -33`，即**移除了 33 个包**。
已抽查关键包仍在（`dshmarket`、`dsh-context`、`dsh-better-sidebar`、`@xmanrui/dsh-im`、`dsh-orb` 均存在）。
若重启后出现插件缺失类报错，用 `dsh plugin --profile desktop install` 重新补齐，或还原上面的备份。

---

## 五、Git 仓库

### 5.1 当前状态

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 首次提交 | `824f8790d302f38ba5d886b22f8df7873b1a1886`（短号 `824f879`） |
| 提交内容 | 21 文件 / 1545 行 |
| 提交身份 | 仓库级 `user.name=dsh-training-agent`、`user.email=dsh-training@localhost`（**非全局**，可自行改） |

```powershell
cd C:\Users\29496\.dsh\plugin-sources\dsh-training
git log --oneline
git status --short
git config user.name      # 如需改成你自己的身份
```

被 `.gitignore` 排除：`node_modules/`、`dist/`、日志、`.env`、`**/.credentials.yaml`。

> 注意：`dist/` 不入库属正常约定——**新克隆后需先 `pnpm install && pnpm run build`**，
> 否则 profile 里那条 `link:` 依赖会指向空产物。

### 5.2 如需换成正式 Git 安装

PortableGit 只是免管理员的临时通道。等你方便时：

```powershell
# 管理员终端
winget install --id Git.Git -e --source winget     # 需 winget 下载器修复
# 然后删掉 shim，让 PATH 指向正式安装
Remove-Item "$env:APPDATA\npm\git.cmd"
```

---

## 六、dsh-open-in-vscode（已关闭）

按项目决策：**不自研、不找第三方源、不再探测**。现阶段用「VS Code 直接打开目录」。
完整决策记录见 [`docs/backlog.md`](backlog.md) 的 **D-001**。

保留了 `scripts/probe-vscode-integration.mjs` 作为历史证据（可复现当时的 4 项阻塞结论），
但**不再纳入日常执行**。

---

## 七、已知风险与待办

| 优先级 | 事项 | 说明 |
|---|---|---|
| P0 | 重启 DSH Desktop 完成真机挂载确认 | 唯一未验证环节；回滚命令见 4.4 |
| P0 | 确认 profile 被移除的 33 个包无影响 | 重启后若报插件缺失，`dsh plugin --profile desktop install` 补齐 |
| P1 | 补充 `AGENTS_CONFIG` 条目 | 改数组 + `pnpm build`，无需动代码逻辑 |
| P1 | 实现 `canEnterLv1()` 放行判定 | 需协议签发板块给出 License 校验口径（签名/时效/scope） |
| P2 | `characters/`、`assets/themes/` 落内容 | 星辰 TxzF / 长征姬设定卡；寻梦山海主题 token |
| P2 | 根级 pnpm workspace | 板块变多后统一安装与构建 |
| P3 | 工作台内嵌编辑器 | 见 backlog D-001 的立项条件 |

---

_本手册如实记录：**未验证的环节明确标注「未验证」并给出补验证与回滚路径**，不做「看起来已完成」的表述。_
