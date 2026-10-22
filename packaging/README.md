# packaging/ · dsh-training 安装包工程

> 给**维护者**看的入口。学员请看 [`../docs/下载者安装手册.md`](../docs/下载者安装手册.md)。

## 这是什么

dsh-training 安装包的构建工程。当前处于 **阶段一（骨架）**：结构、脚本、文档就位，
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
| 一 | 骨架 + 文档，不出包 | ✅ 当前 |
| 二 | 便携 zip（内置运行时 + 向导可跑通） | 待做 |
| 三 | 安装器 exe + 签名 + 自动更新 + 板块增删 | 待做 |

`build.mjs --stage 2|3` 在阶段一会被**明确拒绝**（退出码 3），防止误产出成品。

## 详细文档

- 构建/改版本/错误码/验收标准 → [`../docs/安装包构建说明.md`](../docs/安装包构建说明.md)
- 新手安装流程 → [`../docs/下载者安装手册.md`](../docs/下载者安装手册.md)
