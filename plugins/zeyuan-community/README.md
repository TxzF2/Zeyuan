# zeyuan-community · 社区

| 项 | 内容 |
|---|---|
| 板块 | `feature-community`（契约 v2，status=ready） |
| 版本 | 0.1.0 |
| 消费 | `zeyuan:feature-workbench:draft-published` → 生成**帖子草稿** |
| 事件 | emits：`post-drafted` / `post-published` / `post-liked` / `post-hidden` / `post-unhidden` / `post-deleted` |

## 1. 为什么"不直接发帖"

工作台草稿发布后**不直接公开**，而是生成一份帖子草稿，作者在社区面板点「发布」才公开：

```
工作台草稿(draft) --author:publish--> draft-published 事件
                                        │
                                        ▼
                              帖子草稿(post draft) --author:publish--> 公开
```

理由：学员提交的答案直接公开，错了就没机会改；草稿→确认→发布给作者一次**自检机会**，
这是泽元社区与灌水论坛的区别。

## 2. 三态与可见性

| 状态 | 谁能看 |
|---|---|
| `draft` | 仅作者（他人请求详情返回 **404**，不泄漏存在性） |
| `published` | 所有人 |
| `hidden` | 作者 + 管理员 |

可见性判定收敛在纯函数 `canSee(post, actor, isAdmin)`，列表/详情/点赞/删除全部走它。

## 3. 路由（11 条）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/me` | 无（返回 level / isAdmin） |
| GET | `/list?status=&tag=&author=&q=` | 无（按可见性过滤） |
| GET | `/detail?id=` | 无（不可见 → 404） |
| POST | `/draft` `/save` `/publish` `/delete` | LV1；save/publish 需作者且为 draft；delete 仅作者 |
| POST | `/like` | **不限身份**（toggle，返回 `{post, liked}`） |
| POST | `/hide` `/unhide` | 需 `training:admin` scope |
| POST | `/replay` | LV1；手动补扫 `draft-published` |

错误码：`E-1001` 状态不允许（409）、`E-1002` 无权限（403）、`E-1003` 字段非法（400）、`E-1004` 不存在/不可见（404）、`E-1005` 需要管理员（403）、`E-1010/1011/1012` 存储类。

## 4. 数据

`%LOCALAPPDATA%\zeyuan\data\posts.json`（原子写 + 文件锁 + `consumed[]` 幂等表）。
内容继承：消费事件时只读同机 `data/drafts.json` 取标题/正文/标签，取不到才退回占位。

幂等双保险：事件 id 去重 + `sourceDraftId` 去重。

## 5. UI

设置 → 「**泽元 · 社区**」：筛选（全部/公开/我的/隐藏）、帖子卡片（状态徽标/作者/❤️点赞/#标签）、详情（正文 Markdown 原样展示 + 点赞 + 作者操作 + 管理员隐藏/恢复）。墨绿 + 星辰金。

## 6. 测试（3 套 / 100 项）

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `test-community-model.mjs` | 34 | 校验、可见性矩阵、三态迁移、点赞 toggle、从事件建稿 |
| `test-community-bus.mjs` | 19 | 内容继承、双去重、补扫、存储韧性 |
| `test-community-routes.mjs` | 47 | 11 路由、可见性矩阵、权限、点赞 toggle、管理员隐藏、总线联动、replay |

## 7. 已知限制

1. **admin 是整机 license 的 scope，不是按用户**——签发带 `training:admin` 的凭据后，本机任何身份都算管理员。用户级管理员要等 3.5 控制面板做 scope 下发与用户绑定（backlog D-007）。
2. 评论区推迟（backlog D-005）：依赖更完整的身份/权限体系。
3. 无分页/搜索排序（列表一次性返回；数据量大了再加）。
4. 第三份 store 副本（tasks/workbench/community），抽取共享模板记 backlog D-006。
