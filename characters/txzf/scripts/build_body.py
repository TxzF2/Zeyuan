"""
TxzF · M1 白模 v2（比例与剪影）
----------------------------------------------------------------------------
身高 1.82 m / 7.5 头身 / 男性引导者（气质参考：少年感 + 危险感，若有似无的笑）。
v2 相对 v1 的修正：
  - 眼睛从颅内挪到面部表面（v1 埋在头里，根本看不见脸）
  - 大衣收窄，手臂变"袖"并移到外套轮廓之外（v1 像麻袋把手臂吞了）
  - 加肩线、驳领、内衬面板、腰带扣，让"长款大衣"读得出来
  - 头发放大并加前额碎发 + 鬓角 + 后发（v1 头皮裸露）
  - 手指、靴型、裤管比例修正；统一重算法线
  - 3/4 视图改正交相机（v1 透视相机把头顶裁掉了）

运行：blender -b --factory-startup --python build_body.py
产物：out/txzf_body.blend + out/renders/m1_txzf_*.png
"""

import os
import sys
import math

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from dsh_lib import (  # noqa: E402
    reset_scene,
    ensure_dirs,
    ellipse_ring,
    loft,
    tube,
    sphere,
    cube,
    add_subsurf,
    add_solidify,
    recalc_normals,
    mat_simple,
    render_turnaround,
    OUT_DIR,
)

# ---------------------------------------------------------------- 比例常量
H = 1.82
HEAD_H = H / 7.5              # ≈0.2427
CHIN_Z = H - HEAD_H           # 1.577
HEAD_C = CHIN_Z + HEAD_H * 0.50   # 1.699
HEAD_RX, HEAD_RY, HEAD_RZ = 0.098, 0.104, 0.126

SHOULDER_Z = 1.510
CHEST_Z = 1.415
WAIST_Z = 1.150
HIP_Z = 1.000
KNEE_Z = 0.520
ANKLE_Z = 0.090

N = 24
FRONT_Y = -HEAD_RY          # 面部最前点 ≈ -0.104


def _obj_done(obj):
    recalc_normals(obj)
    return obj


def build_head(mats):
    skin, hair, dark = mats["skin"], mats["hair"], mats["dark"]

    head = sphere("txzf_head", (0, 0.012, HEAD_C), (HEAD_RX, HEAD_RY, HEAD_RZ), mat=skin)
    add_subsurf(head, 1)
    # 下颌收窄 + 下巴前探（少年感）
    for v in head.data.vertices:
        rel = (v.co.z - HEAD_C) / HEAD_RZ
        if rel < -0.25:
            k = min(1.0, (-rel - 0.25) / 0.75)
            v.co.x *= 1.0 - 0.26 * k
            v.co.y -= 0.010 * k

    for sx in (-1, 1):
        side = "L" if sx > 0 else "R"
        # 耳
        sphere(f"txzf_ear_{side}", (sx * 0.094, 0.020, HEAD_C - 0.004), (0.014, 0.024, 0.038), mat=skin)
        # 眼球（凸到面部表面之外，否则看不见）
        sphere(f"txzf_eye_{side}", (sx * 0.036, FRONT_Y + 0.006, HEAD_C + 0.012), (0.017, 0.009, 0.015), mat=mats["eye"])
        # 上眼睑（压住眼球上缘，出"半垂眼"的危险感）
        lid = cube(f"txzf_lid_{side}", (sx * 0.036, FRONT_Y + 0.004, HEAD_C + 0.025), (0.030, 0.009, 0.004), mat=dark)
        lid.rotation_euler = (math.radians(-12), 0, math.radians(sx * 4))
        # 眉（外侧略挑）
        brow = cube(f"txzf_brow_{side}", (sx * 0.034, FRONT_Y + 0.008, HEAD_C + 0.041), (0.026, 0.007, 0.004), mat=hair)
        brow.rotation_euler = (0, math.radians(sx * -6), math.radians(sx * 8))

    # 鼻梁 + 鼻头
    nose = cube("txzf_nose", (0, FRONT_Y + 0.002, HEAD_C - 0.014), (0.016, 0.026, 0.036), mat=skin)
    nose.rotation_euler = (math.radians(8), 0, 0)
    add_subsurf(nose, 1)
    # 嘴：一条微扬的薄片（若有似无的笑）
    mouth = cube("txzf_mouth", (0.005, FRONT_Y + 0.010, HEAD_C - 0.066), (0.022, 0.006, 0.0032), mat=dark)
    mouth.rotation_euler = (0, math.radians(4), math.radians(-3))

    # ---------------- 头发 ----------------
    cap_rings = [
        # front_scale 逐层内收：下层发帽必须退到面部之后，否则会把整张脸包住（v2 的 bug）
        ellipse_ring(HEAD_C + 0.132, 0.020, 0.022, N, front_scale=1.00),
        ellipse_ring(HEAD_C + 0.112, 0.062, 0.066, N, front_scale=1.00),
        ellipse_ring(HEAD_C + 0.082, 0.098, 0.104, N, front_scale=0.98),
        ellipse_ring(HEAD_C + 0.048, 0.110, 0.116, N, front_scale=0.76),
        ellipse_ring(HEAD_C + 0.010, 0.112, 0.118, N, front_scale=0.58),
        ellipse_ring(HEAD_C - 0.030, 0.104, 0.110, N, front_scale=0.46),
        ellipse_ring(HEAD_C - 0.075, 0.086, 0.094, N, front_scale=0.42),
    ]
    cap = _obj_done(loft("txzf_hair_cap", cap_rings, cap_start=True, cap_end=False, mat=hair))
    add_solidify(cap, 0.010)
    add_subsurf(cap, 1)

    # 前额碎发（三束，斜切）
    for i, (x, rot, tilt) in enumerate([(-0.052, 20, -16), (-0.006, 4, -20), (0.050, -22, -14)]):
        lock = cube(
            f"txzf_hair_fringe{i}",
            (x, FRONT_Y + 0.030, HEAD_C + 0.056),
            (0.026, 0.012, 0.062),
            mat=hair,
        )
        lock.rotation_euler = (math.radians(tilt), math.radians(rot * 0.5), math.radians(rot * 0.6))
        add_subsurf(lock, 1)

    # 鬓角 + 后发
    for sx in (-1, 1):
        side = "L" if sx > 0 else "R"
        sb = cube(f"txzf_hair_sideburn_{side}", (sx * 0.098, -0.020, HEAD_C - 0.038), (0.016, 0.052, 0.100), mat=hair)
        sb.rotation_euler = (0, math.radians(sx * 5), 0)
        add_subsurf(sb, 1)
    back = cube("txzf_hair_back", (0, 0.088, HEAD_C - 0.062), (0.090, 0.040, 0.115), mat=hair)
    add_subsurf(back, 1)
    # 后颈小马尾/碎发尾（危险感的细节）
    tail = tube("txzf_hair_tail", [(0, 0.102, HEAD_C - 0.120), (0.010, 0.112, HEAD_C - 0.200), (0.004, 0.100, HEAD_C - 0.265)], [0.030, 0.024, 0.012], n=10, mat=hair)
    add_subsurf(tail, 1)
    return head


def build_body(mats):
    skin, coat, shirt, dark = mats["skin"], mats["coat"], mats["shirt"], mats["dark"]

    # ---------------- 躯干（被大衣遮住，仅作轮廓支撑）----------------
    torso_rings = [
        ellipse_ring(0.880, 0.150, 0.100, N, front_scale=0.95),
        ellipse_ring(0.960, 0.158, 0.106, N),
        ellipse_ring(HIP_Z, 0.156, 0.104, N),
        ellipse_ring(1.080, 0.146, 0.096, N),
        ellipse_ring(WAIST_Z, 0.138, 0.092, N, front_scale=0.95),
        ellipse_ring(1.300, 0.160, 0.102, N),
        ellipse_ring(CHEST_Z, 0.180, 0.110, N, front_scale=1.03),
        ellipse_ring(SHOULDER_Z, 0.196, 0.100, N),
        ellipse_ring(1.560, 0.110, 0.086, N),
    ]
    _obj_done(loft("txzf_torso", torso_rings, mat=skin))

    # ---------------- 颈 ----------------
    _obj_done(tube("txzf_neck", [(0, 0.010, 1.548), (0, 0.012, 1.612), (0, 0.014, 1.650)], [0.050, 0.047, 0.045], n=16, mat=skin))

    # ---------------- 大衣 ----------------
    coat_rings = [
        ellipse_ring(1.556, 0.204, 0.124, N, front_scale=1.02),
        ellipse_ring(1.498, 0.212, 0.131, N),
        ellipse_ring(1.420, 0.206, 0.132, N, front_scale=1.03),
        ellipse_ring(1.250, 0.197, 0.127, N),
        ellipse_ring(WAIST_Z, 0.192, 0.124, N),
        ellipse_ring(1.020, 0.201, 0.130, N),
        ellipse_ring(0.850, 0.217, 0.143, N),
        ellipse_ring(KNEE_Z + 0.100, 0.237, 0.157, N),
        ellipse_ring(KNEE_Z + 0.020, 0.243, 0.161, N),
    ]
    coat_obj = _obj_done(loft("txzf_coat", coat_rings, cap_start=True, cap_end=False, mat=coat))
    add_solidify(coat_obj, 0.014)
    add_subsurf(coat_obj, 1)

    # 立领（v2 的领子太高太粗像圆筒，这里压低并收口）
    collar_rings = [
        ellipse_ring(1.520, 0.116, 0.092, N, front_scale=1.12),
        ellipse_ring(1.572, 0.121, 0.098, N, front_scale=1.16),
        ellipse_ring(1.612, 0.110, 0.090, N, front_scale=1.18),
    ]
    collar = _obj_done(loft("txzf_collar", collar_rings, cap_start=False, cap_end=False, mat=coat))
    add_solidify(collar, 0.012)

    # 内衬面板（深蓝，露出胸口一条）
    inner = cube("txzf_inner_panel", (0, -0.118, 1.330), (0.085, 0.016, 0.290), mat=shirt)
    add_subsurf(inner, 1)

    # 驳领（两片，从领口斜向下）
    for sx in (-1, 1):
        side = "L" if sx > 0 else "R"
        lap = cube(f"txzf_lapel_{side}", (sx * 0.060, -0.128, 1.430), (0.070, 0.016, 0.190), mat=coat)
        lap.rotation_euler = (math.radians(6), math.radians(sx * 10), math.radians(sx * 9))
        add_subsurf(lap, 1)

    # 腰带 + 扣
    belt_a = ellipse_ring(WAIST_Z - 0.020, 0.198, 0.129, N)
    belt_b = ellipse_ring(WAIST_Z + 0.026, 0.197, 0.128, N)
    belt = _obj_done(loft("txzf_belt", [belt_a, belt_b], cap_start=False, cap_end=False, mat=mats["metal"]))
    add_solidify(belt, 0.009)
    cube("txzf_buckle", (0, -0.134, WAIST_Z + 0.002), (0.036, 0.014, 0.030), mat=mats["metal"])

    # 下摆开衩缝（两道浅色竖条，读得出大衣结构）
    for sx in (-1, 1):
        cube(f"txzf_vent_{'L' if sx > 0 else 'R'}", (sx * 0.140, -0.070, 0.700), (0.010, 0.010, 0.300), mat=dark)

    # ---------------- 肩与袖 ----------------
    for sx in (1, -1):
        side = "L" if sx > 0 else "R"
        # 三角肌（撑出肩线）
        sphere(f"txzf_shoulder_{side}", (sx * 0.196, 0.0, SHOULDER_Z + 0.005), (0.062, 0.072, 0.058), mat=coat)
        # 袖子（外套材质，走在轮廓之外）
        arm_pts = [
            (sx * 0.198, 0.0, SHOULDER_Z - 0.010),
            (sx * 0.226, 0.004, 1.380),
            (sx * 0.242, 0.006, 1.230),
            (sx * 0.250, 0.004, 1.090),
            (sx * 0.254, 0.0, 1.010),
        ]
        sleeve = _obj_done(tube(f"txzf_sleeve_{side}", arm_pts, [0.058, 0.050, 0.043, 0.036, 0.032], n=16, mat=coat))
        add_subsurf(sleeve, 1)
        # 袖口银饰
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.036, minor_radius=0.007, location=(sx * 0.254, 0.0, 1.012), major_segments=24, minor_segments=10
        )
        cuff = bpy.context.object
        cuff.name = f"txzf_cuff_{side}"
        cuff.data.materials.append(mats["metal"])
        for p in cuff.data.polygons:
            p.use_smooth = True
        # 手：掌 + 四指 + 拇指
        cube(f"txzf_palm_{side}", (sx * 0.254, -0.004, 0.948), (0.042, 0.028, 0.072), mat=skin)
        for fi in range(4):
            fx = sx * (0.238 + fi * 0.0105)
            fz = 0.892 - abs(fi - 1.5) * 0.004
            cub = cube(f"txzf_finger{fi}_{side}", (fx, -0.008, fz), (0.0085, 0.020, 0.044), mat=skin)
            cub.rotation_euler = (math.radians(-6), 0, 0)
        thumb = cube(f"txzf_thumb_{side}", (sx * 0.224, -0.026, 0.936), (0.016, 0.030, 0.040), mat=skin)
        thumb.rotation_euler = (0, math.radians(sx * 18), 0)

    # ---------------- 腿与靴 ----------------
    for sx in (1, -1):
        side = "L" if sx > 0 else "R"
        leg_pts = [
            (sx * 0.086, 0, 0.980),
            (sx * 0.092, 0.004, 0.780),
            (sx * 0.096, 0.006, KNEE_Z),
            (sx * 0.098, 0.004, 0.300),
            (sx * 0.098, 0, ANKLE_Z + 0.010),
        ]
        leg = _obj_done(tube(f"txzf_leg_{side}", leg_pts, [0.078, 0.068, 0.058, 0.050, 0.044], n=14, mat=coat))
        add_subsurf(leg, 1)
        # 靴：鞋面 + 鞋尖 + 靴筒
        cube(f"txzf_boot_{side}", (sx * 0.098, -0.026, 0.048), (0.078, 0.120, 0.070), mat=dark)
        toe = cube(f"txzf_boot_toe_{side}", (sx * 0.098, -0.082, 0.036), (0.070, 0.070, 0.046), mat=dark)
        toe.rotation_euler = (math.radians(10), 0, 0)
        _obj_done(tube(f"txzf_boot_shaft_{side}", [(sx * 0.098, 0, 0.095), (sx * 0.098, 0, 0.235)], [0.050, 0.047], n=14, mat=dark))
        # 靴口银环
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.049, minor_radius=0.005, location=(sx * 0.098, 0, 0.236), major_segments=20, minor_segments=8
        )
        rim = bpy.context.object
        rim.name = f"txzf_boot_rim_{side}"
        rim.data.materials.append(mats["metal"])

    return coat_obj


def main():
    reset_scene()
    ensure_dirs()
    mats = {
        "skin": mat_simple("M_skin_wip", (0.62, 0.64, 0.68), roughness=0.55),
        "coat": mat_simple("M_coat_wip", (0.19, 0.21, 0.25), roughness=0.62),
        "dark": mat_simple("M_dark_wip", (0.07, 0.08, 0.10), roughness=0.45),
        "hair": mat_simple("M_hair_wip", (0.12, 0.13, 0.16), roughness=0.38),
        "shirt": mat_simple("M_shirt_wip", (0.10, 0.14, 0.26), roughness=0.55),
        "metal": mat_simple("M_metal_wip", (0.74, 0.77, 0.84), metallic=1.0, roughness=0.25),
        "eye": mat_simple("M_eye_wip", (0.04, 0.06, 0.13), roughness=0.12, emission=(0.20, 0.45, 1.0), emission_strength=1.2),
    }
    build_body(mats)
    build_head(mats)

    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new("W")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.015, 0.020, 0.035, 1)
    bg.inputs[1].default_value = 1.0

    blend_path = os.path.join(OUT_DIR, "txzf_body.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    print("SAVED", blend_path)

    render_turnaround("m1_txzf", center_z=0.95, ortho_scale=2.05, res=(560, 1120))
    # 头部特写（检查五官可读性）
    from dsh_lib import configure_render, render_with, ortho_camera, RENDER_DIR

    configure_render(engine="BLENDER_WORKBENCH", res=(560, 560))
    head_cam = ortho_camera("cam_head", (0, -3.0, HEAD_C), (90, 0, 0), 0.42)
    render_with(head_cam, os.path.join(RENDER_DIR, "m1_txzf_head.png"))
    head_cam3 = ortho_camera("cam_head3", (-2.1, -2.1, HEAD_C + 0.02), (90, 0, -45), 0.46)
    render_with(head_cam3, os.path.join(RENDER_DIR, "m1_txzf_head_quarter.png"))


if __name__ == "__main__":
    main()
