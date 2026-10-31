# Gitee 镜像迁移步骤清单（只出清单，不动手）

| 项 | 内容 |
|---|---|
| 依据 | 参谋长 2026-10-31 裁决 1：本周内 Gitee 镜像立项，**先出迁移步骤清单（不动手）**；仓库与令牌由总控提供 |
| 范围 | 把 v0.4.0 的**发布资产**镜像到 Gitee，并把下载页切换为"网盘/ Gitee 优先、GitHub 兜底" |
| 前置 | Gitee 账号（需手机实名，总控提供）、仓库地址、私人令牌（projects 权限） |
| 状态 | **仅清单**，未执行；执行需开工令 |

---

## 1. 准备（总控提供，约 10 分钟人工）

| # | 事项 | 产出 | 负责人 |
|---|---|---|---|
| P1 | Gitee 账号实名 + 建仓库（建议 public，名 `zeyuan`） | 仓库地址 `gitee.com/<owner>/zeyuan` | 总控 |
| P2 | 生成私人令牌（勾 `projects` 读写） | 令牌（**只放本机 env，不入库**） | 总控 |
| P3 | 确认 Gitee 是否支持 Release 附件、单文件上限 | 结论（若单文件 ≤100MB 则整包；否则分卷） | 我（只查文档，不执行） |

---

## 2. 迁移步骤（执行时才做，共 7 步）

| 步 | 动作 | 命令/要点 | 验收 |
|---|---|---|---|
| S1 | 本地加远端 | `git remote add gitee https://<owner>:<token>@gitee.com/<owner>/zeyuan.git` | `git remote -v` 显示两个远端，**token 不回显**（用 env 变量） |
| S2 | 推主分支 | `git push gitee main` | Gitee 主页能看到最新提交（与 GitHub 同一 commit hash） |
| S3 | 推 tag | `git push gitee v0.4.0` | Gitee tag 页出现 v0.4.0 |
| S4 | 上传发布资产 | ① 若 Gitee Release 支持：建 Release 传 zip；② 否则用 Gitee "发行版"或仓库附件，上传 6 卷 + PARTS + 教程 | 每个资产可下载且 SHA256 与本地一致 |
| S5 | 下载页改造 | `docs/download-links.json` 的 `mirror.url` 填 Gitee 发布页；`pan` 保持网盘优先 | 页面生成后"镜像通道"显示可点链接 |
| S6 | 冒烟验证 | 从 Gitee 下载 1 卷 → 校验 SHA256 → 合并 → 整包哈希 | 整包 = `32590CB9…` |
| S7 | 双通道一致性 | GitHub 与 Gitee 的 tag、资产哈希对齐表 | 差异 0 |

---

## 3. 验证口径（防自欺）

| 层 | 标准 |
|---|---|
| V1 可达性 | Gitee 资产 URL 返回 200，`Content-Length` 与文件大小一致 |
| V2 完整性 | 逐卷 SHA256 = `PARTS.txt`；整包 = `32590CB9d1f91a0219feedd3ffffe74bf3a47960e18ee04943a50eded54d2dce` |
| V3 可用性 | 合并后解压，`zeyuan-installer.exe` 存在且可运行向导 |
| V4 一致性 | GitHub / Gitee 两边同 tag 的资产哈希逐项相等 |

---

## 4. 回滚

| 场景 | 动作 |
|---|---|
| Gitee 推送出错 | `git push gitee --delete <branch>` 或删除仓库重建；本地无影响 |
| 资产哈希不符 | 删除该资产重传；页面 `mirror.url` 置空回到"立项中" |
| 页面改坏 | `git checkout -- docs/download.html docs/download-links.json` 重生成 |

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| Gitee 单文件上限（通常 100MB） | 整包 149.35MB **超限** → 传 6 个 25MB 分卷（已验证可合并） |
| Gitee 免费仓库有流量/容量限制 | 只放当前版本 + 上一版本，老版本删附件保留 tag |
| 实名账号归属 | 由总控指定归属人，**我不持有账号** |
| 令牌泄漏 | 令牌只进本机环境变量，脚本读 env，不写文件、不进文档 |
| 双仓不同步 | 每次发版固定顺序：GitHub 先 → Gitee 后 → 页面最后切 → V4 对账 |

---

## 6. 与现有交付的衔接

| 项 | 现状 |
|---|---|
| 下载页网盘位 | ✅ 已就绪（占位等总控链接） |
| Gitee 镜像位 | ✅ 已就绪（`docs/download-links.json` 的 `mirror`，当前显示"立项中"） |
| 分卷资产 | ✅ 仓库 `releases/v0.4.0/` 6 卷 + PARTS + 合并脚本 |
| 待总控 | P1 账号/仓库、P2 令牌 |

---

## 7. 我需要的开工条件（一句话）

> **Gitee 仓库地址 + 令牌（本机 env 注入）** 即可执行 S1–S7；清单里每一步都有验收与回滚，执行不会碰 GitHub 侧。

---

_主控 dsh · 2026-10-31 · 仅清单，未执行_
