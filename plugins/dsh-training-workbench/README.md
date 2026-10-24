# dsh-training-workbench · 工作台

| 项 | 内容 |
|---|---|
| 板块 | `feature-workbench`（契约 v2，status=ready） |
| 版本 | 0.1.0 |
| 依赖 | `core`（授权闸门 LV1） |
| 事件 | emits `draft-opened` / `draft-saved` / `draft-published`；consumes `dsh-training:tasks:task-accepted` |

## 1. 事件消费（本板块核心）

两条路径保证不丢事件：

| 路径 | 说明 |
|---|---|
| **在线** | `tasks` 插件发布事件时 `ctx.emit`，工作台 `ctx.on('dsh-training:tasks:task-accepted')` 立即建草稿 |
| **补扫** | 工作台挂载时读 `event-log.jsonl`，把未加载期间错过的 `task-accepted` 补消费 |

**owner 兜底**：
事件带 `assignee`/`to` 优先；若缺失（旧事件），从 `tasks:reward` 的 `to` 反查领取人。

**幂等双保险**：

1. 事件 id 去重（`drafts.json` 的 `consumed[]`，保留最近 2000 条）；
2. `sourceTaskId` 去重（同一任务只建一份草稿，即使事件 id 不同）。

## 2. 草稿模型

```jsonc
{ "id": "d-20261024-0001", "title": "任务 t-… 的交付", "body": "",
  "tags": ["t-20261024-0001"], "owner": "alice",
  "sourceTaskId": "t-20261024-0001", "sourceEventId": "ev-…",
  "status": "draft", "createdAt": "…", "updatedAt": "…", "publishedAt": null }
```

状态：`draft → published`（发布后只读）。标题继承任务号，正文由学员填写（Markdown）。

## 3. 路由（7 条）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/dsh-training/workbench/me` | 无 |
| GET | `/dsh-training/workbench/list?status=&mine=1` | 无 |
| GET | `/dsh-training/workbench/detail?id=` | 无 |
| POST | `/create` `/save` `/publish` | LV1；`save`/`publish` 还要求是草稿 owner |
| POST | `/replay` | LV1；手动补扫事件日志（运维兜底） |

错误码：`E-901` 已发布不可改（409）、`E-902` 非本人草稿（403）、`E-903` 字段非法（400）、`E-904` 不存在（404）、`E-910/911/912` 存储类。

## 4. 数据

```
%LOCALAPPDATA%\dsh-training\data\drafts.json        草稿 + consumed 幂等表
%LOCALAPPDATA%\dsh-training\data\drafts.json.lock   文件锁
```

原子写（tmp → fsync → rename）；损坏备份为 `drafts.json.corrupt-<ts>` 并报 `E-910`，不覆盖原文件。

## 5. 前端

设置 → 「**培训班 · 工作台**」：草稿列表（状态筛选、来源任务徽标）、编辑区（标题 / 标签 / Markdown 正文）、保存 / 发布按钮。墨绿 + 星辰金。

## 6. 测试（3 套 / 76 项）

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `test-workbench-model.mjs` | 26 | 校验、状态迁移、owner 权限、从事件建草稿 |
| `test-workbench-bus.mjs` | 20 | 在线消费、双去重、补扫、损坏/锁 |
| `test-workbench-routes.mjs` | 30 | 6 路由、LV0 拦截、越权、发布约束、总线联动、事件 |

## 7. 已知限制

1. 正文纯文本 Markdown（不引富文本编辑器）；
2. `draft-published` 暂无消费方（社区板块待做）；
3. 草稿无版本历史（只有 `createdAt/updatedAt/publishedAt`）。
