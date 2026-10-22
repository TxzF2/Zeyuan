"""
dsh-training · 角色建模公共库（Blender 5.2 / bpy）
----------------------------------------------------------------------------
所有角色共用：重置场景、放样网格、管状肢体、材质、正交相机、渲染。
约定：单位=米；角色面朝 -Y；左脚/右手等左右以角色自身为准（.L 在 +X）。
"""

import bpy
import bmesh
import math
import os
from mathutils import Vector

PROJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(PROJ_ROOT, "out")
RENDER_DIR = os.path.join(OUT_DIR, "renders")


def ensure_dirs():
    os.makedirs(RENDER_DIR, exist_ok=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30
    return scene


# --------------------------------------------------------------------------
# 网格构造
# --------------------------------------------------------------------------
def make_obj(name, verts, faces, mat=None, smooth=True):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def ellipse_ring(z, rx, ry, n=24, cx=0.0, cy=0.0, front_scale=1.0, back_scale=1.0):
    """水平椭圆环；front(-Y 方向) / back(+Y) 可分别缩放，用于收胸收腹。"""
    pts = []
    for i in range(n):
        a = 2.0 * math.pi * i / n
        sx, sy = math.cos(a), math.sin(a)
        y = ry * sy * (back_scale if sy > 0 else front_scale)
        pts.append((cx + rx * sx, cy + y, z))
    return pts


def loft(name, rings, cap_start=True, cap_end=True, mat=None, smooth=True):
    n = len(rings[0])
    verts, faces = [], []
    for r in rings:
        verts.extend(r)
    for k in range(len(rings) - 1):
        base = k * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((base + i, base + j, base + n + j, base + n + i))
    if cap_start:
        faces.append(tuple(range(n - 1, -1, -1)))
    if cap_end:
        base = (len(rings) - 1) * n
        faces.append(tuple(range(base, base + n)))
    return make_obj(name, verts, faces, mat=mat, smooth=smooth)


def tube(name, points, radii, n=16, mat=None, cap=True):
    """沿折线放样管状体（肢体）。radii 可为标量或 (rx, ry)。"""
    rings = []
    pts = [Vector(p) for p in points]
    for i, p in enumerate(pts):
        if i == 0:
            tangent = pts[1] - p
        elif i == len(pts) - 1:
            tangent = p - pts[-2]
        else:
            tangent = pts[i + 1] - pts[i - 1]
        tangent.normalize()
        up = Vector((0, 0, 1))
        if abs(tangent.dot(up)) > 0.95:
            up = Vector((0, 1, 0))
        side = tangent.cross(up).normalized()
        fwd = side.cross(tangent).normalized()
        r = radii[i]
        rx, ry = (r, r) if isinstance(r, (int, float)) else r
        ring = []
        for k in range(n):
            a = 2.0 * math.pi * k / n
            ring.append(tuple(p + side * (rx * math.cos(a)) + fwd * (ry * math.sin(a))))
        rings.append(ring)
    return loft(name, rings, cap_start=cap, cap_end=cap, mat=mat)


def sphere(name, loc, scale, mat=None, segments=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def cube(name, loc, scale, mat=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    return obj


def add_subsurf(obj, levels=1, render_levels=None):
    mod = obj.modifiers.new("Subsurf", "SUBSURF")
    mod.levels = levels
    mod.render_levels = render_levels if render_levels is not None else levels
    return mod


def add_solidify(obj, thickness=0.012, offset=0.0):
    mod = obj.modifiers.new("Solidify", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = offset
    return mod


def add_mirror(obj, axis="X"):
    mod = obj.modifiers.new("Mirror", "MIRROR")
    mod.use_axis[0] = axis == "X"
    mod.use_axis[1] = axis == "Y"
    mod.use_axis[2] = axis == "Z"
    return mod


def recalc_normals(obj):
    """放样顺序不同会导致法线内翻；统一重算，避免出现"看不见的头发"。"""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return obj


# --------------------------------------------------------------------------
# 材质
# --------------------------------------------------------------------------
def mat_simple(name, color, metallic=0.0, roughness=0.6, emission=None, emission_strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = alpha
        if alpha < 1.0:
            m.blend_method = "BLEND"
    if emission is not None:
        key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[key].default_value = (*emission, 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    # Workbench 视口/渲染色（白模阶段靠它出剪影）
    m.diffuse_color = (*color, 1.0)
    m.metallic = metallic
    m.roughness = roughness
    return m


# --------------------------------------------------------------------------
# 相机与渲染
# --------------------------------------------------------------------------
def ortho_camera(name, location, rotation_deg, ortho_scale=2.2):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = ortho_scale
    cam_data.clip_start = 0.01
    cam_data.clip_end = 100.0
    cam = bpy.data.objects.new(name, cam_data)
    cam.location = location
    cam.rotation_euler = tuple(math.radians(a) for a in rotation_deg)
    bpy.context.collection.objects.link(cam)
    return cam


def persp_camera(name, location, rotation_deg, lens=85.0):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam = bpy.data.objects.new(name, cam_data)
    cam.location = location
    cam.rotation_euler = tuple(math.radians(a) for a in rotation_deg)
    bpy.context.collection.objects.link(cam)
    return cam


def configure_render(engine="BLENDER_WORKBENCH", res=(640, 1280), samples=48, transparent=True):
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = transparent
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    if engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
    elif engine == "BLENDER_WORKBENCH":
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "MATERIAL"
        sh.show_cavity = True
        sh.cavity_type = "BOTH"
        sh.show_shadows = True
    return scene


def render_with(cam, filepath):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    print("RENDERED", filepath)


# --------------------------------------------------------------------------
# 标准四视图（正交：正/侧/背 + 3/4 透视）
# --------------------------------------------------------------------------
def render_turnaround(prefix, center_z=0.95, ortho_scale=2.15, res=(640, 1280), engine="BLENDER_WORKBENCH"):
    ensure_dirs()
    configure_render(engine=engine, res=res)
    dist = 6.0
    cams = {
        "front": ortho_camera("cam_front", (0, -dist, center_z), (90, 0, 0), ortho_scale),
        "side": ortho_camera("cam_side", (dist, 0, center_z), (90, 0, 90), ortho_scale),
        "back": ortho_camera("cam_back", (0, dist, center_z), (90, 0, 180), ortho_scale),
    }
    quarter = ortho_camera(
        "cam_quarter", (-dist * 0.7071, -dist * 0.7071, center_z), (90, 0, -45), ortho_scale
    )
    for name, cam in cams.items():
        render_with(cam, os.path.join(RENDER_DIR, f"{prefix}_{name}.png"))
    render_with(quarter, os.path.join(RENDER_DIR, f"{prefix}_quarter.png"))
    # 清理相机，避免污染后续阶段
    for cam in list(cams.values()) + [quarter]:
        bpy.data.objects.remove(cam, do_unlink=True)
