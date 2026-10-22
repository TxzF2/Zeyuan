# characters/ · 角色资产（TxzF / 长征姬）

> 两个角色的 3D 资产由 **Blender 脚本流水线**生成，可一键重建。
> ⚠️ 本项目里**没有「AI-Blender 面板」**（DSH 无该插件），因此一律走 Blender CLI + bpy 脚本。

## 1. 角色索引

| 角色 | ID | 状态 | 产物 | 文档 |
|---|---|---|---|---|
| 星辰（TxzF） | `txzf` | M1 白模 ✅ M2 材质 ✅ M3 骨骼 ✅ M4 六动作 ✅ M5 导出 ✅ | `txzf.blend`、`txzf_rigged.blend`、`txzf.fbx`（2.8 MB）、21 张渲染 | [spec.md](txzf/docs/spec.md) |
| 长征姬 | `changzhengji` | M1 白模 ✅ M2 材质 ✅ 徽章 ✅ ｜ 骨骼/5 动作/过场 ⏳ | `changzhengji.blend`、5 张渲染 | [storyboard.md](changzhengji/docs/storyboard.md) |

## 2. 重新加载 / 重建（没有面板，用这两条命令）

路径（注意 Blender 装在 `New Folder` 这个目录名里）：

```powershell
$blender = "D:\Program Files\Blender Foundation\Blender 5.2\New Folder\blender.exe"
$root = "C:\Users\29496\.dsh\plugin-sources\dsh-training\characters"
```

**方式 A · 直接打开工程（改完手动保存）**

```powershell
& $blender "$root\txzf\out\txzf_rigged.blend"          # 含骨骼 + 6 动作
& $blender "$root\changzhengji\out\changzhengji.blend"  # 含材质（暂无骨骼）
```

**方式 B · 脚本重建（可复现，推荐）**

```powershell
# TxzF 全流程：白模 → 材质 → 骨骼/动作/导出/三视图
& $blender -b --factory-startup --python "$root\txzf\scripts\build_body.py"
& $blender -b --factory-startup --python "$root\txzf\scripts\materials_final.py" -- --samples 32
& $blender -b --factory-startup --python "$root\txzf\scripts\build_rig_anim.py"

# 长征姬（当前只有 M1+M2）
& $blender -b --factory-startup --python "$root\changzhengji\scripts\build_changzhengji.py"
```

> 若你希望有「图形化面板」：需要另做 DSH 板块 `dsh-blender-panel`
> （主进程 HTTP 路由调 `blender -b` + 设置面板放三个按钮）。目前**未做**，这是独立工程量。

## 3. 资产如何被 dsh-training-protocol 插件调用

插件侧当前是占位（`enabled: false`）：

```ts
// plugins/dsh-training-protocol/src/agents.config.ts
{ name: '星辰（TxzF）', source: 'todo:txzf',  role: 'guide',    enabled: false }
{ name: '长征姬',       source: 'todo:changzhengji', role: 'reviewer', enabled: false }
```

**约定（阶段三落地）**

| 步骤 | 做法 |
|---|---|
| 1 打包 | `characters/<id>/out/` 的资产复制进安装包板块 `character-<id>/`（见 `packaging/boards.json`） |
| 2 注册 | 把 `source` 从 `todo:` 改成 `board:character-txzf` / `board:character-changzhengji`，并置 `enabled: true` |
| 3 触发 | **LV0→LV1 授权成功**时（`tryGrant()` 返回 true）播放长征姬的 13 s 协议过场，播放期间不可跳过 |
| 4 动作 | 过场用 `cz_*` 动作；授权成功界面用 `txzf_authorize`；结算用 `txzf_settle`（金币粒子在引擎侧加） |

**粒子/特效的边界**：FBX 不含 Blender 粒子系统与星尘小球。粒子类效果（星尘、金币、粒子字幕、星环）
必须在引擎侧重建。已给锚点：

- 星尘环绕：`txzf_idle` 的 `CoatHem.*` 摆动轨迹即为粒子环绕参考；
- 金币收拢：`txzf_settle` 双手收拢的帧位（72 帧）为粒子汇聚中心点；
- 星环扩散：长征姬动作 4 的 `Hips` 高度作为环心。

## 4. 面数与预算

| 角色 | 基础网格 | 细分后（实际渲染/导出） | 预算 | 余量 |
|---|---|---|---|---|
| TxzF | 10,572 tris | **20,480 tris** | 28–30k | ✅ 还有 8–10k 可加细节 |
| 长征姬 | 8,360 tris | **18,392 tris** | 28–30k | ✅ 还有 10k+ |

## 5. 已知质量边界（诚实说明）

这套资产是**程序化风格化建模**，不是手工雕刻的高模：

- 面部 = 低模球体 + 五官贴片，近景不够"高精度"；
- 大衣 = 放样锥筒，没有布料褶皱与缝线；
- 手指 = 4 片薄片 + 简化指骨。

**能做到**：准确比例、清晰剪影、四色材质体系、星辰眼自发光、骨骼蒙皮、6 组可用动作、可复现构建。
**做不到（当前）**：电影级面部解剖、真实布料褶皱、毛发丝状细节。

下一轮优先项见各角色文档的「已知短板」表。

_最后更新：2026-10-22 ｜ Blender 5.2.2 LTS ｜ Cycles CPU_
