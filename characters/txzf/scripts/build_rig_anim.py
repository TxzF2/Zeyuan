"""
TxzF · M3 骨骼 / M4 动作 / M5 导出
----------------------------------------------------------------------------
输入：out/txzf.blend（M2 材质版）
产物：
  out/txzf_rigged.blend      含骨架 + 蒙皮 + 6 个 Action
  out/txzf.fbx               含骨架/蒙皮/全部动作
  out/renders/m3_pose_*.png  骨骼姿态测试
  out/renders/m4_<clip>.png  每组动作 1 帧关键帧
  out/renders/m5_ortho_*.png 全身三视图（正/侧/背）

运行：blender -b --factory-startup --python build_rig_anim.py
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

# ---------------------------------------------------------------- 骨骼定义
# (名字, 头, 尾, 父级)
BONES = [
    ("Hips", (0, 0, 0.960), (0, 0, 1.060), None),
    ("Spine", (0, 0, 1.060), (0, 0, 1.200), "Hips"),
    ("Chest", (0, 0, 1.200), (0, 0, 1.400), "Spine"),
    ("UpperChest", (0, 0, 1.400), (0, 0, 1.510), "Chest"),
    ("Neck", (0, 0, 1.510), (0, 0.008, 1.600), "UpperChest"),
    ("Head", (0, 0.008, 1.600), (0, 0.010, 1.810), "Neck"),
    # 手臂（L 在 +X）
    ("Shoulder.L", (0.030, 0, 1.498), (0.190, 0, 1.505), "UpperChest"),
    ("UpperArm.L", (0.190, 0, 1.505), (0.230, 0.004, 1.320), "Shoulder.L"),
    ("LowerArm.L", (0.230, 0.004, 1.320), (0.252, 0.002, 1.070), "UpperArm.L"),
    ("Hand.L", (0.252, 0.002, 1.070), (0.254, -0.004, 0.930), "LowerArm.L"),
    ("Shoulder.R", (-0.030, 0, 1.498), (-0.190, 0, 1.505), "UpperChest"),
    ("UpperArm.R", (-0.190, 0, 1.505), (-0.230, 0.004, 1.320), "Shoulder.R"),
    ("LowerArm.R", (-0.230, 0.004, 1.320), (-0.252, 0.002, 1.070), "UpperArm.R"),
    ("Hand.R", (-0.252, 0.002, 1.070), (-0.254, -0.004, 0.930), "LowerArm.R"),
    # 腿
    ("Thigh.L", (0.086, 0, 0.960), (0.096, 0.006, 0.520), "Hips"),
    ("Shin.L", (0.096, 0.006, 0.520), (0.098, 0.004, 0.100), "Thigh.L"),
    ("Foot.L", (0.098, 0.004, 0.100), (0.098, -0.130, 0.030), "Shin.L"),
    ("Thigh.R", (-0.086, 0, 0.960), (-0.096, 0.006, 0.520), "Hips"),
    ("Shin.R", (-0.096, 0.006, 0.520), (-0.098, 0.004, 0.100), "Thigh.R"),
    ("Foot.R", (-0.098, 0.004, 0.100), (-0.098, -0.130, 0.030), "Shin.R"),
    # 大衣下摆（独立摆骨，保证动作里有延迟感）
    ("CoatHem.L", (0.140, 0, 0.940), (0.190, 0, 0.600), "Hips"),
    ("CoatHem.R", (-0.140, 0, 0.940), (-0.190, 0, 0.600), "Hips"),
    ("CoatHem.Back", (0, 0.120, 0.940), (0, 0.140, 0.600), "Hips"),
    # 后发
    ("HairTail", (0, 0.100, 1.640), (0, 0.110, 1.430), "Head"),
    # 手指（简化：每手 3 根）
    ("Finger.L", (0.244, -0.008, 0.918), (0.246, -0.010, 0.870), "Hand.L"),
    ("Finger.R", (-0.244, -0.008, 0.918), (-0.246, -0.010, 0.870), "Hand.R"),
]

DEG = math.radians


def build_armature():
    arm_data = bpy.data.armatures.new("txzf_armature")
    arm = bpy.data.objects.new("txzf_rig", arm_data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    created = {}
    for name, head, tail, parent in BONES:
        eb = arm_data.edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.use_connect = False
        created[name] = eb
    for name, _h, _t, parent in BONES:
        if parent:
            created[name].parent = created[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    print("BONES", len(arm_data.bones))
    return arm


def bind(arm):
    meshes = [
        o
        for o in bpy.data.objects
        if o.type == "MESH" and not o.name.startswith("txzf_dust")
    ]
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
        print("BIND AUTO FAILED -> fallback empty groups:", e)
        bpy.ops.object.parent_set(type="ARMATURE_NAME")
    return meshes


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


def apply_pose(arm, pose_dict):
    clear_pose(arm)
    for bone, rot in pose_dict.items():
        pb = arm.pose.bones.get(bone)
        if pb:
            pb.rotation_euler = tuple(DEG(a) for a in rot)


def render_current(cam, path):
    render_with(cam, path)


def make_action(arm, name, frames, fps_end):
    """frames: {bone: [(frame, (rx,ry,rz)), ...]}"""
    arm.animation_data_create()
    action = bpy.data.actions.new(name)
    arm.animation_data.action = action
    # 统一插入关键帧
    for bone_name, keys in frames.items():
        pb = arm.pose.bones.get(bone_name)
        if not pb:
            continue
        pb.rotation_mode = "XYZ"
        for frame, rot in keys:
            pb.rotation_euler = tuple(DEG(a) for a in rot)
            pb.keyframe_insert(data_path="rotation_euler", frame=frame)
    # 每个动作都补一组 Hips 位置关键帧，避免导出后动作长度为 0
    hips = arm.pose.bones.get("Hips")
    if hips:
        for frame in (1, fps_end):
            hips.location = (0, 0, 0)
            hips.keyframe_insert(data_path="location", frame=frame)
    action.frame_end = fps_end
    action.use_fake_user = True
    clear_pose(arm)
    print("ACTION", name, "frames", 1, "-", fps_end)
    return action


# ---------------------------------------------------------------- 六组动作
def build_actions(arm):
    acts = {}

    # 1 待机（星辰环绕）：呼吸 + 微摆 + 下摆延迟
    acts["idle"] = make_action(
        arm,
        "txzf_idle",
        {
            "Chest": [(1, (0, 0, 0)), (30, (1.2, 0, 0)), (60, (0, 0, 0)), (90, (-0.8, 0, 0)), (120, (0, 0, 0))],
            "Head": [(1, (0, 0, 0)), (36, (0.6, 0, 1.6)), (72, (0, 0, 0)), (108, (0.4, 0, -1.2)), (120, (0, 0, 0))],
            "CoatHem.L": [(1, (0, 0, 0)), (40, (1.6, 0, 0.8)), (80, (-0.9, 0, -0.6)), (120, (0, 0, 0))],
            "CoatHem.R": [(1, (0, 0, 0)), (40, (-1.4, 0, -0.7)), (80, (1.0, 0, 0.5)), (120, (0, 0, 0))],
            "HairTail": [(1, (0, 0, 0)), (48, (2.2, 0, 1.0)), (96, (-1.0, 0, -0.6)), (120, (0, 0, 0))],
        },
        120,
    )

    # 2 讲解：抬手引导视线
    acts["explain"] = make_action(
        arm,
        "txzf_explain",
        {
            "Spine": [(1, (0, 0, 0)), (20, (-2, 0, 6)), (60, (-2, 0, 6)), (90, (0, 0, 0))],
            "Head": [(1, (0, 0, 0)), (18, (2, 0, -8)), (60, (3, 0, -10)), (90, (0, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (18, (-42, 0, -18)), (55, (-48, 0, -22)), (90, (0, 0, 0))],
            "LowerArm.R": [(1, (0, 0, 0)), (18, (-38, 0, 0)), (55, (-30, 0, 0)), (90, (0, 0, 0))],
            "Hand.R": [(1, (0, 0, 0)), (24, (0, 0, 24)), (55, (0, 0, 30)), (90, (0, 0, 0))],
            "UpperArm.L": [(1, (0, 0, 0)), (30, (6, 0, 0)), (90, (0, 0, 0))],
        },
        90,
    )

    # 3 授权确认：单手扣肩 → 掌心向前
    acts["authorize"] = make_action(
        arm,
        "txzf_authorize",
        {
            "Chest": [(1, (0, 0, 0)), (18, (-3, 0, 0)), (50, (0, 0, 0)), (72, (0, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (16, (-58, 0, -10)), (38, (-72, 0, -6)), (72, (-70, 0, -6))],
            "LowerArm.R": [(1, (0, 0, 0)), (16, (-46, 0, 0)), (38, (-58, 0, 0)), (72, (-56, 0, 0))],
            "Hand.R": [(1, (0, 0, 0)), (20, (-14, 0, 8)), (72, (-14, 0, 8))],
            "Head": [(1, (0, 0, 0)), (22, (4, 0, -4)), (72, (4, 0, -4))],
            "HairTail": [(1, (0, 0, 0)), (30, (1.4, 0, 0.6)), (72, (0.6, 0, 0.2))],
        },
        72,
    )

    # 4 警告：后倾 + 下颌收紧
    acts["warn"] = make_action(
        arm,
        "txzf_warn",
        {
            "Spine": [(1, (0, 0, 0)), (12, (4, 0, 0)), (40, (5, 0, 0)), (60, (0, 0, 0))],
            "Head": [(1, (0, 0, 0)), (12, (-6, 0, 0)), (40, (-8, 0, 0)), (60, (0, 0, 0))],
            "UpperArm.L": [(1, (0, 0, 0)), (14, (10, 0, 12)), (60, (0, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (14, (10, 0, -12)), (60, (0, 0, 0))],
            "CoatHem.L": [(1, (0, 0, 0)), (20, (-2.0, 0, 0)), (60, (0, 0, 0))],
            "CoatHem.R": [(1, (0, 0, 0)), (20, (-2.0, 0, 0)), (60, (0, 0, 0))],
        },
        60,
    )

    # 5 引导：侧身回望 + 两次招手
    acts["guide"] = make_action(
        arm,
        "txzf_guide",
        {
            "Hips": [(1, (0, 0, 0)), (20, (0, 0, 10)), (62, (0, 0, 10)), (84, (0, 0, 0))],
            "Spine": [(1, (0, 0, 0)), (20, (0, 0, 8)), (62, (0, 0, 8)), (84, (0, 0, 0))],
            "Head": [(1, (0, 0, 0)), (16, (2, 0, -16)), (62, (2, 0, -14)), (84, (0, 0, 0))],
            "UpperArm.R": [(1, (0, 0, 0)), (16, (-52, 0, -4)), (30, (-66, 0, -4)), (44, (-52, 0, -4)), (58, (-66, 0, -4)), (84, (0, 0, 0))],
            "LowerArm.R": [(1, (0, 0, 0)), (16, (-26, 0, 0)), (30, (-46, 0, 0)), (44, (-26, 0, 0)), (58, (-46, 0, 0)), (84, (0, 0, 0))],
            "Hand.R": [(1, (0, 0, 0)), (24, (0, 22, 0)), (44, (0, -6, 0)), (58, (0, 22, 0)), (84, (0, 0, 0))],
            "CoatHem.L": [(1, (0, 0, 0)), (26, (0, 0, 4)), (84, (0, 0, 0))],
        },
        84,
    )

    # 6 结算（金币粒子收拢）：双手虚握 → 收拳
    acts["settle"] = make_action(
        arm,
        "txzf_settle",
        {
            "Chest": [(1, (0, 0, 0)), (30, (-2, 0, 0)), (66, (-4, 0, 0)), (96, (0, 0, 0))],
            "UpperArm.L": [(1, (0, 0, 0)), (30, (-40, 0, 14)), (62, (-52, 0, 6)), (96, (-10, 0, 4))],
            "UpperArm.R": [(1, (0, 0, 0)), (30, (-40, 0, -14)), (62, (-52, 0, -6)), (96, (-10, 0, -4))],
            "LowerArm.L": [(1, (0, 0, 0)), (30, (-34, 0, 0)), (62, (-56, 0, 0)), (96, (-8, 0, 0))],
            "LowerArm.R": [(1, (0, 0, 0)), (30, (-34, 0, 0)), (62, (-56, 0, 0)), (96, (-8, 0, 0))],
            "Finger.L": [(1, (0, 0, 0)), (58, (0, 0, 0)), (72, (48, 0, 0)), (96, (44, 0, 0))],
            "Finger.R": [(1, (0, 0, 0)), (58, (0, 0, 0)), (72, (48, 0, 0)), (96, (44, 0, 0))],
            "Head": [(1, (0, 0, 0)), (40, (-3, 0, 0)), (96, (-1, 0, 0))],
        },
        96,
    )
    return acts


def main():
    ensure_dirs()
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT_DIR, "txzf.blend"))
    arm = build_armature()
    bind(arm)

    # ---- M3 姿态测试 ----
    configure_render(engine="CYCLES", res=(600, 1200), samples=20)
    cam_f = ortho_camera("cam_f", (0, -6, 0.95), (90, 0, 0), 2.05)
    cam_q = ortho_camera("cam_q", (-4.24, -4.24, 0.95), (90, 0, -45), 2.05)
    poses = {
        "pose_tpose": {"UpperArm.L": (0, 0, 62), "UpperArm.R": (0, 0, -62)},
        "pose_guard": {"UpperArm.R": (-58, 0, -10), "LowerArm.R": (-46, 0, 0), "Spine": (-2, 0, 6), "Head": (2, 0, -8)},
        "pose_walk": {"Thigh.L": (24, 0, 0), "Shin.L": (-18, 0, 0), "Thigh.R": (-18, 0, 0), "UpperArm.L": (-16, 0, 0), "UpperArm.R": (16, 0, 0)},
    }
    for name, pose in poses.items():
        apply_pose(arm, pose)
        bpy.context.view_layer.update()
        render_with(cam_f, os.path.join(RENDER_DIR, f"m3_{name}.png"))
    clear_pose(arm)

    # ---- M4 六组动作 ----
    acts = build_actions(arm)
    mid_frames = {"idle": 60, "explain": 55, "authorize": 50, "warn": 40, "guide": 30, "settle": 62}
    for clip, frame in mid_frames.items():
        arm.animation_data.action = acts[clip]
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        render_with(cam_q, os.path.join(RENDER_DIR, f"m4_{clip}.png"))
    arm.animation_data.action = acts["idle"]
    bpy.context.scene.frame_set(1)

    # ---- 保存工程 ----
    rigged = os.path.join(OUT_DIR, "txzf_rigged.blend")
    bpy.ops.wm.save_as_mainfile(filepath=rigged)
    print("SAVED", rigged)

    # ---- M5 FBX 导出 ----
    fbx_path = os.path.join(OUT_DIR, "txzf.fbx")
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for child in arm.children:
        child.select_set(True)
    bpy.ops.export_scene.fbx(
        filepath=fbx_path,
        use_selection=True,
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=False,
        apply_scale_options="FBX_SCALE_ALL",
        object_types={"ARMATURE", "MESH"},
    )
    print("SAVED", fbx_path)

    # ---- 三视图（正交，全身）----
    configure_render(engine="CYCLES", res=(700, 1400), samples=32)
    views = {
        "front": ((0, -6, 0.95), (90, 0, 0)),
        "side": ((6, 0, 0.95), (90, 0, 90)),
        "back": ((0, 6, 0.95), (90, 0, 180)),
    }
    for name, (loc, rot) in views.items():
        cam = ortho_camera(f"cam_{name}", loc, rot, 2.00)
        render_with(cam, os.path.join(RENDER_DIR, f"m5_ortho_{name}.png"))


if __name__ == "__main__":
    main()
