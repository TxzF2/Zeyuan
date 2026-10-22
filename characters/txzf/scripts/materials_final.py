"""
TxzF · M2 材质（四色体系 + 星辰眼 + 银色配饰）
----------------------------------------------------------------------------
输入：out/txzf_body.blend（M1 白模）
产物：out/txzf.blend + out/renders/m2_txzf_{front,quarter,head}.png

四色：黑 #0B0E14 / 灰 #3A4150 / 银 #C9D1E0 / 蓝 #4C7DFF
星辰感：灰蓝基调 + 星辰眼（Voronoi 星点 + 自发光）+ 衣摆/腕饰星尘

运行：blender -b --factory-startup --python materials_final.py -- --samples 24
"""

import os
import sys
import math
import random

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from dsh_lib import configure_render, render_with, ortho_camera, RENDER_DIR, OUT_DIR, ensure_dirs  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
SAMPLES = int(ARGS[ARGS.index("--samples") + 1]) if "--samples" in ARGS else 24

# ---------------------------------------------------------------- 配色（唯一来源）
PALETTE = {
    "black": (0.043, 0.055, 0.078),   # #0B0E14
    "graphite": (0.227, 0.255, 0.314),  # #3A4150
    "silver": (0.788, 0.820, 0.878),  # #C9D1E0
    "blue": (0.298, 0.490, 1.000),    # #4C7DFF
    "skin": (0.430, 0.455, 0.500),
    "hair": (0.055, 0.062, 0.086),
    "shirt": (0.075, 0.115, 0.220),
}


def _principled(mat):
    return mat.node_tree.nodes.get("Principled BSDF")


def mat_coat_gradient():
    """黑灰渐变大衣：Generated Z → ColorRamp → BaseColor / Roughness。"""
    m = bpy.data.materials.new("M_coat")
    m.use_nodes = True
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = _principled(m)

    tex = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeValToRGB")
    rough = nodes.new("ShaderNodeValToRGB")

    links.new(tex.outputs["Generated"], sep.inputs["Vector"])
    links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    links.new(sep.outputs["Z"], rough.inputs["Fac"])

    # 下摆偏灰、上身近黑：反向映射（Z 小=下摆）
    ramp.color_ramp.elements[0].position = 0.05
    ramp.color_ramp.elements[0].color = (*PALETTE["graphite"], 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (*PALETTE["black"], 1)
    mid = ramp.color_ramp.elements.new(0.45)
    mid.color = (0.115, 0.135, 0.180, 1)

    rough.color_ramp.elements[0].position = 0.0
    rough.color_ramp.elements[0].color = (0.72, 0.72, 0.72, 1)
    rough.color_ramp.elements[1].position = 1.0
    rough.color_ramp.elements[1].color = (0.48, 0.48, 0.48, 1)

    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = 0.05
    m.diffuse_color = (0.10, 0.12, 0.16, 1)
    return m


def mat_star_eye():
    """星辰眼：深蓝底 + Voronoi 星点自发光 + Fresnel 边缘微光。"""
    m = bpy.data.materials.new("M_eye_star")
    m.use_nodes = True
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = _principled(m)

    coord = nodes.new("ShaderNodeTexCoord")
    vor = nodes.new("ShaderNodeTexVoronoi")
    vor.feature = "F1"
    vor.inputs["Scale"].default_value = 38.0
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp.color_ramp.elements[1].position = 0.12
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)

    emit = nodes.new("ShaderNodeBackground")
    mix = nodes.new("ShaderNodeMixShader")
    emit.inputs["Color"].default_value = (*PALETTE["blue"], 1)
    emit.inputs["Strength"].default_value = 0.9

    fres = nodes.new("ShaderNodeFresnel")
    fres.inputs["IOR"].default_value = 1.45

    links.new(coord.outputs["Object"], vor.inputs["Vector"])
    links.new(vor.outputs["Distance"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 0.35
    bsdf.inputs["Base Color"].default_value = (0.02, 0.045, 0.14, 1)
    bsdf.inputs["Roughness"].default_value = 0.08
    m.diffuse_color = (0.05, 0.10, 0.30, 1)
    return m


def mat_simple_named(name, color, metallic=0.0, roughness=0.5, bump_noise=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = _principled(m)
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if bump_noise > 0:
        nt = m.node_tree
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 220.0
        noise.inputs["Detail"].default_value = 2.0
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_noise
        nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    m.diffuse_color = (*color, 1)
    m.metallic = metallic
    m.roughness = roughness
    return m


def assign_materials():
    mats = {
        "coat": mat_coat_gradient(),
        "skin": mat_simple_named("M_skin", PALETTE["skin"], roughness=0.52),
        "hair": mat_simple_named("M_hair", PALETTE["hair"], roughness=0.30),
        "metal": mat_simple_named("M_silver", PALETTE["silver"], metallic=1.0, roughness=0.22, bump_noise=0.06),
        "shirt": mat_simple_named("M_shirt", PALETTE["shirt"], roughness=0.55),
        "dark": mat_simple_named("M_dark", (0.035, 0.042, 0.055), roughness=0.38, bump_noise=0.05),
        "eye": mat_star_eye(),
    }

    rules = [
        ("txzf_coat", "coat"),
        ("txzf_collar", "coat"),
        ("txzf_lapel", "coat"),
        ("txzf_shoulder", "coat"),
        ("txzf_sleeve", "coat"),
        ("txzf_leg_", "coat"),
        ("txzf_head", "skin"),
        ("txzf_ear", "skin"),
        ("txzf_neck", "skin"),
        ("txzf_hand", "skin"),
        ("txzf_palm", "skin"),
        ("txzf_finger", "skin"),
        ("txzf_thumb", "skin"),
        ("txzf_nose", "skin"),
        ("txzf_torso", "skin"),
        ("txzf_hair", "hair"),
        ("txzf_brow", "hair"),
        ("txzf_eye", "eye"),
        ("txzf_inner_panel", "shirt"),
        ("txzf_belt", "metal"),
        ("txzf_buckle", "metal"),
        ("txzf_cuff", "metal"),
        ("txzf_boot_rim", "metal"),
        ("txzf_dark", "dark"),
        ("txzf_mouth", "dark"),
        ("txzf_lid", "dark"),
        ("txzf_boot", "dark"),
        ("txzf_vent", "dark"),
    ]

    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        key = next((k for prefix, k in rules if obj.name.startswith(prefix)), None)
        if not key:
            continue
        obj.data.materials.clear()
        obj.data.materials.append(mats[key])

    summary = {}
    for obj in bpy.data.objects:
        if obj.type == "MESH" and obj.data.materials:
            summary.setdefault(obj.data.materials[0].name, []).append(obj.name)
    for mat_name, objs in summary.items():
        print("MAT", mat_name, len(objs), "objs:", ", ".join(objs[:4]))
    return mats


def add_star_dust(mats):
    """衣摆与腕饰的星尘：小自发光球，仅用于渲染演示（FBX 不含粒子）。"""
    random.seed(20261022)
    dust_mat = bpy.data.materials.new("M_stardust")
    dust_mat.use_nodes = True
    bsdf = _principled(dust_mat)
    key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    bsdf.inputs[key].default_value = (*PALETTE["blue"], 1)
    bsdf.inputs["Emission Strength"].default_value = 3.0
    bsdf.inputs["Base Color"].default_value = (*PALETTE["blue"], 1)

    count = 0
    for i in range(70):
        # 环绕大衣下摆与手腕
        ring = random.random()
        if ring < 0.65:
            ang = random.uniform(0, 2 * math.pi)
            r = random.uniform(0.20, 0.30)
            z = random.uniform(0.52, 1.05)
        else:
            sx = random.choice((-1, 1))
            ang = random.uniform(0, 2 * math.pi)
            r = random.uniform(0.03, 0.07)
            z = random.uniform(0.96, 1.06)
            x = sx * 0.254 + r * math.cos(ang)
            y = r * math.sin(ang) * 0.6
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=random.uniform(0.0022, 0.0050), location=(x, y, z))
            ob = bpy.context.object
            ob.name = f"txzf_dust_{count}"
            ob.data.materials.append(dust_mat)
            count += 1
            continue
        x = r * math.cos(ang)
        y = r * math.sin(ang) * 0.72
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=random.uniform(0.0022, 0.0050), location=(x, y, z))
        ob = bpy.context.object
        ob.name = f"txzf_dust_{count}"
        ob.data.materials.append(dust_mat)
        count += 1
    print("STARDUST", count)


def add_lighting():
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new("W_txzf")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.012, 0.016, 0.030, 1)
    bg.inputs[1].default_value = 1.0

    def area(name, loc, rot, energy, size, color=(1, 1, 1)):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.size = size
        data.color = color
        ob = bpy.data.objects.new(name, data)
        ob.location = loc
        ob.rotation_euler = tuple(math.radians(a) for a in rot)
        bpy.context.collection.objects.link(ob)
        return ob

    area("key", (-1.6, -2.0, 2.2), (52, 0, -38), 55, 1.6, (0.80, 0.86, 1.0))
    area("fill", (2.0, -1.4, 1.5), (68, 0, 52), 18, 1.8, (0.62, 0.74, 1.0))
    area("rim", (0.9, 2.4, 2.0), (66, 0, 158), 45, 1.2, (0.55, 0.72, 1.0))
    area("top", (0.0, 0.2, 3.0), (0, 0, 0), 14, 2.0, (0.9, 0.94, 1.0))


def main():
    ensure_dirs()
    blend_in = os.path.join(OUT_DIR, "txzf_body.blend")
    bpy.ops.wm.open_mainfile(filepath=blend_in)

    mats = assign_materials()
    add_star_dust(mats)
    add_lighting()

    blend_out = os.path.join(OUT_DIR, "txzf.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_out)
    print("SAVED", blend_out)

    # Cycles CPU 出图（samples 可调）
    configure_render(engine="CYCLES", res=(600, 1200), samples=SAMPLES)
    front = ortho_camera("cam_front", (0, -6, 0.95), (90, 0, 0), 2.05)
    land = (-6 * 0.7071, -6 * 0.7071, 0.95)
    quarter = ortho_camera("cam_quarter", land, (90, 0, -45), 2.05)
    render_with(front, os.path.join(RENDER_DIR, "m2_txzf_front.png"))
    render_with(quarter, os.path.join(RENDER_DIR, "m2_txzf_quarter.png"))

    configure_render(engine="CYCLES", res=(720, 720), samples=SAMPLES)
    head = ortho_camera("cam_head", (0, -3.0, 1.699), (90, 0, 0), 0.44)
    render_with(head, os.path.join(RENDER_DIR, "m2_txzf_head.png"))


if __name__ == "__main__":
    main()
