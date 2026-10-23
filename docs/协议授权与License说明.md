# 《协议授权与 License 说明》

| 项 | 内容 |
|---|---|
| 对应版本 | `dsh-training-protocol` **v0.3.0** |
| 读者 | 维护者 / 支持人员 / 安全评审 |
| 关联 | 验收项 A6、《验收与回退手册》§4.6、`docs/backlog.md` D-003 |

---

## 1. 协议页在哪里（一处实现，两处可达）

| 入口 | 位置 | 说明 |
|---|---|---|
| **主入口（常驻）** | DSH 应用 → 设置 → **「培训班 · 协议授权」** | 插件注册的 `settings.section` 面板，每次启动可见、可回看签署状态 |
| 次入口（跳转） | 安装向导第 5 步完成页 →「进入协议页」 | 只做跳转提示，**不再单独实现协议页**（避免两套 UI 分叉） |

面板显示：当前等级（LV0/LV1）、六项校验逐项结果、License 详情（学员/范围/签发/到期/签名短码）、文件位置，以及「签署 / 重新校验 / 吊销」三个动作。

## 2. 凭据格式

```json
{
  "version": 1,
  "subject": "学员标识",
  "scopes": ["training:playground"],
  "issuedAt": "2026-10-23T12:00:00.000Z",
  "expiresAt": "2026-11-22T12:00:00.000Z",
  "signature": "<64 位 hex，HMAC-SHA256>"
}
```

- 签名覆盖：除 `signature` 外**全部字段**，按键名排序后 JSON 序列化再 HMAC（`canonicalPayload()`）。
  这样任何字段被改动都会导致验签失败。
- 算法：**HMAC-SHA256**，密钥 32 字节随机（hex 存储）。
- 必需 scope：`training:playground`（进入实训场/陪练）。已知范围：
  `training:playground` / `training:review` / `training:admin`。

## 3. 文件位置与密钥管理（**重要**）

| 文件 | 路径 | 说明 |
|---|---|---|
| License | `%LOCALAPPDATA%\dsh-training\license.json` | 可为空（未签署） |
| 密钥 | `%LOCALAPPDATA%\dsh-training\license.key` | 首次签发时生成，权限 600 |
| 挂载标记 | `%LOCALAPPDATA%\dsh-training\mount-state.json` | A5 证据，含 `level` 与 `licenseCode` |

> 可用环境变量 `DSH_TRAINING_STATE_DIR` 覆盖上述目录（测试隔离用）。

### 3.1 密钥轮换流程

```powershell
$s = "$env:LOCALAPPDATA\dsh-training"

# 1) 备份并退休旧密钥（旧 License 立即失效，这是预期行为）
Move-Item "$s\license.key" "$s\license.key.$(Get-Date -Format yyyyMMddHHmmss).retired"

# 2) 删除旧 License（避免"有凭据但签不了"的尴尬状态）
Remove-Item "$s\license.json" -Force -ErrorAction SilentlyContinue

# 3) 重新签发（走面板「签署协议」或下面的接口）
```

轮换后**所有旧 License 必须重签**——因为验签用的是"当前密钥"。

### 3.2 安全边界（必须写清楚）

| 事实 | 影响 |
|---|---|
| 密钥与 License 都在本机用户目录 | **拿到本机文件的人可以自己签发 License** |
| 签发接口只要求 `confirm:true`（防误触，不防恶意） | 不是鉴权 |
| HMAC 是**对称**算法 | 无法向第三方证明"不是我签的"，也不能做离线公钥验签 |

**定位**：这是**防篡改**（改内容必失效），不是**防伪造**（本机用户可自签）。
如果将来需要"真授权"（学员无法自己造凭据），必须升级为**公钥签名（Ed25519）+ 远程签发服务**——见 `docs/backlog.md` **D-003**。

## 4. 校验流程与错误码

顺序（顺序决定错误码）：**结构 → 密钥存在 → 验签 → 时效 → scope**

| 码 | 含义 | 面板文案 |
|---|---|---|
| `E-601` | 没有 License | 「尚未签署《培训班协议》——没有任何 License」 |
| `E-602` | 签名不符（篡改/损坏） | 「签名不符：内容或签名被改动过」 |
| `E-603` | 已过期 | 「于 <到期时间> 过期，需要重新签署」 |
| `E-604` | scope 不含必需项 | 「scope 不含 training:playground」 |
| `E-605` | 格式非法 | 「License 格式非法（缺字段或版本不匹配）」 |
| `E-606` | 缺密钥 | 「缺少验签密钥，无法验证凭据」 |
| `E-607` | 签发缺确认 | 「签发需要显式确认」 |
| `E-608` | 签发失败 | 内部错误信息 |

## 5. HTTP 接口（面板调用的就是这几条）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-training/protocol/state` | 等级 + 六项校验 + License 摘要 + 文件路径 |
| POST | `/dsh-training/protocol/verify` | 重新判定并返回结果 |
| POST | `/dsh-training/protocol/sign` | 签发（body: `{confirm:true, subject, scopes?, days?}`） |
| POST | `/dsh-training/protocol/revoke` | 删除 License，退回 LV0 |

> 路由只在宿主提供 `ctx.webServer` 时注册；裸 Context（单测/CLI 场景）自动跳过，
> 因此插件本体在任何环境都可挂载，不会因缺 webServer 而拒绝加载。

## 6. 测试与证据

| 测试 | 断言数 | 覆盖 |
|---|---|---|
| `packaging/scripts/test-license.mjs` | **25** | A6 四条：未签(E-601)/已签(OK)/过期(E-603)/篡改(E-602)；边界：scope(E-604)、缺密钥(E-606)、缺字段(E-605)、到期瞬间 |
| `packaging/scripts/test-protocol-routes.mjs` | **22** | 路由注册、未签→LV0、缺 confirm→E-607、签发→LV1、verify、吊销→LV0、disposer 清理 |

```powershell
node packaging/scripts/test-license.mjs
node packaging/scripts/test-protocol-routes.mjs
```

## 7. 已知限制（下一轮）

1. 面板 UI 的**真机截图**需重启 DSH 后在「设置 → 培训班 · 协议授权」确认（我无法在运行中的应用内截图）；
2. 协议页目前是**卡片式**，未做"逐条滚动阅读 + 勾选同意"的正式签署流；
3. 密钥为本地对称密钥（见 3.2），升级路径见 backlog D-003。

_最后更新：2026-10-23 ｜ 插件 v0.3.0_
