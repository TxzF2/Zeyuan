"""
长征姬 · M3 骨骼 / M4 五组动作 / M5 导出（与 TxzF 同一套流水线，参数换成女性 8 头身）
----------------------------------------------------------------------------
输入：out/changzhengji.blend（M1+M2）
产物：
  out/changzhengji_rigged.blend   骨架 + 蒙皮 + 5 个 Action
  out/changzhengji.fbx            导出件
  out/renders/cz_m3_pose_*.png    姿态测试
  out/renders/cz_m4_*.png         每组动作关键帧
  out/renders/cz_m5_ortho_*.png   三视图
  out/renders/cz_story_*.png      协议过场占位镜头（4 张）

运行：blender -b --factory-startup --python build_rig_anim_cz.py
"""

import os
import sys
import math

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from dsh_lib import (  # noqa: E402
    configure_render,
    render_with,
    ortho_camera,
    RENDER_DIR,
    OUT_DIR,
    ensure_dirs,
)

DEG = math.radians

# 8 头身 1.75m 的骨架（与 build_changzhengji.py 的比例常量对齐）
BONES = [
    ("Hips", (0, 0, 0.950), (0, 0, 1.040), None),
    ("Spine", (0, 0, 1.040), (0, 0, 1.160), "Hips"),
    ("Chest", (0, 0, 1.160), (0, 0, 1.300), "Spine"),
    ("UpperChest", (0, 0, 1.300), (0, 0, 1.420), "Chest"),
    ("Neck", (0, 0, 1.420), (0, 0.008, 1.510), "UpperChest"),
    ("Head", (0, 0.008, 1.510), (0, 0.010, 1.720), "Neck"),
    ("Shoulder.L", (0.028, 0, 1.430), (0.174, 0, 1.438), "UpperChest"),
    ("UpperArm.L", (0.174, 0, 1.438), (0.212, 0.004, 1.260), "Shoulder.L"),
    ("LowerArm.L", (0.212, 0.004, 1.260), (0.228, 0.002, 1.030), "UpperArm.L"),
    ("Hand.L", (0.228, 0.002, 1.030), (0.229, -0.004, 0.900), "LowerArm.L"),
    ("Shoulder.R", (-0.028, 0, 1.430), (-0.174, 0, 1.438), "UpperChest"),
    ("UpperArm.R", (-0.174, 0, 1.438), (-0.212, 0.004, 1.260), "Shoulder.R"),
    ("LowerArm.R", (-0.212, 0.004, 1.260), (-0.228, 0.002, 1.030), "UpperArm.R"),
    ("Hand.R", (-0.228, 0.002, 1.030), (-0.229, -0.004, 0.900), "LowerArm.R"),
    ("Thigh.L", (0.078, 0, 0.950), (0.088, 0.006, 0.500), "Hips"),
    ("Shin.L", (0.088, 0.006, 0.500), (0.090, 0.004, 0.095), "Thigh.L"),
    ("Foot.L", (0.090, 0.004, 0.095), (0.090, -0.120, 0.028), "Shin.L"),
    ("Thigh.R", (-0.078, 0, 0.950), (-0.088, 0.006, 0.500), "Hips"),
    ("Shin.R", (-0.088, 0.006, 0.500), (-0.090, 0.004, 0.095), "Thigh.R"),
    ("Foot.R", (-0.090, 0.004, 0.095), (-0.090, -0.120, 0.028), "Shin.R"),
    # 大氅下摆三向摆骨
    ("CoatHem.L", (0.120, 0, 0.930), (0.170, 0, 0.560), "Hips"),
    ("CoatHem.R", (-0.120, 0, 0.930), (-0.170, 0, 0.560), "Hips"),
    ("CoatHem.Back", (0, 0.110, 0.930), (0, 0.130, 0.560), "Hips"),
    # 银发（及腰，两段）
    ("Hair.L", (0.090, 0.030, 1.620), (0.096, 0.040, 1.200), "Head"),
    ("Hair.R", (-0.090, 0.030, 1.620), (-0.096, 0.040, 1.200), "Head"),
    ("Hair.Back", (0, 0.095, 1.620), (0, 0.100, 1.150), "Head"),
    # 徽章（过场时自转用）
    ("Emblem", (0, -0.128, 1.290), (0, -0.180, 1.290), "Chest"),
]


def build_armature():
    data = bpy.data.armatures.new("cz_armature")
    arm = bpy.data.objects.new("cz_rig", data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    made = {}
    for name, head, tail, _parent in BONES:
        eb = data.edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.use_connect = False
        made[name] = eb
    for name, _h, _t, parent in BONES:
        if parent:
            made[name].parent = made[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    print("BONES", len(data.bones))
    return arm


def bind(arm):
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print("BIND_MESHES", len(meshes))
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        print("BIND OK (auto weights)")
    except RuntimeError as e:
        print("BIND AUTO FAILED -> empty groups:", e)
        bpy.ops.object.parent_set(type="ARMATURE_NAME")
    return meshes


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


def apply_pose(arm, pose):
    clear_pose(arm)
    for bone, rot in pose.items():
        pb = arm.pose.bones.get(bone)
        if pb:
            pb.rotation_euler = tuple(DEG(a) for a in rot)


def make_action(arm, name, frames, end):
    arm.animation_data_create()
    action = bpy.data.actions.new(name)
    arm.animation_data.action = action
    for bone_name, keys in frames.items():
        pb = arm.pose.bones.get(bone_name)
        if not pb:
            continue
        pb.rotation_mode = "XYZ"
        for f, rot in keys:
            pb.rotation_euler = tuple(DEG(a) for a in rot)
            pb.keyframe_insert(data_path="rotation_euler", frame=f)
    hips = arm.pose.bones.get("Hips")
    if hips:
        for f in (1, end):
            hips.location = (0, 0, 0)
            hips.keyframe_insert(data_path="location", frame=f)
    action.frame_end = end
    action.use_fake_user = True
    clear_pose(arm)
    print("ACTION", name, "1 -", end)
    return action


def build_actions(arm):
    acts = {}

    # 1 待机：呼吸 + 银发微飘 + 徽章缓转
    acts["idle"] = make_action(
        arm,
        "cz_idle",
        {
            "Chest": [(1, (0, 0, 0)), (30, (0.8, 0, 0)), (60, (0, 0, 0)), (90, (-0.6, 0, 0)), (120, (0, 0, 0))],
            "Head": [(1, (0, 0, 0)), (40, (0.4, 0, 1.2)), (80, (0, 0, -0.8)), (120, (0, 0, 0))],
            "Hair.L": [(1, (0, 0, 0)), (40, (1.4, 0, 0.6)), (80, (-0.8, 0, -0.4)), (120, (0, 0, 0))],
            "Hair.R": [(1, (0, 0, 0)), (40, (1.2, 0, -0.5)), (80, (-0.7, 0, 0.4)), (120, (0, 0, 0))],
            "Emblem": [(1, (0, 0, 0)), (60, (0, 0, 8)), (120, (0, 0, 16))],
            "CoatHem.L": [(1, (0, 0, 0)), (50, (1.0, 0, 0.5)), (120, (0, 0, 0))],
        },
        120,
    )

    # 2 宣读协议（粒子字幕）：单手抬起，逐段点头
    acts["announce"] = make_action(
        arm,
        "cz_announce",
        {
            "Spine": [(1, (0, 0, 0)), (30, (-1.5, 0, 0)), (150, (-1.5, 0, 0)), (180, (0, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (24, (-56, 0, -8)), (60, (-62, 0, -10)), (120, (-58, 0, -8)), (180, (-20, 0, -4))],
            "LowerArm.R": [(1, (0, 0, 0)), (24, (-40, 0, 0)), (120, (-44, 0, 0)), (180, (-12, 0, 0))],
            "Hand.R": [(1, (0, 0, 0)), (30, (0, 18, 0)), (120, (0, 22, 0)), (180, (0, 6, 0))],
            "Head": [(1, (0, 0, 0)), (36, (2, 0, -3)), (72, (1, 0, 2)), (108, (2, 0, -3)), (144, (1, 0, 1)), (180, (0, 0, 0))],
            "Hair.L": [(1, (0, 0, 0)), (90, (0.8, 0, 0.4)), (180, (0, 0, 0))],
        },
        180,
    )

    # 3 授权通过（红光）：掌心向前 + 整体前压
    acts["grant"] = make_action(
        arm,
        "cz_grant",
        {
            "Chest": [(1, (0, 0, 0)), (24, (-2, 0, 0)), (96, (-1, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (20, (-66, 0, -4)), (48, (-78, 0, -2)), (96, (-74, 0, -2))],
            "LowerArm.R": [(1, (0, 0, 0)), (20, (-50, 0, 0)), (48, (-62, 0, 0)), (96, (-58, 0, 0))],
            "Hand.R": [(1, (0, 0, 0)), (26, (-10, 0, 6)), (96, (-10, 0, 6))],
            "Head": [(1, (0, 0, 0)), (26, (3, 0, -4)), (96, (3, 0, -4))],
            "Emblem": [(1, (0, 0, 0)), (96, (0, 0, 24))],
        },
        96,
    )

    # 4 等级提升（星环扩散）：身体上浮 + 双臂展开
    acts["levelup"] = make_action(
        arm,
        "cz_levelup",
        {
            "Hips": [(1, (0, 0, 0)), (60, (0, 0, 0)), (120, (0, 0, 0))],
            "Chest": [(1, (0, 0, 0)), (40, (-4, 0, 0)), (120, (-2, 0, 0))],
            "Head": [(1, (0, 0, 0)), (40, (-6, 0, 0)), (120, (-2, 0, 0))],
            "UpperArm.L": [(1, (0, 0, 0)), (40, (-22, 0, 26)), (90, (-14, 0, 18)), (120, (0, 0, 6))],
            "UpperArm.R": [(1, (0, 0, 0)), (40, (-22, 0, -26)), (90, (-14, 0, -18)), (120, (0, 0, -6))],
            "Hair.L": [(1, (0, 0, 0)), (50, (-2.0, 0, 1.2)), (120, (0, 0, 0))],
            "Hair.Back": [(1, (0, 0, 0)), (50, (-2.4, 0, 0)), (120, (0, 0, 0))],
            "CoatHem.L": [(1, (0, 0, 0)), (60, (-1.6, 0, 0)), (120, (0, 0, 0))],
            "CoatHem.R": [(1, (0, 0, 0)), (60, (-1.6, 0, 0)), (120, (0, 0, 0))],
        },
        120,
    )

    # 5 警告驳回：抬颌俯视 + 单手下压
    acts["reject"] = make_action(
        arm,
        "cz_reject",
        {
            "Spine": [(1, (0, 0, 0)), (14, (3, 0, 0)), (50, (3, 0, 0)), (72, (0, 0, 0))],
            "Head": [(1, (0, 0, 0)), (14, (-8, 0, 0)), (50, (-9, 0, 0)), (72, (0, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (18, (-30, 0, -10)), (40, (14, 0, -6)), (72, (0, 0, 0))],
            "LowerArm.R": [(1, (0, 0, 0)), (18, (-18, 0, 0)), (40, (10, 0, 0)), (72, (0, 0, 0))],
            "Hair.R": [(1, (0, 0, 0)), (30, (-1.2, 0, 0)), (72, (0, 0, 0))],
        },
        72,
    )
    return acts


def render_story_placeholders(arm, acts):
    """协议过场占位镜头：用现有模型 + 徽章自转做 4 个关键画面（不是成片）。"""
    cam_wide = ortho_camera("cz_cam_wide", (0, -5.2, 0.95), (90, 0, 0), 2.1)
    cam_emblem = ortho_camera("cz_cam_emblem", (0, -1.0, 1.29), (90, 0, 0), 0.55)
    cam_close = ortho_camera("cz_cam_close", (-1.2, -2.4, 1.45), (84, 0, -26), 1.15)

    configure_render(engine="CYCLES", res=(760, 720), samples=24)

    # 镜2：徽章粒子线（用徽章近景 + 自转角度模拟"浮现"）
    arm.animation_data.action = acts["idle"]
    bpy.context.scene.frame_set(60)
    bpy.context.view_layer.update()
    render_with(cam_emblem, os.path.join(RENDER_DIR, "cz_story_02_emblem.png"))

    # 镜4/5：显形（接近中景）
    arm.animation_data.action = acts["announce"]
    bpy.context.scene.frame_set(36)
    bpy.context.view_layer.update()
    render_with(cam_close, os.path.join(RENDER_DIR, "cz_story_04_emerge.png"))

    # 镜6：宣读协议
    arm.animation_data.action = acts["announce"]
    bpy.context.scene.frame_set(108)
    bpy.context.view_layer.update()
    render_with(cam_wide, os.path.join(RENDER_DIR, "cz_story_06_announce.png"))

    # 镜7：授权红光
    arm.animation_data.action = acts["grant"]
    bpy.context.scene.frame_set(48)
    bpy.context.view_layer.update()
    render_with(cam_wide, os.path.join(RENDER_DIR, "cz_story_07_grant.png"))
    arm.animation_data.action = acts["idle"]


def main():
    ensure_dirs()
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT_DIR, "changzhengji.blend"))
    arm = build_armature()
    bind(arm)

    # M3 姿态
    configure_render(engine="CYCLES", res=(620, 1240), samples=20)
    cam_f = ortho_camera("cz_cam_f", (0, -5.6, 0.92), (90, 0, 0), 2.0)
    cam_q = ortho_camera("cz_cam_q", (-3.96, -3.96, 0.92), (90, 0, -45), 2.0)
    poses = {
        "tpose": {"UpperArm.L": (0, 0, 58), "UpperArm.R": (0, 0, -58)},
        "salute": {"UpperArm.R": (-58, 0, -10), "LowerArm.R": (-44, 0, 0), "Head": (2, 0, -6)},
        "stride": {"Thigh.L": (20, 0, 0), "Shin.L": (-14, 0, 0), "Thigh.R": (-16, 0, 0), "UpperArm.L": (-12, 0, 0)},
    }
    for n, p in poses.items():
        apply_pose(arm, p)
        bpy.context.view_layer.update()
        render_with(cam_f, os.path.join(RENDER_DIR, f"cz_m3_pose_{n}.png"))
    clear_pose(arm)

    # M4 五组动作关键帧
    acts = build_actions(arm)
    frames = {"idle": 40, "announce": 60, "grant": 48, "levelup": 60, "reject": 30}
    for clip, f in frames.items():
        arm.animation_data.action = acts[clip]
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        render_with(cam_q, os.path.join(RENDER_DIR, f"cz_m4_{clip}.png"))

    # 过场占位
    render_story_placeholders(arm, acts)

    rigged = os.path.join(OUT_DIR, "changzhengji_rigged.blend")
    bpy.ops.wm.save_as_mainfile(filepath=rigged)
    print("SAVED", rigged)

    # M5 FBX
    fbx = os.path.join(OUT_DIR, "changzhengji.fbx")
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for c in arm.children:
        c.select_set(True)
    bpy.ops.export_scene.fbx(
        filepath=fbx,
        use_selection=True,
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=False,
        apply_scale_options="FBX_SCALE_ALL",
        object_types={"ARMATURE", "MESH"},
    )
    print("SAVED", fbx)

    # 三视图
    configure_render(engine="CYCLES", res=(700, 1400), samples=28)
    for name, loc, rot in [
        ("front", (0, -6, 0.92), (90, 0, 0)),
        ("side", (6, 0, 0.92), (90, 0, 90)),
        ("back", (0, 6, 0.92), (90, 0, 180)),
    ]:
        cam = ortho_camera(f"cz_cam_{name}", loc, rot, 1.95)
        render_with(cam, os.path.join(RENDER_DIR, f"cz_m5_ortho_{name}.png"))


if __name__ == "__main__":
    main()
