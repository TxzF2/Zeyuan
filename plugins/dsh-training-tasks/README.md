# dsh-training-tasks · 任务接发区

| 项 | 内容 |
|---|---|
| 板块 | `tasks`（`packaging/boards/tasks/`，契约 v2，status=ready） |
| 版本 | 0.1.0 |
| 权限 | LV1 才能发布/领取/提交；accept/reject 仅限发起人；领取人才能提交 |

## 1. 状态机

```
open ──claim──► claimed ──submit──► submitted ──accept──► accepted（终态）
  ▲                                     │
  └──────────── reject ─────────────────┘   （清空领取人，可再领取）
```

事件（全部落 `event-log.jsonl`）：

| 动作 | 事件 |
|---|---|
| create | `dsh-training:tasks:task-created` |
| claim | `dsh-training:tasks:task-claimed` |
| submit | `dsh-training:tasks:task-submitted` |
| accept | `dsh-training:tasks:task-accepted` + **`dsh-training:tasks:reward`** |
| reject | `dsh-training:tasks:task-rejected` |

> `reward` 只**声明结算请求**（`{taskId, coins, to, from}`），本板块不记账；金币由货币系统消费。

## 2. 路由（8 条）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/dsh-training/tasks/me` | 无 |
| GET | `/dsh-training/tasks/list?status=&tag=&mine=1` | 无 |
| GET | `/dsh-training/tasks/detail?id=` | 无 |
| POST | `/create` `/claim` `/submit` `/accept` `/reject` | LV1（accept/reject 另需发起人） |

错误码：`E-601~606`（授权）、`E-801` 非法迁移（409）、`E-802` 权限不足（403）、`E-803` 字段非法（400）、`E-804` 不存在（404）、`E-810` 数据损坏、`E-811` 锁超时（503）。

## 3. 数据

```
%LOCALAPPDATA%\dsh-training\data\tasks.json        任务数据（原子写：tmp → fsync → rename）
%LOCALAPPDATA%\dsh-training\data\tasks.json.lock   文件锁（O_EXCL，30s stale，pid 存活检测）
%LOCALAPPDATA%\dsh-training\event-log.jsonl        事件日志（追加）
```

损坏处理：备份为 `tasks.json.corrupt-<ts>` 并抛 `E-810`，**绝不覆盖原文件**。

## 4. 前端

设置 → 「**培训班 · 任务接发**」：任务列表（状态/标签筛选）、详情（描述/发起人/领取人/时间线）、领取/提交/通过/驳回按钮（按状态+权限动态显示）。配色墨绿 + 星辰金，全部走 `--dsw-alias-*` 令牌。

## 5. 测试（4 套 / 139 项）

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `test-tasks-model.mjs` | 44 | 字段校验、状态机全路径、非法迁移、history |
| `test-tasks-store.mjs` | 18 | 原子写、损坏备份、锁超时、stale 回收 |
| `test-tasks-routes.mjs` | 51 | 8 条路由、LV0 拦截、非发起人/非领取人、reward 事件 |
| `test-tasks-license.mjs` | 26 | 与协议插件判定对等（9 类用例）+ 只读性 |

## 6. 已知限制

1. 用户身份取 `x-dsh-user` 头，单机缺省 `local-user`；多用户需接入 DSH 会话身份；
2. `reward` 尚无消费方（货币系统未建），目前只有事件日志 + UI 提示；
3. 任务附件/评论/分页未做（3.1 只要求最小可用）。
