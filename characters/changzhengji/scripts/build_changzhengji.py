"""
长征姬 · M1 白模 + M2 材质（女性形象，长征主题高冷御姐）
----------------------------------------------------------------------------
身高 1.75 m / 8 头身 / 银发及腰。
四色：红 #C8102E · 灰 #4A4E57 · 白 #E8ECF2 · 粉 #F2A7C3 + 星辰微光（与 TxzF 同一节点语言）
核心标志：镰刀锤子（本脚本出金属徽章版；粒子构成版见 storyboard.md）

本阶段范围：白模 + 材质 + 三视图 + 徽章特写。
骨骼与 5 组动作、协议过场动画属下一里程碑（见 /docs/storyboard.md 状态栏）。

运行：blender -b --factory-startup --python build_changzhengji.py
产物：out/changzhengji.blend + out/renders/cz_*.png
"""

import os
import sys
import math
import random

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
    configure_render,
    render_with,
    ortho_camera,
    mat_simple,
    RENDER_DIR,
    OUT_DIR,
)

# ---------------------------------------------------------------- 比例（8 头身）
H = 1.75
HEAD_H = H / 8.0                 # 0.2188
CHIN_Z = H - HEAD_H              # 1.531
HEAD_C = CHIN_Z + HEAD_H * 0.5   # 1.640
HEAD_RX, HEAD_RY, HEAD_RZ = 0.090, 0.096, 0.113

SHOULDER_Z = 1.452
CHEST_Z = 1.360
WAIST_Z = 1.100
HIP_Z = 0.960
KNEE_Z = 0.500
ANKLE_Z = 0.085

N = 24
FRONT_Y = -HEAD_RY

PALETTE = {
    "red": (0.586, 0.032, 0.086),      # #C8102E
    "grey": (0.098, 0.108, 0.130),     # #4A4E57 附近（线性）
    "white": (0.760, 0.800, 0.880),    # #E8ECF2
    "pink": (0.760, 0.330, 0.480),     # #F2A7C3
    "silver_hair": (0.620, 0.660, 0.740),
    "silver": (0.800, 0.830, 0.880),
    "blue": (0.298, 0.490, 1.000),
}


def obj_done(o):
    recalc_normals(o)
    return o


def build_head(mats):
    skin, hair, dark = mats["skin"], mats["hair"], mats["dark"]
    head = sphere("cz_head", (0, 0.010, HEAD_C), (HEAD_RX, HEAD_RY, HEAD_RZ), mat=skin)
    add_subsurf(head, 1)
    for v in head.data.vertices:
        rel = (v.co.z - HEAD_C) / HEAD_RZ
        if rel < -0.25:
            k = min(1.0, (-rel - 0.25) / 0.75)
            v.co.x *= 1.0 - 0.30 * k     # 更尖的下颌（高冷感）
            v.co.y -= 0.008 * k

    for sx in (-1, 1):
        side = "L" if sx > 0 else "R"
        sphere(f"cz_ear_{side}", (sx * 0.086, 0.018, HEAD_C - 0.004), (0.013, 0.022, 0.034), mat=skin)
        sphere(f"cz_eye_{side}", (sx * 0.033, FRONT_Y + 0.006, HEAD_C + 0.010), (0.016, 0.009, 0.013), mat=mats["eye"])
        lid = cube(f"cz_lid_{side}", (sx * 0.033, FRONT_Y + 0.004, HEAD_C + 0.022), (0.030, 0.008, 0.0038), mat=dark)
        lid.rotation_euler = (math.radians(-8), 0, math.radians(sx * 3))
        brow = cube(f"cz_brow_{side}", (sx * 0.032, FRONT_Y + 0.008, HEAD_C + 0.036), (0.026, 0.006, 0.0035), mat=hair)
        brow.rotation_euler = (0, math.radians(sx * 5), math.radians(sx * 4))

    nose = cube("cz_nose", (0, FRONT_Y + 0.002, HEAD_C - 0.012), (0.013, 0.022, 0.030), mat=skin)
    add_subsurf(nose, 1)
    # 唇：偏冷的小嘴，微微下压（克制）
    mouth = cube("cz_mouth", (0, FRONT_Y + 0.010, HEAD_C - 0.060), (0.019, 0.006, 0.0034), mat=mats["lip"])
    mouth.rotation_euler = (0, math.radians(-3), 0)

    # 银发：发帽 + 长直发 + 侧发
    cap_rings = [
        ellipse_ring(HEAD_C + 0.118, 0.020, 0.022, N, front_scale=1.00),
        ellipse_ring(HEAD_C + 0.100, 0.058, 0.062, N, front_scale=1.00),
        ellipse_ring(HEAD_C + 0.074, 0.092, 0.098, N, front_scale=0.98),
        ellipse_ring(HEAD_C + 0.042, 0.104, 0.110, N, front_scale=0.78),
        ellipse_ring(HEAD_C + 0.006, 0.106, 0.112, N, front_scale=0.58),
        ellipse_ring(HEAD_C - 0.032, 0.098, 0.104, N, front_scale=0.46),
    ]
    cap = obj_done(loft("cz_hair_cap", cap_rings, cap_start=True, cap_end=False, mat=hair))
    add_solidify(cap, 0.010)
    add_subsurf(cap, 1)

    # 中分刘海（两片斜落）
    for sx in (-1, 1):
        fr = cube(f"cz_hair_fringe_{'L' if sx > 0 else 'R'}", (sx * 0.034, FRONT_Y + 0.026, HEAD_C + 0.052), (0.030, 0.012, 0.078), mat=hair)
        fr.rotation_euler = (math.radians(-14), math.radians(sx * 10), math.radians(sx * 16))
        add_subsurf(fr, 1)

    # 长直发（及腰）：左右两束 + 后束
    for sx in (-1, 1):
        side = "L" if sx > 0 else "R"
        lock = obj_done(
            tube(
                f"cz_hair_long_{side}",
                [(sx * 0.098, 0.010, HEAD_C + 0.010), (sx * 0.104, 0.030, HEAD_C - 0.140), (sx * 0.096, 0.040, 0.900)],
                [(0.026, 0.038), (0.030, 0.044), (0.020, 0.034)],
                n=12,
                mat=hair,
            )
        )
        add_subsurf(lock, 1)
    back = obj_done(
        tube("cz_hair_back", [(0, 0.086, HEAD_C + 0.010), (0, 0.104, 1.300), (0, 0.096, 0.880)], [(0.060, 0.042), (0.070, 0.048), (0.046, 0.034)], n=14, mat=hair)
    )
    add_subsurf(back, 1)
    return head


def build_body(mats):
    skin, coat, white, red, dark = mats["skin"], mats["coat"], mats["white"], mats["red"], mats["dark"]

    torso_rings = [
        ellipse_ring(0.860, 0.132, 0.094, N, front_scale=0.96),
        ellipse_ring(HIP_Z, 0.142, 0.098, N),
        ellipse_ring(1.060, 0.124, 0.086, N),
        ellipse_ring(WAIST_Z, 0.112, 0.080, N, front_scale=0.94),
        ellipse_ring(1.260, 0.146, 0.094, N),
        ellipse_ring(CHEST_Z, 0.168, 0.104, N, front_scale=1.04),
        ellipse_ring(SHOULDER_Z, 0.178, 0.094, N),
        ellipse_ring(1.506, 0.100, 0.080, N),
    ]
    obj_done(loft("cz_torso", torso_rings, mat=skin))
    obj_done(tube("cz_neck", [(0, 0.008, 1.496), (0, 0.010, 1.556), (0, 0.012, 1.594)], [0.044, 0.041, 0.040], n=16, mat=skin))

    # 制式大氅：肩线利落、及膝、微收腰
    coat_rings = [
        ellipse_ring(1.500, 0.186, 0.112, N, front_scale=1.04),
        ellipse_ring(1.440, 0.196, 0.120, N),
        ellipse_ring(1.360, 0.190, 0.120, N, front_scale=1.05),
        ellipse_ring(1.180, 0.172, 0.110, N),
        ellipse_ring(WAIST_Z, 0.164, 0.106, N),
        ellipse_ring(0.960, 0.178, 0.116, N),
        ellipse_ring(0.760, 0.196, 0.128, N),
        ellipse_ring(KNEE_Z + 0.030, 0.208, 0.136, N),
    ]
    coat_obj = obj_done(loft("cz_coat", coat_rings, cap_start=True, cap_end=False, mat=coat))
    add_solidify(coat_obj, 0.013)
    add_subsurf(coat_obj, 1)

    # 白色滚边（下摆 + 开襟）
    hem = loft(
        "cz_hem",
        [ellipse_ring(KNEE_Z + 0.026, 0.210, 0.138, N), ellipse_ring(KNEE_Z + 0.048, 0.209, 0.137, N)],
        cap_start=False,
        cap_end=False,
        mat=white,
    )
    obj_done(hem)
    add_solidify(hem, 0.010)
    # 开襟改用白色滚边（见 cz_collar 与下摆），不再单独插白条

    # 立领（红内衬 + 白边）
    collar_rings = [
        ellipse_ring(1.462, 0.104, 0.086, N, front_scale=1.10),
        ellipse_ring(1.516, 0.110, 0.092, N, front_scale=1.14),
        ellipse_ring(1.556, 0.100, 0.084, N, front_scale=1.16),
    ]
    collar = obj_done(loft("cz_collar", collar_rings, cap_start=False, cap_end=False, mat=coat))
    add_solidify(collar, 0.011)
    inner_collar = loft(
        "cz_collar_red",
        [ellipse_ring(1.470, 0.098, 0.080, N, front_scale=1.10), ellipse_ring(1.540, 0.096, 0.080, N, front_scale=1.14)],
        cap_start=False,
        cap_end=False,
        mat=red,
    )
    add_solidify(inner_collar, 0.006)

    # 肩章
    for sx in (-1, 1):
        ep = cube(f"cz_epaulette_{'L' if sx > 0 else 'R'}", (sx * 0.150, 0.0, 1.470), (0.090, 0.070, 0.018), mat=red)
        ep.rotation_euler = (0, math.radians(sx * -8), 0)
        add_subsurf(ep, 1)

    # 腰带（红）
    belt = loft(
        "cz_belt",
        [ellipse_ring(WAIST_Z - 0.018, 0.186, 0.124, N), ellipse_ring(WAIST_Z + 0.022, 0.185, 0.123, N)],
        cap_start=False,
        cap_end=False,
        mat=red,
    )
    obj_done(belt)
    add_solidify(belt, 0.008)

    # 手臂（袖 = 大氅材质）
    for sx in (1, -1):
        side = "L" if sx > 0 else "R"
        sphere(f"cz_shoulder_{side}", (sx * 0.174, 0.0, SHOULDER_Z + 0.004), (0.052, 0.060, 0.048), mat=coat)
        arm_pts = [
            (sx * 0.176, 0.0, SHOULDER_Z - 0.008),
            (sx * 0.202, 0.004, 1.330),
            (sx * 0.216, 0.006, 1.180),
            (sx * 0.224, 0.004, 1.050),
            (sx * 0.228, 0.0, 0.985),
        ]
        sleeve = obj_done(tube(f"cz_sleeve_{side}", arm_pts, [0.050, 0.043, 0.037, 0.031, 0.028], n=16, mat=coat))
        add_subsurf(sleeve, 1)
        # 白袖口 + 银环
        cuffring = loft(
            f"cz_cuff_{side}",
            [
                ellipse_ring(0.985, 0.031, 0.031, N),
                ellipse_ring(1.020, 0.033, 0.033, N),
            ],
            cap_start=False,
            cap_end=False,
            mat=white,
        )
        add_solidify(cuffring, 0.006)
        cuffring.location.x = sx * 0.228
        # 手（纤细）
        cube(f"cz_palm_{side}", (sx * 0.229, -0.004, 0.930), (0.036, 0.026, 0.064), mat=skin)
        for fi in range(4):
            fx = sx * (0.216 + fi * 0.009)
            fz = 0.882 - abs(fi - 1.5) * 0.004
            f = cube(f"cz_finger{fi}_{side}", (fx, -0.008, fz), (0.0075, 0.018, 0.040), mat=skin)
            f.rotation_euler = (math.radians(-5), 0, 0)
        cube(f"cz_thumb_{side}", (sx * 0.203, -0.024, 0.918), (0.014, 0.026, 0.036), mat=skin)

    # 腿与靴
    for sx in (1, -1):
        side = "L" if sx > 0 else "R"
        leg = obj_done(
            tube(
                f"cz_leg_{side}",
                [(sx * 0.078, 0, 0.950), (sx * 0.084, 0.004, 0.760), (sx * 0.088, 0.006, KNEE_Z), (sx * 0.090, 0.004, 0.290), (sx * 0.090, 0, ANKLE_Z + 0.01)],
                [0.070, 0.060, 0.052, 0.044, 0.038],
                n=14,
                mat=dark,
            )
        )
        add_subsurf(leg, 1)
        cube(f"cz_boot_{side}", (sx * 0.090, -0.024, 0.046), (0.070, 0.110, 0.066), mat=dark)
        cube(f"cz_boot_toe_{side}", (sx * 0.090, -0.078, 0.034), (0.062, 0.062, 0.042), mat=dark)
        obj_done(tube(f"cz_boot_shaft_{side}", [(sx * 0.090, 0, 0.090), (sx * 0.090, 0, 0.240)], [0.046, 0.043], n=14, mat=dark))
    return coat_obj


def build_emblem(mats):
    """镰刀锤子金属徽章：锤 = 柄 + 头；镰 = 弧形刀身 + 柄。放在胸口。"""
    metal = mats["metal"]
    base = (0.0, -0.128, 1.290)
    parts = []
    # 锤子：柄（竖）+ 头（横）
    handle = cube("cz_emb_hammer_handle", (base[0] - 0.048, base[1] - 0.002, base[2] + 0.030), (0.011, 0.010, 0.062), mat=metal)
    handle.rotation_euler = (0, 0, 0)
    head = cube("cz_emb_hammer_head", (base[0] - 0.048, base[1] - 0.002, base[2] + 0.092), (0.070, 0.017, 0.012), mat=metal)
    head.rotation_euler = (0, 0, 0)
    parts += [handle, head]
    # 镰刀：沿圆弧放样出刀身（v1 用散块拼，刀身断成一段段，已废弃）
    cx, cz = base[0] + 0.018, base[2] + 0.006
    arc_pts, arc_rad = [], []
    for i in range(13):
        a = math.radians(196 - i * 12)
        r = 0.062 - i * 0.0012
        arc_pts.append((cx + r * math.cos(a), base[1] + 0.001, cz + r * math.sin(a)))
        arc_rad.append(0.0075 + 0.0045 * math.sin(math.pi * i / 12))
    sickle = tube("cz_emb_sickle", arc_pts, arc_rad, n=8, mat=metal)
    parts.append(sickle)
    # 徽章底环
    bpy.ops.mesh.primitive_torus_add(major_radius=0.052, minor_radius=0.006, location=(base[0], base[1] + 0.004, base[2]), major_segments=28, minor_segments=8)
    ring = bpy.context.object
    ring.name = "cz_emb_ring"
    ring.rotation_euler = (math.radians(90), 0, 0)
    ring.data.materials.append(mats["red"])
    parts.append(ring)
    for p in parts:
        recalc_normals(p)
    return parts


def build_materials():
    mats = {}

    # 大氅：灰→深灰渐变（与 TxzF 同一手法：Generated Z）
    m = bpy.data.materials.new("M_cz_coat")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    ramp.color_ramp.elements[0].position = 0.05
    ramp.color_ramp.elements[0].color = (0.075, 0.082, 0.100, 1)
    ramp.color_ramp.elements[1].position = 0.80
    ramp.color_ramp.elements[1].color = (0.030, 0.033, 0.042, 1)
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.42
    bsdf.inputs["Metallic"].default_value = 0.08
    m.diffuse_color = (0.06, 0.07, 0.09, 1)
    mats["coat"] = m

    mats["skin"] = mat_simple("M_cz_skin", (0.560, 0.520, 0.520), roughness=0.48)
    mats["hair"] = mat_simple("M_cz_hair", PALETTE["silver_hair"], metallic=0.15, roughness=0.30)
    mats["white"] = mat_simple("M_cz_white", PALETTE["white"], roughness=0.40)
    mats["red"] = mat_simple("M_cz_red", PALETTE["red"], roughness=0.38)
    mats["pink"] = mat_simple("M_cz_pink", PALETTE["pink"], roughness=0.45)
    mats["dark"] = mat_simple("M_cz_dark", (0.025, 0.028, 0.036), roughness=0.35)
    mats["lip"] = mat_simple("M_cz_lip", (0.420, 0.180, 0.220), roughness=0.35)
    mats["metal"] = mat_simple("M_cz_metal", PALETTE["silver"], metallic=1.0, roughness=0.20)

    # 星辰眼：与 TxzF 同构（Voronoi 星点 + 自发光），只换基色
    eye = bpy.data.materials.new("M_cz_eye_star")
    eye.use_nodes = True
    nt = eye.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 42.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp.color_ramp.elements[1].position = 0.12
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    nt.links.new(coord.outputs["Object"], vor.inputs["Vector"])
    nt.links.new(vor.outputs["Distance"], ramp.inputs["Fac"])
    key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    bsdf.inputs[key].default_value = (0.60, 0.78, 1.0, 1)
    bsdf.inputs["Emission Strength"].default_value = 0.40
    bsdf.inputs["Base Color"].default_value = (0.05, 0.09, 0.18, 1)
    bsdf.inputs["Roughness"].default_value = 0.10
    eye.diffuse_color = (0.10, 0.16, 0.30, 1)
    mats["eye"] = eye
    return mats


def assign(mats):
    rules = [
        ("cz_coat", "coat"),
        ("cz_collar", "coat"),
        ("cz_shoulder", "coat"),
        ("cz_sleeve", "coat"),
        ("cz_hem", "white"),
        ("cz_placket", "white"),
        ("cz_cuff", "white"),
        ("cz_collar_red", "red"),
        ("cz_epaulette", "red"),
        ("cz_belt", "red"),
        ("cz_emb_ring", "red"),
        ("cz_emb_", "metal"),
        ("cz_head", "skin"),
        ("cz_ear", "skin"),
        ("cz_neck", "skin"),
        ("cz_nose", "skin"),
        ("cz_palm", "skin"),
        ("cz_finger", "skin"),
        ("cz_thumb", "skin"),
        ("cz_torso", "skin"),
        ("cz_eye", "eye"),
        ("cz_lid", "dark"),
        ("cz_mouth", "lip"),
        ("cz_hair", "hair"),
        ("cz_brow", "hair"),
        ("cz_boot", "dark"),
        ("cz_leg", "dark"),
    ]
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        key = next((k for prefix, k in rules if obj.name.startswith(prefix)), None)
        if key:
            obj.data.materials.clear()
            obj.data.materials.append(mats[key])


def add_lighting():
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new("W_cz")
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.014, 0.012, 0.016, 1)
    bg.inputs[1].default_value = 1.0

    def area(name, loc, rot, energy, size, color):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.size = size
        data.color = color
        ob = bpy.data.objects.new(name, data)
        ob.location = loc
        ob.rotation_euler = tuple(math.radians(a) for a in rot)
        bpy.context.collection.objects.link(ob)

    area("cz_key", (-1.6, -2.0, 2.1), (52, 0, -38), 48, 1.5, (1.0, 0.90, 0.92))
    area("cz_fill", (1.9, -1.5, 1.4), (68, 0, 52), 16, 1.7, (0.72, 0.80, 1.0))
    area("cz_rim", (0.8, 2.3, 1.9), (66, 0, 158), 42, 1.1, (1.0, 0.55, 0.60))


def main():
    reset_scene()
    ensure_dirs()
    mats = build_materials()
    build_body(mats)
    build_head(mats)
    build_emblem(mats)
    assign(mats)
    add_lighting()

    blend = os.path.join(OUT_DIR, "changzhengji.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    print("SAVED", blend)

    configure_render(engine="CYCLES", res=(600, 1200), samples=24)
    for name, loc, rot in [
        ("front", (0, -6, 0.92), (90, 0, 0)),
        ("side", (6, 0, 0.92), (90, 0, 90)),
        ("back", (0, 6, 0.92), (90, 0, 180)),
    ]:
        cam = ortho_camera(f"cz_cam_{name}", loc, rot, 1.95)
        render_with(cam, os.path.join(RENDER_DIR, f"cz_{name}.png"))

    # 徽章特写
    configure_render(engine="CYCLES", res=(600, 600), samples=32)
    cam = ortho_camera("cz_cam_emblem", (0, -2.0, 1.29), (90, 0, 0), 0.30)
    render_with(cam, os.path.join(RENDER_DIR, "cz_emblem.png"))
    # 头部特写
    cam2 = ortho_camera("cz_cam_head", (0, -2.4, HEAD_C), (90, 0, 0), 0.40)
    render_with(cam2, os.path.join(RENDER_DIR, "cz_head.png"))


if __name__ == "__main__":
    main()
