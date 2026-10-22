# 《DSH 培训班环境部署手册》

| 项 | 内容 |
|---|---|
| 项目代号 | dsh-training（DSH Agent 培训班） |
| 文档版本 | v1.0 |
| 生成时间 | 2026-11-03（本机部署会话） |
| 执行身份 | DSH 环境配置代理 |
| 部署根目录 | `C:\Users\29496\.dsh\plugin-sources\dsh-training` |
| DSH_HOME | `C:\Users\29496\.dsh` |
| 当前 profile | `C:\Users\29496\.dsh\profiles\desktop` |
| 适用平台 | Windows（PowerShell / pwsh） |

---

## 一、结论速览

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| 1 | 工具链检查（Node ≥ 22.19.0 / Git / pnpm） | ⚠️ **部分通过** | Node ✅、pnpm ✅、**Git ❌ 未安装** |
| 3 | Git 初始化 + 目录结构 | ⚠️ **部分完成** | 目录结构 ✅ 已建；**git init 跳过**（缺 Git，按约定不自动安装） |
| 4 | 验证 dsh-open-in-vscode 集成 | ⛔ **阻塞** | 包已下架 + 本机无 VS Code，已降级为探测脚本并留证 |
| 5 | 创建 dsh-training-protocol 空插件骨架 | ✅ **完成** | events 模板生成，已改造为 LV0→LV1 协议授权占位，`tsc` 构建通过 |
| 6 | 生成部署手册 | ✅ **完成** | 即本文档 |

> 原任务清单无第 2 项，本手册编号与你的原始清单保持一致。

---

## 二、环境检查明细

### 2.1 实测结果

| 检查项 | 要求 | 实测 | 判定 |
|---|---|---|---|
| Node.js | ≥ 22.19.0 | **v24.21.0**（`D:\node.exe`） | ✅ 通过 |
| pnpm | 可用 | **12.9.1** | ✅ 通过 |
| Git | 可用 | PATH 无、标准安装路径无、`where git` 退出码 1 | ❌ 未安装 |
| VS Code | 供第 4 步验证 | `code` 命令无；4 个常见安装路径的 `Code.exe` 均不存在 | ❌ 未安装 |
| winget | 备用安装手段 | **1.29.380** | ✅ 可用（未使用） |
| `create-dsh-plugin` | 供第 5 步 | npm 上 **0.2.3** 可解析 | ✅ 可用 |
| `dsh-open-in-vscode` | 供第 4 步 | npm **404 / 已下架** | ❌ 不可用 |

### 2.2 执行纪律说明

本手册遵循「**不满足则提示，不自动降级/不自动安装**」：

- Git 缺失 → **未擅自安装**，仅在第 6 章列出安装与初始化命令，等你确认。
- VS Code / 插件缺失 → **未伪造「集成可用」**，改为可复现的探测脚本 + 证据留档。

### 2.3 复检命令（随时可重跑）

```powershell
node -v
pnpm -v
where git            # 退出码 1 = 未安装
where code           # 退出码 1 = 未安装
winget --version     # 安装 Git / VS Code 的备用手段
node scripts\probe-vscode-integration.mjs   # 第 4 步集成探测（项目根目录下执行）
```

---

## 三、目录结构

已在 `C:\Users\29496\.dsh\plugin-sources\dsh-training` 下创建（含 `.gitkeep` 占位，便于后续入库）：

```
dsh-training/
├─ plugins/                         # 功能板块（每板块一个独立插件包）
│  └─ dsh-training-protocol/        # LV0→LV1 协议授权占位插件（第 5 步产物）
│     ├─ src/
│     │  ├─ index.ts                # 插件入口：apply(ctx)、LV 状态、tryGrant/revoke
│     │  └─ protocol-level.ts       # 等级定义表 + 放行判定占位（恒 false）
│     ├─ dist/                      # tsc 构建产物（index.js / protocol-level.js）
│     ├─ cordis.patch.yml           # bundle 层：profile 列出本 bundle 时插入的 loader 行
│     ├─ package.json               # dsh.bundle.patch 指向 cordis.patch.yml
│     ├─ tsconfig.json              # 纯 ESM，outDir=dist
│     ├─ pnpm-lock.yaml             # 本次 install 生成
│     └─ README.md                  # 脚手架自带的 10 条踩坑提示
├─ characters/                      # 角色设定（星辰 TxzF / 长征姬）
├─ assets/
│  └─ themes/                       # 星辰主题 token 与视觉资源
├─ docs/                            # 本文档所在
├─ scripts/
│  └─ probe-vscode-integration.mjs  # 第 4 步：只读探测，不修改环境
├─ README.md
└─ .gitignore                       # 为装好 Git 后入库预备
```

### 3.1 为什么放在 `plugin-sources` 而不是新建 `plugins` 目录

你给的原始指令是「工作目录为 DSH 的 plugins 目录」。实测 DSH_HOME 下**不存在** `plugins\`，
本地插件开发实际使用 `plugin-sources\`，且 profile 已用 `file:` 依赖引用过该目录下的包
（如 `redfox-community-dsh`）。经你确认后，采用与 DSH 现有机制一致的落盘位置：

- 可被 profile 以 `file:` 依赖直接引用 → 能被 DSH 真正加载；
- 若放到 `.dsh\plugins\`（不存在的新目录），DSH 不会扫描，插件永远加载不到。

项目内部的 `plugins/` 子目录仍然保留，作为「所有功能板块的容器」，语义不变。

---

## 四、dsh-training-protocol 插件骨架（LV0 → LV1 协议授权占位）

### 4.1 生成方式

```powershell
cd C:\Users\29496\.dsh\plugin-sources\dsh-training\plugins
npx --yes create-dsh-plugin dsh-training-protocol -t events --yes
```

生成器信息：

| 项 | 值 |
|---|---|
| `create-dsh-plugin` 版本 | 0.2.3 |
| 模板 | `events`（生命周期/事件插件，**零运行时依赖**） |
| 生成的 package name / plugin-id | `dsh-training-protocol` / `dsh-training-protocol` |
| `@deepseek-ai/dsh-tools` 版本 | 锁定 `0.2.1-rc.2`（`next` 标签；`latest` 是过期的 0.0.1-rc.1） |

### 4.2 生成后所做的二次改造

脚手架默认自带三段示例监听（`session/event`、`tools/change`、`tools/pre-execute`）+ 30 秒心跳。
按「空骨架 + 协议授权占位」的要求，已改造为：

| 内容 | 改造后行为 |
|---|---|
| 业务监听 | **全部移除**，只留注释形式的 `TODO(LV1)`，避免日志噪声与「看起来在工作」的错觉 |
| 等级模型 | 新增 `src/protocol-level.ts`：`LV0`（未授权，可浏览）/ `LV1`（已授权，解锁实训场） |
| 放行判定 | `canEnterLv1()` **恒返回 false** —— 故意不实现，杜绝「假授权」 |
| 状态 API | `state` / `tryGrant(license)` / `revoke()`，调用链真实存在，判定落地后无需改动 |
| 卸载证明 | `ctx.effect` 返回 disposer，卸载时打印 `DISPOSED — listeners removed, nothing left behind` |

等级语义：

- **LV0 · 未授权** — 可浏览课程目录与公开讲义；不可进入实训场，不可调起 agent 演练。
- **LV1 · 已授权** — 需持有有效 License；解锁实训场、随堂演练，以及星辰（TxzF）/ 长征姬的引导式陪练。

### 4.3 构建验证（已实跑，非省略）

```powershell
cd C:\Users\29496\.dsh\plugin-sources\dsh-training\plugins\dsh-training-protocol
pnpm install     # +27 个包，耗时 1m 18.7s
pnpm run build   # tsc -p tsconfig.json，退出码 0
```

产物：

| 文件 | 大小 |
|---|---|
| `dist/index.js` | 2273 B |
| `dist/protocol-level.js` | 2379 B |

### 4.4 如何装载进 DSH profile（**尚未执行，需你确认**）

本骨架目前只是独立包，**未挂到任何 profile**。装载命令（在 `plugins/` 的父目录执行）：

```powershell
# 1) 把本地包加入当前 profile
dsh plugin --profile desktop add ./dsh-training-protocol

# 2) 启动并观察插件是否装载成功
dsh --profile desktop
# 预期日志：[dsh-training-protocol] mounted — LV0 · 未授权 ...
```

> 注意：`cordis.patch.yml` 里的 `name` 是**包名**（需在 profile 的 node_modules 中可解析），
> 不是相对路径。以 `file:` 方式安装后由 pnpm 建立链接即可。

---

## 五、dsh-open-in-vscode 集成状态（第 4 步：阻塞）

### 5.1 阻塞证据

| 前置条件 | 实测 | 结论 |
|---|---|---|
| `code` CLI 可用 | 命令不存在（`where code` 失败） | ❌ |
| VS Code 已安装 | `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`、`C:\Program Files\Microsoft VS Code\Code.exe` 等 4 条路径均不存在 | ❌ |
| profile 已装该插件 | `dependencies` 无、`dsh.profile.bundles` 无、本地源码无 | ❌ |
| npm registry 可解析 | 返回 HTTP 200，但文档中带 `time.unpublished`：**2026-08-16T06:37:22.118Z 下架，原版本 0.2.0** | ❌ |

**踩坑记录**：包被「全量下架」时 registry 仍返回 **HTTP 200**，只在文档里留 `time.unpublished`
且不再有 `dist-tags` / `versions`。只看 `res.ok` 会得到**假阳性 ✅**——探测脚本已针对此修正，
现在能正确报出「已下架」。

### 5.2 探测脚本

路径：`scripts/probe-vscode-integration.mjs`（Node 原生，零依赖，**只读**）

```powershell
cd C:\Users\29496\.dsh\plugin-sources\dsh-training
node scripts\probe-vscode-integration.mjs
```

退出码约定：

| 退出码 | 含义 |
|---|---|
| `0` | AVAILABLE —— 四项前置条件齐备 |
| `1` | BLOCKED —— 打印未满足项与处置建议 |

本次实测输出（退出码 1）：

```
❌  code CLI                       `code` 不在 PATH 上（命令不存在）
❌  VS Code 安装路径                常见安装路径均不存在
❌  profile 已装 dsh-open-in-vscode  dependencies=无 / bundles=无 / 本地源码=无
❌  registry 可解析                 HTTP 200 但已下架（unpublished @ 2026-08-16T06:37:22.118Z，原版本 0.2.0）
结论：BLOCKED —— 4 项前置条件不满足
```

### 5.3 恢复路径（待你决策）

1. 安装 VS Code，勾选「添加到 PATH」，确认 `code --version` 可执行。
2. **npm 官方源已无此包**，需确认替代获取途径：作者仓库 / dshmarket 收录页 / 本地源码。
3. 装好后加入 profile：`dsh plugin --profile desktop add <包名或本地路径>`。
4. 重跑探测脚本，直至输出 `AVAILABLE`。

---

## 六、Git 仓库（第 3 步：未初始化）

### 6.1 当前状态

- **未执行 `git init`** —— 本机无 Git，按约定不自动安装、不降级处理。
- 已预先放好 `.gitignore`（依赖、`dist/`、日志、编辑器目录、`.env` 与 `.credentials.yaml` 均已排除）。

### 6.2 待办（装好 Git 后按序执行）

```powershell
# 方式一：winget 安装（本机 winget 1.29.380 可用）
winget install --id Git.Git -e --source winget

# 若 winget 新装的 git 未进当前 shell 的 PATH，重开终端或：
$env:Path += ";C:\Program Files\Git\cmd"

# 初始化仓库
cd C:\Users\29496\.dsh\plugin-sources\dsh-training
git init
git add -A
git commit -m "chore: 初始化 dsh-training 底层环境（目录骨架 + 协议插件 LV0→LV1 占位）"
```

预期首次提交约包含 12 个文件（不含 `node_modules` 与 `dist`）。

---

## 七、已知风险与待办清单

| 优先级 | 事项 | 说明 |
|---|---|---|
| P0 | 安装 Git 并完成首次提交 | 否则无版本回溯，后续板块迭代不可回滚 |
| P0 | 决定 `dsh-open-in-vscode` 的替代来源 | npm 已下架，不能靠官方源恢复 |
| P1 | 装载 `dsh-training-protocol` 到 profile | 骨架已验证可编译，但**尚未实机装载**，loader 行为未经实测 |
| P1 | 实现 LV0→LV1 放行判定 `canEnterLv1()` | 当前恒 false；需协议签发板块给出 License 校验口径 |
| P1 | 补齐 `适配 agent 列表` | 你标注为「暂缺，后续补充」；建议做成配置驱动（`agents.config.ts`）而非硬编码 |
| P2 | `characters/`、`assets/themes/` 目前为空占位 | 星辰 TxzF / 长征姬 的设定与主题 token 尚未落文件 |
| P2 | 引入 workspace 编排 | 板块变多后建议加根 `pnpm-workspace.yaml`，统一安装与构建 |

---

## 八、附：本次执行命令清单

```powershell
# 1) 环境探测
node -v ; pnpm -v ; where git ; where code ; winget --version
npm view create-dsh-plugin version
npm view dsh-open-in-vscode version          # → 404 Unpublished

# 2) 目录骨架
New-Item -ItemType Directory -Force plugins, characters, assets, assets\themes, docs, scripts

# 3) 插件骨架
npx --yes create-dsh-plugin dsh-training-protocol -t events --yes

# 4) 集成探测
node scripts\probe-vscode-integration.mjs    # → 退出码 1（BLOCKED）

# 5) 构建验证
pnpm install ; pnpm run build                 # → 退出码 0
```

---

_本手册如实记录执行结果：**未完成项一律标注为阻塞并给出恢复路径**，不做「看起来已完成」的表述。_
