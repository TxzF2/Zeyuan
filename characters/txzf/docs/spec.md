# TxzF · 角色规格与实现记录

| 项 | 值 |
|---|---|
| 角色 ID | `TxzF` |
| 定位 | 男性引导者（星辰 / 路鸣泽气质：少年感与危险感并存，若有似无的笑） |
| 身高 / 头身比 | 1.82 m / 7.5 头身 |
| 面数 | 基础网格 **10,572 tris**；细分开子/实体化后 **20,480 tris**（预算 28–30k，尚有余量） |
| 骨骼 | **26 根**（脊柱 5 + 头颈 2 + 手臂 8 + 手指 2 + 腿 6 + 大衣下摆 3 + 后发 1） |
| 动作 | **6 组**（30 fps），见下表 |
| 材质 | 6 个节点材质（大衣渐变 / 皮肤 / 银 / 深色 / 内衬 / 星辰眼） |
| 交付 | `out/txzf.blend`（材质）、`out/txzf_rigged.blend`（骨骼+蒙皮+动作）、`out/txzf.fbx`（2.8 MB） |

## 配色（四色融合）

| 名称 | 色值 | 用法 | 节点手法 |
|---|---|---|---|
| 黑 | `#0B0E14` | 大衣上身 | Generated Z → ColorRamp → BaseColor |
| 灰 | `#3A4150` | 大衣下摆渐变 | 同上，Roughness 同步做 0.48→0.72 变化 |
| 银 | `#C9D1E0` | 腕饰/袖口/腰带扣/靴口环 | Metallic 1.0，Roughness 0.22，Noise 微凹凸 |
| 蓝 | `#4C7DFF` | 星辰眼、星尘、内衬 | Voronoi 星点 → Emission（0.35）+ Fresnel 边缘微光 |

星辰眼实现：`Voronoi(F1, scale=38)` → `ColorRamp(0→0.12)` → `Emission Color`，
自发光强度 0.35（第一版用 2.6 会把整张脸照成白板，已回退）。

## 6 组动作（30 fps）

| Action | 帧数 | 设计要点 |
|---|---|---|
| `txzf_idle` | 1–120 | 呼吸（Chest ±1.2°）+ 头部微摆 + 大衣下摆延迟摆动 + 后发摆动 |
| `txzf_explain` | 1–90 | 躯干侧转 6°、右臂抬起 42–48°、掌心向上引导视线 |
| `txzf_authorize` | 1–72 | 右臂抬至 72°、前臂内收 56°、手掌前伸（授权确认手势） |
| `txzf_warn` | 1–60 | 躯干后倾 5°、下颌收紧 -8°、双臂外撑 12° |
| `txzf_guide` | 1–84 | 胯部侧转 10° + 侧身回望 + 两次招手（16→30→44→58 帧） |
| `txzf_settle` | 1–96 | 双手虚握收拢 + 手指弯曲 48°（金币粒子收拢的肢位锚点） |

> 动作是**骨骼关键帧**，不含粒子。金币/星尘粒子属引擎侧特效，见 README 的「调用约定」。

## 骨骼清单（26）

`Hips / Spine / Chest / UpperChest / Neck / Head`
`Shoulder.L/R / UpperArm.L/R / LowerArm.L/R / Hand.L/R / Finger.L/R`
`Thigh.L/R / Shin.L/R / Foot.L/R`
`CoatHem.L/R/Back`（大衣下摆三向摆骨）· `HairTail`（后发）

命名按 Mixamo 风格，FBX 导出时 `bake_anim_use_all_actions=True`，6 个 Action 全部带入。

## 文件清单

```
characters/txzf/
├─ scripts/
│  ├─ dsh_lib.py            公共建模库（放样/管状/材质/相机/渲染）
│  ├─ build_body.py         M1 白模（比例、剪影、五官、大衣、靴）
│  ├─ materials_final.py    M2 材质（四色 + 星辰眼 + 星尘 + 三点布光）
│  └─ build_rig_anim.py     M3/M4/M5 骨骼 + 蒙皮 + 6 动作 + FBX + 三视图
├─ out/
│  ├─ txzf.blend            含材质节点（阶段 M2 产物）
│  ├─ txzf_rigged.blend     含骨骼/蒙皮/6 Actions
│  ├─ txzf.fbx              导出件（骨架 + 蒙皮 + 6 动作）
│  └─ renders/              M1/M2/M3/M4/M5 全部截图（21 张）
└─ docs/spec.md             本文件
```

## 已知短板（下一轮优先修）

| # | 问题 | 影响 | 修法 |
|---|---|---|---|
| 1 | 面部是低模球体 + 五官贴片 | 近景不够"高精度" | 换多段环放样头型 + 眼窝/颊骨雕刻化顶点位移 |
| 2 | 大衣是锥筒放样，无褶皱 | 缺少布料的"时尚感" | 加 Cloth 模拟一版烘焙，或用置换贴图伪造褶皱 |
| 3 | 手指为 4 片薄片 + 简化指骨 | 手部特写失真 | 换成 5 指 × 3 节 + 弯曲权重 |
| 4 | 星尘是几何小球（仅渲染用） | FBX 里没有粒子 | 在引擎侧用粒子系统重建，顶点色/UV 约定见 README |
| 5 | 自动权重导致大衣下摆变形偏硬 | 大幅动作时会穿模 | 下摆改用手绘权重 + 每根摆骨一段 |

_记录时间：2026-10-22 ｜ 引擎：Blender 5.2.2 LTS ｜ 渲染：Cycles CPU_
