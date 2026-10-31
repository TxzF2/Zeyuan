# 《数据层 SQLite 升级方案》（W2-补）· 待审

| 项 | 内容 |
|---|---|
| 版本 | v0.1（2026-10-25，方案稿，**未执行**） |
| 范围 | tasks / community / exchange 的 JSON 存储 → SQLite |
| 完成期限 | **2026-11-06（周五）完成并冻结**，距双 11 留 5 天观察期 |
| 状态 | 待总控批复（含 4 个决策点，见第 10 节） |

---

## 1. 现状盘点（实测，非估算）

### 1.1 数据量

| 文件 | 大小 | 记录数 |
|---|---|---|
| tasks.json | 4.7 KB | **8** 条任务 |
| posts.json | 1.2 KB | **2** 帖 |
| comments.json | 0.7 KB | **2** 条评论 |
| drafts.json | 1.5 KB | 3 草稿 |
| wallet.json | 0.5 KB | 2 条流水 |
| groups.json | 1.0 KB | 1 组 |
| coin-requests.json | 0.4 KB | 1 单 |
| admins/scopes/users | <1 KB ×3 | 3 / 少量 / 4 |
| exchange/ | 1 个文件 | 1 条 meta + 1 个 bin |

**结论：这不是性能问题。** 迁移的真实收益是：

1. **并发安全**：现在靠 `withLock` 文件锁 + 读改写，写冲突只能靠 2s 超时兜底；
2. **原子性**：跨文件操作（任务验收 → 钱包入账 → 审计）现在无法真正事务化；
3. **可查询**：审计/事件/评论目前只能全量读 JSON/JSONL 再过滤。

> 因此方案按"正确性优先、低风险"设计，**不做**分库分表、不做读写分离这类过度工程。

### 1.2 代码现状

| 事实 | 影响 |
|---|---|
| **7 个插件各有一份 `store.ts`**（162–203 行，内容 95% 相同） | 迁移必须同时处理 D-006（共享 store），否则会有 7 套 SQLite 实现 |
| 现有 `store.ts` 都提供 `readJson / writeJsonAtomic / withLock / appendJsonl` | 可定义同名接口做"同签名替换"，降低改动面 |
| `event-log.jsonl` 在状态根目录，`audit-log.jsonl` 在 data/ | 事件/审计是否入库需单独决策 |
| exchange 的 `.bin` 是大文件（≤500MB） | **bin 必须留在文件系统**，只把 meta/分片状态入 SQLite |

### 1.3 运行时可行性

| 项 | 实测 |
|---|---|
| Node（宿主） | v24.21.0，`node:sqlite` **可用**（`DatabaseSync / StatementSync / backup`） |
| Electron | `^45.0.0`（随 DSH 桌面端启动插件） |
| 现有依赖 | **无** 任何 sqlite 依赖 |

> ⚠️ 关键未知：Electron 45 内置 Node 是否暴露 `node:sqlite`。**必须先做 1 小时 spike 验证**（见 4.1），这决定选型。

---

## 2. 目标 / 非目标

### 目标（DoD 由第 11 节定义）

1. tasks / community / exchange(meta) 三类数据落 SQLite，单文件库，WAL 模式；
2. 跨表操作可事务（验收扣赏金、验收+审计、评论+事件）；
3. 旧 JSON 数据**零丢失**迁移，可回滚；
4. 41 套回归保持全绿，新增 ≥9 套 SQLite 专项，真机逐板块对账；
5. 顺手收敛 D-006（共享 store 层）。

### 非目标

| 不做 | 原因 |
|---|---|
| 迁移 wallet / admins / scopes / users / im 配置 | 本轮限定三板块；但**会形成混合存储**，需在第 10 节决策 |
| 迁 exchange 的 `.bin` 与分片文件 | 大文件不适合入库；SQLite 只存索引 |
| 引入 ORM（Prisma/Drizzle） | 数据量与团队规模不需要，原生 SQL + DAO 更透明 |
| 在线双写/零停机迁移 | 数据量 8 条，双写复杂度远超收益；用 5 分钟停机窗口 |
| 向量/全文检索 | 后续再说 |

---

## 3. 选型对比

| 维度 | **node:sqlite**（内置） | better-sqlite3（npm） |
|---|---|---|
| 依赖 | 零依赖，随 Node 提供 | 原生模块，需 `prebuild`/`node-gyp` |
| Electron 兼容 | 取决于 Electron 内置 Node 版本（**需 spike**） | **必须按 Electron ABI 重编译**（`electron-rebuild`），发版链路复杂 |
| API 成熟度 | **实验性**（Node 22+，API 可能变） | 成熟稳定，社区大 |
| 性能 | 同步 API，够用（数据量极小） | 更好，但此场景无差异 |
| 打包体积 | 0 | +几 MB，且需带 ABI 正确的 .node |
| 风险 | Electron 未暴露 / API 变更 | 每次 Electron 升级都要重编 |

**建议：优先 `node:sqlite`**，理由：无原生依赖 = 发版与跨机器最稳（我们刚被 pnpm junction/ABI 坑过）。
**前置门禁**：spike 必须验证 `Electron 45 + node:sqlite` 能开库、能读写、能 `backup`；失败则回退 `better-sqlite3`（方案其余部分不变，仅换驱动层）。

---

## 4. 技术方案

### 4.1 阶段 0 · Spike（0.5 天，10-26 上午）

| 验证项 | 通过标准 |
|---|---|
| Electron 主进程 `require('node:sqlite')` | 能 `new DatabaseSync(path)` 并执行 `SELECT 1` |
| WAL + 并发 | 两次连接同时写不死锁，`busy_timeout` 生效 |
| 备份 | `backup()` 能产出可打开副本 |
| 兜底 | 若不可用 → 切 better-sqlite3，记录 ABI 重编译步骤 |

### 4.2 库与表（单库 `data/zeyuan.db`）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, creator TEXT NOT NULL, assignee TEXT, group_id TEXT,
  bounty INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
  deadline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]'      -- JSON 数组（轨迹，量小）
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_group ON tasks(group_id);

CREATE TABLE posts (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  hidden_at TEXT, hidden_by TEXT
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, hidden_at TEXT, hidden_by TEXT, deleted_at TEXT
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);

CREATE TABLE exchange_files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, mime TEXT NOT NULL, uploader TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE exchange_uploads (            -- 分片续传会话
  upload_id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL, uploader TEXT NOT NULL,
  status TEXT NOT NULL, file_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE exchange_chunks (
  upload_id TEXT NOT NULL REFERENCES exchange_uploads(upload_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY (upload_id, idx)
);

CREATE TABLE events (                      -- 事件日志入库（可选，见决策 3）
  id TEXT PRIMARY KEY, event TEXT NOT NULL, ts TEXT NOT NULL,
  actor TEXT, payload TEXT NOT NULL
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_name ON events(event);
```

**设计取舍**

| 点 | 决定 | 理由 |
|---|---|---|
| 单库 vs 分库 | **单库** | 跨板块事务（任务验收 → 钱包 → 审计）需要；备份=拷一个文件 |
| 非结构化字段（history/tags/payload） | 存 TEXT(JSON) | 量小、结构易变，不为此拆表 |
| exchange bin | 留文件系统 | 大文件与 SQLite 天然不适合；DB 只存 meta/分片状态 |
| 主键 | 业务 id（TEXT） | 现有 id 已稳定（`t-`/`p-`/`c-`/uuid），迁移直接沿用，避免 id 重映射 |

### 4.3 存储层重构（**合并 D-006**）

```
packages/zeyuan-store/           ← 新增共享包（7 份 store.ts 收敛为 1 份）
  src/db.ts       打开库、PRAGMA、迁移执行器
  src/tx.ts       withTransaction(fn) —— 替代 withLock
  src/dao/tasks.ts·posts.ts·comments.ts·files.ts·events.ts
  src/json-compat.ts  readJson/writeJsonAtomic（保留给未迁移模块过渡）
```

各插件改为 `import { tasksDao } from '@zeyuan/store'`，**对外 API 语义不变**，内部换存储。

### 4.4 数据迁移器 `scripts/migrate-sqlite.mjs`

| 能力 | 说明 |
|---|---|
| `--dry-run`（默认） | 读 JSON → 统计将写入的行数、检查引用完整性（评论的 post 是否存在），只打印 |
| `--apply` | 备份 `data/*.json` → 建库 → 写入 → 校验 → 打印报告 |
| 校验 | 行数比对、主键集合比对、关键字段抽样哈希比对、引用完整性查询 |
| 幂等 | 已有 `schema_migrations` 记录则跳过；重复执行不重复插入 |
| 回滚 | `--rollback` 删除 `zeyuan.db*`，JSON 备份原地恢复（旧文件在整个过程中不删） |
| 停机窗口 | 关闭 DSH → 迁移 → 启动。预计 **< 5 分钟**（8 条任务级别） |

---

## 5. 回归计划

### 5.1 分层

| 层 | 内容 | 门禁 |
|---|---|---|
| L1 单测 | 41 套现有 + **新增 9 套**（见 5.2） | 必须全绿，才允许真机 |
| L2 契约 | `check-boards` 11 板块 + `check-event-schema` | 必须 PASS |
| L3 真机 | 每板块一条主流程（见 5.3） | 必须全绿 |
| L4 数据一致性 | `scripts/check-sqlite.mjs`：JSON 备份 vs DB 逐表比对 | 必须 0 差异 |

### 5.2 新增测试（10 套 → 总 51）

| 套件 | 覆盖 |
|---|---|
| `test-store-db.mjs` | 建库/PRAGMA/迁移执行器幂等 |
| `test-store-tx.mjs` | 事务回滚、嵌套、并发两连接 busy_timeout |
| `test-tasks-sqlite.mjs` | 任务 CRUD、状态机、history 序列化 |
| `test-community-sqlite.mjs` | 帖子/评论、级联删除、隐藏可见性 |
| `test-exchange-sqlite.mjs` | meta/分片会话落库、过期查询、孤儿扫描 |
| `test-migrate-sqlite.mjs` | dry-run 不写盘、apply 幂等、校验失败回滚 |
| `test-json-db-parity.mjs` | 同一组操作，JSON 版与 DB 版结果等价（差分测试） |
| `test-events-db.mjs` | 事件入库与查询（若决策 3 选"入库"） |
| `test-backup-restore.mjs` | 备份 → 删库 → 恢复 → 数据一致 |
| `test-abi-spike.mjs` | Electron 下开库冒烟（spike 产物固化） |

### 5.3 真机对账（每板块 ≥15 项）

| 板块 | 必验 |
|---|---|
| tasks | 发布→领取→提交→验收（赏金事件）→ 驳回→再领取；`/zeyuan/tasks/list` 分页与筛选 |
| community | 发帖→评论→P6 隐藏→作者软删→删帖级联评论消失 |
| exchange | 上传→列表→下载 sha 一致→删除→分片续传 → sweep 清理 |
| 全局 | 重启后数据仍在；`/zeyuan/console/health` 对账 ok |

---

## 6. 排期（10-26 → 11-06，含缓冲）

| 日期 | 内容 | 产出 / 门禁 |
|---|---|---|
| 10-26 周一 | **Spike**（Electron+node:sqlite）+ 本方案评审会 | 选型结论；方案 v1.0 定稿 |
| 10-27 周二 | 共享包骨架 `packages/zeyuan-store`（db/tx/migrations） | `test-store-db`/`test-store-tx` 绿 |
| 10-28 周三 | tasks DAO + 迁移器（tasks 部分） | tasks 单测绿、差分测试绿 |
| 10-29 周四 | tasks 接线 + 真机对账 | tasks 真机全绿 |
| 10-30 周五 | community DAO（posts/comments/级联） | community 单测绿 |
| 10-31 周六 | community 接线 + 真机对账 | 真机全绿（周末机动） |
| 11-01 周日 | exchange meta/分片入 SQLite（bin 不动） | exchange 单测绿 |
| 11-02 周一 | exchange 接线 + 真机（含 200MB 续传回归） | 真机全绿 |
| 11-03 周二 | **迁移器全量演练**（备份→迁移→校验→回滚→再迁移） | L4 一致性 0 差异 |
| 11-04 周三 | 全量回归 51 套 + 三板块真机复跑 | 全绿；不绿则修复 |
| 11-05 周四 | 文档（验收手册/契约/升级说明）+ 出包 v0.5.0 | 包冒烟 PASS |
| **11-06 周五** | **合流 main + 冻结（双11 前最后一版）** | 冻结公告 |
| 11-07 ~ 11-10 | 只允许 hotfix，不引入新特性 | — |
| 11-11 周二 | 双 11 观察 | — |

> 缓冲设计：10-31 与 11-04 两个机动日；任一日拖期 > 0.5 天即触发"砍范围"预案（先保 tasks+community，exchange 顺延到 11-07 后）。

---

## 7. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| Electron 45 不暴露 `node:sqlite` | 中 | 需换 better-sqlite3，+1 天 | Spike 放在第 1 天；备选方案已列 |
| better-sqlite3 ABI 重编译失败 | 中 | 发版链路风险 | 只在 spike 失败时启用；预置 `electron-rebuild` 脚本 |
| 混合存储（console/wallet 仍 JSON）导致事务断裂 | **高** | 验收扣赏金无法跨库事务 | 决策 2：是否把 wallet 一并纳入（强烈建议纳入） |
| 迁移丢数据 | 低 | 严重 | JSON 全程不删 + 备份 + 行数/哈希校验 + 回滚演练 |
| 7 份 store 收敛时行为漂移 | 中 | 隐蔽 bug | 差分测试（同操作 JSON vs DB 结果比对） |
| 并发写 WAL 文件损坏 | 低 | 中 | `busy_timeout` + 单进程写（插件同进程）+ 每日备份 |
| 双 11 前不完 | 中 | 影响大促 | 11-06 硬冻结 + 砍范围预案 |

---

## 8. 回滚预案

1. 迁移前自动备份 `data/*.json` 到 `data/.json-backup-<ts>/`；
2. 旧 JSON **不删除**（整轮迁移期间保留只读副本）；
3. 回滚 = 删 `zeyuan.db*` + 恢复备份 + 回退插件版本（包内自带 v0.4.0 兜底）；
4. 回滚演练放在 11-03，**必须实际执行一次**并记录耗时。

---

## 9. 对现有承诺的影响

| 承诺 | 影响 |
|---|---|
| 41 套回归全绿 | 升级为 **51 套** |
| 板块契约 v2 | 不变（板块边界不动，仅存储实现变） |
| 事件统一信封 | 不变；若决策 3 选择事件入库，则 `events` 表与 JSONL 并存一个版本 |
| 迁移脚本（泽元改名） | 不受影响；SQLite 迁移是独立脚本 |
| D-009 国内镜像 | 独立推进，不冲突 |

---

## 10. 需总控决策（4 项）

| # | 决策点 | 选项 | 我的建议 |
|---|---|---|---|
| 1 | 驱动选型 | A `node:sqlite`（零依赖，实验性）/ B `better-sqlite3`（成熟，需 ABI 重编） | **A**，spike 失败再切 B |
| 2 | 迁移范围 | A 仅 tasks/community/exchange / B 加上 wallet+admins+scopes（消除混合存储） | **B**（否则"验收扣赏金"仍跨存储、无事务） |
| 3 | 事件日志 | A 继续 JSONL / B 入库 `events` 表（JSONL 留一个版本双写） | **B**，查询/审计才有价值 |
| 4 | 停机窗口 | A 5 分钟停机迁移 / B 双写零停机 | **A**（数据量小，双写成本远超收益） |

---

## 11. DoD（验收标准）

1. `data/zeyuan.db` 存在且 WAL 生效；`schema_migrations` 版本 = 设计版本；
2. 三（或六）类数据行数与 JSON 备份**逐表一致**，主键集合一致，抽样哈希一致；
3. 51 套回归全绿；`check-boards` + `check-event-schema` PASS；
4. 三板块真机各 ≥15 项全绿，含"重启后数据仍在"；
5. 回滚演练成功且耗时 < 8 分钟；
6. 出包 v0.5.0，包本体冒烟 PASS；
7. 文档更新：验收手册新增 4.19、契约现状表、升级说明（含迁移命令）。

---

_待总控批复后进入 10-26 Spike。本文档不含任何代码改动。_
