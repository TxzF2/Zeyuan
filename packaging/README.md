# packaging/ · zeyuan 安装包工程

> 给**维护者**看的入口。学员请看 [`../docs/下载者安装手册.md`](../docs/下载者安装手册.md)。

## 这是什么

zeyuan 安装包的构建工程。当前处于 **阶段一（骨架）**：结构、脚本、文档就位，
**不产出任何 exe/zip**。

## 三条命令就够

```powershell
node scripts/version.mjs        # 看当前版本 + 将产出的文件名
node scripts/build.mjs          # 干跑校验（阶段一永远走这条）
node scripts/verify.mjs         # 校验 artifacts/ 里的产物 + 生成 SHA256SUMS
```

新增板块：

```powershell
# 1) 编辑 boards.json  2) 生成目录骨架  3) 补 board.json  4) 干跑校验
node scripts/scaffold-boards.mjs
```

## 结构速览

| 路径 | 作用 |
|---|---|
| `distribution.json` | 版本唯一来源（改版本只走 `version.mjs`） |
| `boards.json` | 板块唯一事实源（必装/可选/占位 + 依赖） |
| `boards/<id>/` | 每个板块的 `board.json`；资产类板块另有 `asset-manifest.json` |
| `runtime/` | Node 检测口径与只读检测脚本（缺则提示，绝不静默安装） |
| `installer/shell/` | Electron 壳（最小可运行，`node --check` 通过） |
| `installer/wizard/` | 向导页骨架（5 步 + LV0 协议页 + 错误重试面板） |
| `scripts/` | 构建/版本/校验/板块脚手架 |
| `artifacts/` | 产物输出（git 忽略） |

## 阶段纪律

| 阶段 | 产出 | 状态 |
|---|---|---|
| 一 | 骨架 + 文档，不出包 | ✅ 已完成 |
| 二 · 第 1 步 | **运行环境检测接通**（IPC + 状态机 + E-101/E-102 真机复现） | ✅ 已完成 |
| 二 · 第 2 步 | **安装线**：staging → 校验 → 原子替换 → 回滚（A2 验收） | ✅ 已完成 |
| 三 · 丙 | **便携 zip**（内置 Electron 运行时 + 真实载荷，139 MB） | ✅ 已完成 |
| 三 · 丁 | 安装器 exe + 签名 + 自动更新 + 装后板块增删 | 待做（backlog D-004，首次对外发版前启动） |
| 三 · 契约 | 板块契约 v2（schema/smoke 闸门/事件总线/中文交付目录） | ✅ 已完成 |

`build.mjs --stage 2|3` 仍会被**明确拒绝**（退出码 3）：安装线跑通了，但**出包还没做**，别把"能装"误解成"能发"。

### 三态自检（阶段二第 1 步的验收动作）

```powershell
node scripts/test-detect-node.mjs      # OK / E-101 / E-102 三个用例，期望「通过 14 项」
node scripts/test-install-line.mjs     # 安装线故障注入，期望「通过 40 项」
node ../scripts/smoke-test.mjs         # 全路径冒烟（向导→安装→LV0），期望 PASS

# 真实 Electron 里跑 IPC 并截图（会闪现窗口约 1 秒）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 关键：否则 Electron 会当 Node 跑
$env:DSH_TRAINING_SELFTEST = "1"
cd installer/shell
.\node_modules\electron\dist\electron.exe .          # 期望 RESULT=PASS
# 失败态单独验：
#   E-102 → $env:DSH_TRAINING_NODE_MIN="99.0.0"; $env:DSH_TRAINING_SELFTEST_EXPECT="E-102"
#   E-101 → $env:Path="C:\Windows\System32";     $env:DSH_TRAINING_SELFTEST_EXPECT="E-101"
# 截图落在 artifacts/qa/selftest-wizard-<CODE>.png，报告在 artifacts/qa/selftest-report.json
```

## 详细文档

- 构建/改版本/错误码/验收标准 → [`../docs/安装包构建说明.md`](../docs/安装包构建说明.md)
- 新手安装流程 → [`../docs/下载者安装手册.md`](../docs/下载者安装手册.md)
- 验收与回退（A1-A6 / 故障注入 / 人工回退） → [`../docs/验收与回退手册.md`](../docs/验收与回退手册.md)
- 发版测试报告模板 → [`../docs/发版测试报告模板.md`](../docs/发版测试报告模板.md)
