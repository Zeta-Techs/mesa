#!/usr/bin/env python3
"""高频科研三维构件库（blender-research 技能随包）。

全部使用纯 bmesh / bpy 参数化建模：
- 不依赖 SOLIDIFY + BOOLEAN 剖切（避开 Blender 5.x 布尔静默失效）；
- 提供 apply_modifier_safe（显式绑定 view_layer.objects.active）；
- 每个构件返回 (objects, anchors_world_dict)，自动输出关键位点的 3D 世界坐标，
  配合 scene_illus.project_anchors_to_sidecar 自动导出 .png.json 喂给 schematic-forge。
"""
from __future__ import annotations

import math
from typing import Any

import scene_illus as SI

SUPPORTED_KIT_SHAPES = (
    "three_electrode_cell",
    "flow_cell",
    "vacuum_chamber",
    "layered_stack",
    "electrode_interface",
    "crystal_lattice",
    "sample_vial",
)


def apply_modifier_safe(obj: Any, mod_name: str) -> None:
    """安全应用修改器：先设为 active 对象并选中，防止 Blender 4/5 抛上下文缺失异常。"""
    import bpy

    vl = bpy.context.view_layer
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    vl.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod_name)


def _link_bmesh(name: str, bm: Any, mat: Any = None, location=(0.0, 0.0, 0.0), smooth: bool = False) -> Any:
    import bpy

    mesh = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        for poly in mesh.polygons:
            poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def _make_box(name: str, size: tuple[float, float, float], center: tuple[float, float, float], mat: Any) -> Any:
    import bmesh
    from mathutils import Matrix

    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    return _link_bmesh(name, bm, mat)


def _make_cylinder(
    name: str,
    radius: float,
    depth: float,
    center: tuple[float, float, float],
    mat: Any,
    segments: int = 48,
    axis: str = "Z",
    open_top: bool = False,
) -> Any:
    import bmesh
    from mathutils import Matrix

    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=segments,
        radius1=radius,
        radius2=radius,
        depth=depth,
    )
    if open_top:
        top_faces = [f for f in bm.faces if f.normal.z > 0.85]
        if top_faces:
            bmesh.ops.delete(bm, geom=top_faces, context="FACES_ONLY")
    if axis == "X":
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 3, "Y"))
    elif axis == "Y":
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 3, "X"))
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    # 仅圆弧侧面启用平滑着色（平顶/平底端面保持平直，避免端面法线发黑）
    obj = _link_bmesh(name, bm, mat, smooth=False)
    if segments >= 16:
        for poly in obj.data.polygons:
            if len(poly.vertices) == 4:
                poly.use_smooth = True
    return obj


def _make_sphere(name: str, radius: float, center: tuple[float, float, float], mat: Any, segs: int = 24) -> Any:
    import bmesh

    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=max(12, segs // 2), radius=radius)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    return _link_bmesh(name, bm, mat, smooth=True)


def _make_bond(name: str, p1: tuple[float, float, float], p2: tuple[float, float, float], radius: float, mat: Any) -> Any:
    import bmesh
    from mathutils import Vector

    v1, v2 = Vector(p1), Vector(p2)
    diff = v2 - v1
    length = diff.length
    if length < 1e-5:
        return None
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=14, radius1=radius, radius2=radius, depth=length)
    rot = Vector((0, 0, 1)).rotation_difference(diff.normalized()).to_matrix()
    bmesh.ops.rotate(bm, verts=bm.verts, matrix=rot)
    bmesh.ops.translate(bm, vec=(v1 + v2) * 0.5, verts=bm.verts)
    return _link_bmesh(name, bm, mat)


def _offset_anchors(anchors: dict[str, tuple[float, float, float]], loc: tuple[float, float, float], scale: tuple[float, float, float], prefix: str) -> dict[str, tuple[float, float, float]]:
    ox, oy, oz = loc
    sx, sy, sz = scale
    out: dict[str, tuple[float, float, float]] = {}
    for k, (x, y, z) in anchors.items():
        key = f"{prefix}_{k}" if prefix else k
        out[key] = (ox + x * sx, oy + y * sy, oz + z * sz)
    return out


def _apply_parent_xform(objs: list[Any], loc: tuple[float, float, float], scale: tuple[float, float, float]) -> None:
    ox, oy, oz = loc
    sx, sy, sz = scale
    for o in objs:
        o.location = (o.location.x * sx + ox, o.location.y * sy + oy, o.location.z * sz + oz)
        o.scale = (o.scale.x * sx, o.scale.y * sy, o.scale.z * sz)


def _make_tube(name: str, points: list[tuple[float, float, float]], radius: float, mat: Any) -> Any:
    """平滑 Bezier 导线 / 导管曲线对象。"""
    import bpy

    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 6
    cu.resolution_u = 20
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(points) - 1)
    for bp, p in zip(sp.bezier_points, points):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(obj)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def _make_helix(
    name: str,
    center_xy: tuple[float, float],
    z0: float,
    z1: float,
    coil_r: float,
    wire_r: float,
    turns: int,
    mat: Any,
) -> Any:
    pts = []
    steps = max(18, turns * 10)
    cx, cy = center_xy
    for i in range(steps + 1):
        t = i / steps
        ang = 2.0 * math.pi * turns * t
        pts.append((cx + coil_r * math.cos(ang), cy + coil_r * math.sin(ang), z0 + (z1 - z0) * t))
    return _make_tube(name, pts, wire_r, mat)


def make_three_electrode_cell(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "CYCLES",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """顶刊级三电极电解池（半透明玻璃杯、电解液、PTFE 密封盖、WE 电极夹、螺旋 CE、参比管与三色弯导线）。"""
    m_glass = SI.make_material(f"{prefix}_glass", SI.resolve_color("glass", palette), alpha=0.30, style=style, engine=engine, kind="glass")
    m_liq = SI.make_material(f"{prefix}_elec", SI.resolve_color("liquid", palette), alpha=0.45, style=style, engine=engine, kind="liquid")
    m_lid = SI.make_material(f"{prefix}_lid", SI.resolve_color("ptfe", palette), style=style, engine=engine)
    m_we = SI.make_material(f"{prefix}_we", SI.resolve_color("primary", palette), style=style, engine=engine)
    m_clamp = SI.make_material(f"{prefix}_clamp", SI.resolve_color("gold", palette), style=style, engine=engine, kind="metal")
    m_ce = SI.make_material(f"{prefix}_ce", SI.resolve_color("dark", palette), style=style, engine=engine, kind="metal")
    m_re = SI.make_material(f"{prefix}_re", SI.resolve_color("ptfe", palette), style=style, engine=engine)
    m_w_we = SI.make_material(f"{prefix}_wire_we", SI.resolve_color("wire_we", palette), style=style, engine=engine)
    m_w_ce = SI.make_material(f"{prefix}_wire_ce", SI.resolve_color("wire_ce", palette), style=style, engine=engine)
    m_w_re = SI.make_material(f"{prefix}_wire_re", SI.resolve_color("wire_re", palette), style=style, engine=engine)
    m_bub = SI.make_material(f"{prefix}_bub", "#FFFFFF", alpha=0.85, style=style, engine=engine)

    objs = [
        _make_cylinder(f"{prefix}_beaker", 1.32, 2.15, (0, 0, 1.075), m_glass, open_top=True),
        _make_cylinder(f"{prefix}_electrolyte", 1.25, 1.48, (0, 0, 0.76), m_liq),
        # PTFE 盖板（略凸出杯口）
        _make_cylinder(f"{prefix}_lid", 1.42, 0.16, (0, 0, 2.18), m_lid),
        # 工作电极（左中 PTFE 夹杆 + 金色接线头 + 催化极片）
        _make_cylinder(f"{prefix}_we_rod", 0.06, 1.65, (-0.42, -0.05, 1.72), m_re),
        _make_box(f"{prefix}_we_clamp", (0.24, 0.16, 0.22), (-0.42, -0.05, 2.48), m_clamp),
        _make_box(f"{prefix}_we_plate", (0.44, 0.08, 0.68), (-0.42, -0.05, 0.76), m_we),
        # 参比电极（居中白瓷参比管）
        _make_cylinder(f"{prefix}_re_tube", 0.14, 1.95, (0.06, 0.02, 1.62), m_re),
        _make_cylinder(f"{prefix}_re_cap", 0.09, 0.24, (0.06, 0.02, 2.66), m_ce),
        # 对电极（右侧非 Pt 石墨/碳丝螺旋）
        _make_cylinder(f"{prefix}_ce_rod", 0.05, 1.45, (0.58, 0.06, 1.88), m_ce),
        _make_helix(f"{prefix}_ce_coil", (0.58, 0.06), 0.56, 1.25, 0.16, 0.035, 4, m_ce),
        # 三根带弧度的顶刊配色香蕉导线
        _make_tube(f"{prefix}_cable_we", [(-0.42, -0.05, 2.58), (-0.30, 0.05, 3.22), (0.22, 0.35, 2.95), (0.65, 0.55, 0.45)], 0.055, m_w_we),
        _make_tube(f"{prefix}_cable_re", [(0.06, 0.02, 2.74), (0.30, 0.12, 3.34), (0.85, 0.32, 2.88), (1.15, 0.45, 0.35)], 0.055, m_w_ce),
        _make_tube(f"{prefix}_cable_ce", [(0.58, 0.06, 2.58), (0.88, 0.12, 3.16), (1.35, 0.22, 2.55), (1.52, 0.30, 0.42)], 0.055, m_w_re),
    ]
    for i, (bx, by, bz, br) in enumerate([
        (-0.50, -0.11, 0.92, 0.055),
        (-0.34, -0.10, 1.08, 0.065),
        (-0.43, -0.12, 1.26, 0.072),
    ]):
        objs.append(_make_sphere(f"{prefix}_bubble_{i}", br, (bx, by, bz), m_bub, segs=12))

    _apply_parent_xform(objs, loc, scale)
    raw_anchors = {
        "we_tip": (-0.42, -0.08, 0.76),
        "re_tip": (0.06, 0.02, 1.12),
        "ce_tip": (0.58, 0.06, 0.90),
        "electrolyte_surface": (-0.05, -0.45, 1.50),
        "bubbles": (-0.42, -0.12, 1.15),
        "cell_body": (1.26, 0.0, 0.65),
    }
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


def make_flow_cell(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "BLENDER_EEVEE_NEXT",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """流动池 / AEMWE 膜电极展开堆叠（阳极板 / GDL / 交换膜 / 阴极催化层 / 阴极板）。"""
    gap = float((opts or {}).get("explode_gap", 0.24))
    m_an = SI.make_material(f"{prefix}_an", SI.resolve_color("dark", palette), style=style, engine=engine)
    m_gdl = SI.make_material(f"{prefix}_gdl", SI.resolve_color("neutral", palette), style=style, engine=engine)
    m_mem = SI.make_material(f"{prefix}_mem", SI.resolve_color("secondary", palette), alpha=0.82, style=style, engine=engine)
    m_cat = SI.make_material(f"{prefix}_cat", SI.resolve_color("accent", palette), style=style, engine=engine)
    m_ca = SI.make_material(f"{prefix}_ca", SI.resolve_color("primary", palette), style=style, engine=engine)

    layers = [
        ("anode_plate", 0.28, (1.9, 1.9), m_an),
        ("anode_gdl", 0.14, (1.5, 1.5), m_gdl),
        ("membrane", 0.08, (1.75, 1.75), m_mem),
        ("catalyst_layer", 0.12, (1.48, 1.48), m_cat),
        ("cathode_gdl", 0.14, (1.5, 1.5), m_gdl),
        ("cathode_plate", 0.28, (1.9, 1.9), m_ca),
    ]
    total_x = sum(t for _, t, _, _ in layers) + gap * (len(layers) - 1)
    cx = -total_x / 2.0
    objs: list[Any] = []
    raw_anchors: dict[str, tuple[float, float, float]] = {}
    for lname, thick, (wy, wz), mat in layers:
        x_mid = cx + thick / 2.0
        objs.append(_make_box(f"{prefix}_{lname}", (thick, wy, wz), (x_mid, 0.0, 0.0), mat))
        raw_anchors[lname] = (x_mid, 0.0, wz / 2.0)
        cx += thick + gap

    # 进出口接头
    inlet_x = -total_x / 2.0 - 0.22
    outlet_x = total_x / 2.0 + 0.22
    objs.append(_make_cylinder(f"{prefix}_inlet", 0.11, 0.45, (inlet_x, 0.0, -0.55), m_an, axis="X"))
    objs.append(_make_cylinder(f"{prefix}_outlet", 0.11, 0.45, (outlet_x, 0.0, 0.55), m_ca, axis="X"))
    raw_anchors["inlet"] = (inlet_x - 0.18, 0.0, -0.55)
    raw_anchors["outlet"] = (outlet_x + 0.18, 0.0, 0.55)

    _apply_parent_xform(objs, loc, scale)
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


def make_vacuum_chamber(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "CYCLES",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """顶刊级 CF 法兰 UHV 原位腔体（不锈钢主腔、顶底带六角螺栓环 CF 法兰、三向光学观察窗与样品台）。"""
    m_steel = SI.make_material(f"{prefix}_steel", SI.resolve_color("metal", palette), style=style, engine=engine, kind="metal")
    m_flange = SI.make_material(f"{prefix}_flange", SI.resolve_color("neutral", palette), style=style, engine=engine, kind="metal")
    m_bolt = SI.make_material(f"{prefix}_bolt", SI.resolve_color("dark", palette), style=style, engine=engine, kind="metal")
    m_win = SI.make_material(f"{prefix}_win", SI.resolve_color("primary", palette), alpha=0.52, style=style, engine=engine, kind="liquid")
    m_stage = SI.make_material(f"{prefix}_stage", SI.resolve_color("accent", palette), style=style, engine=engine)

    objs = [
        _make_cylinder(f"{prefix}_body", 1.12, 1.45, (0, 0, 0), m_steel, segments=48),
        _make_cylinder(f"{prefix}_flange_top", 1.34, 0.16, (0, 0, 0.80), m_flange, segments=48),
        _make_cylinder(f"{prefix}_top_window", 0.82, 0.10, (0, 0, 0.87), m_win, segments=48),
        _make_cylinder(f"{prefix}_flange_bot", 1.34, 0.16, (0, 0, -0.80), m_flange, segments=48),
        _make_box(f"{prefix}_sample_stage", (0.66, 0.48, 0.14), (0, 0, -0.10), m_stage),
    ]
    # 顶部法兰一圈 12 颗六角螺栓
    for i in range(12):
        ang = 2.0 * math.pi * i / 12.0
        bx, by = 1.12 * math.cos(ang), 1.12 * math.sin(ang)
        objs.append(_make_cylinder(f"{prefix}_bolt_top_{i}", 0.065, 0.12, (bx, by, 0.92), m_bolt, segments=6))

    # 侧面 3 个带法兰与螺栓的观察窗（前、左前、右前）
    for idx, deg in enumerate((-90.0, -35.0, -145.0)):
        rad = math.radians(deg)
        ux, uy = math.cos(rad), math.sin(rad)
        import bmesh
        from mathutils import Vector

        def _port_cyl(nm: str, r: float, depth: float, dist: float, mat: Any, segs: int = 36):
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r, depth=depth)
            rot = Vector((0, 0, 1)).rotation_difference(Vector((ux, uy, 0))).to_matrix()
            bmesh.ops.rotate(bm, verts=bm.verts, matrix=rot)
            bmesh.ops.translate(bm, vec=(ux * dist, uy * dist, 0.04), verts=bm.verts)
            obj = _link_bmesh(nm, bm, mat, smooth=False)
            for poly in obj.data.polygons:
                if len(poly.vertices) == 4:
                    poly.use_smooth = True
            return obj

        objs.append(_port_cyl(f"{prefix}_p{idx}_neck", 0.36, 0.36, 1.18, m_steel))
        objs.append(_port_cyl(f"{prefix}_p{idx}_ring", 0.48, 0.11, 1.38, m_flange))
        objs.append(_port_cyl(f"{prefix}_p{idx}_glass", 0.30, 0.07, 1.43, m_win))
        # 每个侧法兰配 6 颗小螺栓
        perp_x, perp_y = -uy, ux
        for bi in range(6):
            ba = 2.0 * math.pi * bi / 6.0
            br = 0.40
            px = ux * 1.44 + perp_x * br * math.cos(ba)
            py = uy * 1.44 + perp_y * br * math.cos(ba)
            pz = 0.04 + br * math.sin(ba)
            objs.append(_make_sphere(f"{prefix}_p{idx}_b{bi}", 0.038, (px, py, pz), m_bolt, segs=8))

    _apply_parent_xform(objs, loc, scale)
    raw_anchors = {
        "chamber_core": (0.0, 0.0, 0.08),
        "cf_flange_top": (0.0, 0.0, 0.92),
        "optical_window": (0.0, -1.46, 0.04),
        "uhv_transfer": (0.0, 0.0, -0.84),
        "sample_stage": (0.0, 0.0, -0.04),
    }
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


def make_layered_stack(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "BLENDER_EEVEE_NEXT",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """多层异质结/核壳剖面堆叠（纯 bmesh 构造，无布尔运算；支持自定义 layers）。"""
    default_layers = [
        {"name": "substrate", "thickness": 0.48, "color": "dark"},
        {"name": "interlayer", "thickness": 0.28, "color": "primary"},
        {"name": "active_shell", "thickness": 0.24, "color": "accent"},
    ]
    layers = (opts or {}).get("layers") or default_layers
    wx = float((opts or {}).get("width_x", 2.4))
    wy = float((opts or {}).get("width_y", 1.8))
    step_cut = bool((opts or {}).get("stepped_cutaway", True))

    objs: list[Any] = []
    raw_anchors: dict[str, tuple[float, float, float]] = {}
    z_cur = 0.0
    n = len(layers)
    for i, lay in enumerate(layers):
        lname = str(lay.get("name") or f"layer_{i}")
        th = float(lay.get("thickness", 0.3))
        col = SI.resolve_color(lay.get("color"), palette)
        mat = SI.make_material(f"{prefix}_{lname}", col, alpha=float(lay.get("alpha", 1.0)), style=style, engine=engine)
        # 阶梯式剖切露出下层界面，完全不依赖 BOOLEAN
        shrink = (i * 0.16) if (step_cut and n > 1) else 0.0
        lx = max(0.4, wx - shrink)
        ly = max(0.4, wy - shrink)
        cx = -shrink * 0.5
        cy = shrink * 0.5
        objs.append(_make_box(f"{prefix}_{lname}", (lx, ly, th), (cx, cy, z_cur + th / 2.0), mat))
        raw_anchors[lname] = (cx + lx * 0.25, cy - ly * 0.35, z_cur + th * 0.5)
        if i > 0:
            raw_anchors[f"interface_{i}"] = (cx, cy - ly * 0.5, z_cur)
        z_cur += th

    _apply_parent_xform(objs, loc, scale)
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


def make_electrode_interface(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "BLENDER_EEVEE_NEXT",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """固-液催化界面（基底晶板、表面活性团簇、吸附中间体 H*/OH* 与上方透明电解液层）。"""
    m_sub = SI.make_material(f"{prefix}_sub", SI.resolve_color("primary", palette), style=style, engine=engine)
    m_site = SI.make_material(f"{prefix}_site", SI.resolve_color("accent", palette), style=style, engine=engine)
    m_ads = SI.make_material(f"{prefix}_ads", SI.resolve_color("secondary", palette), style=style, engine=engine)
    m_h = SI.make_material(f"{prefix}_h", "#FFFFFF", style=style, engine=engine)
    m_liq = SI.make_material(f"{prefix}_liq", SI.resolve_color("glass", palette), alpha=0.28, style=style, engine=engine)

    objs = [
        _make_box(f"{prefix}_substrate", (2.6, 1.8, 0.45), (0, 0, -0.225), m_sub),
        _make_box(f"{prefix}_electrolyte_zone", (2.6, 1.8, 1.15), (0, 0, 0.6), m_liq),
    ]
    # 表面活性位半球/球
    sites = [(-0.7, 0.0, 0.14), (0.0, 0.0, 0.18), (0.7, 0.0, 0.14)]
    for i, pos in enumerate(sites):
        objs.append(_make_sphere(f"{prefix}_site_{i}", 0.22 if i == 1 else 0.17, pos, m_site))
    # 中央活性位上方吸附分子（如 H2O* / OH* + H*）
    objs.append(_make_sphere(f"{prefix}_ads_o", 0.14, (0.0, 0.0, 0.54), m_ads))
    objs.append(_make_sphere(f"{prefix}_ads_h1", 0.09, (-0.16, 0.0, 0.66), m_h))
    objs.append(_make_sphere(f"{prefix}_ads_h2", 0.09, (0.16, 0.0, 0.66), m_h))
    for i, target in enumerate([(-0.16, 0.0, 0.66), (0.16, 0.0, 0.66)]):
        b = _make_bond(f"{prefix}_bond_{i}", (0.0, 0.0, 0.54), target, 0.035, m_ads)
        if b:
            objs.append(b)

    _apply_parent_xform(objs, loc, scale)
    raw_anchors = {
        "substrate": (-0.9, -0.6, -0.22),
        "active_site": (0.0, 0.0, 0.18),
        "adsorbate": (0.0, 0.0, 0.58),
        "electrolyte": (0.9, 0.0, 0.85),
    }
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


def make_crystal_lattice(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "BLENDER_EEVEE_NEXT",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """三维周期球棍晶格（支持 nx/ny/nz、空位 vacancies、掺杂位 dopants）。"""
    o = opts or {}
    nx = max(1, min(6, int(o.get("nx", 3))))
    ny = max(1, min(6, int(o.get("ny", 3))))
    nz = max(1, min(4, int(o.get("nz", 2))))
    sp = float(o.get("spacing", 0.72))
    rad = float(o.get("radius", 0.17))
    vacancies = {tuple(v) for v in (o.get("vacancies") or []) if isinstance(v, (list, tuple)) and len(v) == 3}
    dopants = {tuple(v) for v in (o.get("dopants") or []) if isinstance(v, (list, tuple)) and len(v) == 3}

    m_host = SI.make_material(f"{prefix}_host", SI.resolve_color("primary", palette), style=style, engine=engine)
    m_b = SI.make_material(f"{prefix}_sub", SI.resolve_color("secondary", palette), style=style, engine=engine)
    m_dop = SI.make_material(f"{prefix}_dop", SI.resolve_color("accent", palette), style=style, engine=engine)
    m_bond = SI.make_material(f"{prefix}_bond", SI.resolve_color("neutral", palette), style=style, engine=engine)

    ox = -(nx - 1) * sp / 2.0
    oy = -(ny - 1) * sp / 2.0
    oz = -(nz - 1) * sp / 2.0
    coords: dict[tuple[int, int, int], tuple[float, float, float]] = {}
    objs: list[Any] = []

    for ix in range(nx):
        for iy in range(ny):
            for iz in range(nz):
                key = (ix, iy, iz)
                if key in vacancies:
                    continue
                pos = (ox + ix * sp, oy + iy * sp, oz + iz * sp)
                coords[key] = pos
                mat = m_dop if key in dopants else (m_host if (ix + iy + iz) % 2 == 0 else m_b)
                r_use = rad * (1.12 if key in dopants else (1.0 if (ix + iy + iz) % 2 == 0 else 0.78))
                objs.append(_make_sphere(f"{prefix}_atom_{ix}_{iy}_{iz}", r_use, pos, mat, segs=16))

    for (ix, iy, iz), p1 in coords.items():
        for nb in ((ix + 1, iy, iz), (ix, iy + 1, iz), (ix, iy, iz + 1)):
            if nb in coords:
                b = _make_bond(f"{prefix}_b_{ix}_{iy}_{iz}_{nb[0]}_{nb[1]}_{nb[2]}", p1, coords[nb], rad * 0.24, m_bond)
                if b:
                    objs.append(b)

    _apply_parent_xform(objs, loc, scale)
    raw_anchors: dict[str, tuple[float, float, float]] = {
        "lattice_center": (0.0, 0.0, 0.0),
        "top_site": (0.0, 0.0, oz + (nz - 1) * sp + rad),
    }
    if dopants:
        dx, dy, dz = next(iter(dopants))
        raw_anchors["dopant_site"] = (ox + dx * sp, oy + dy * sp, oz + dz * sp)
    if vacancies:
        vx, vy, vz = next(iter(vacancies))
        raw_anchors["vacancy_site"] = (ox + vx * sp, oy + vy * sp, oz + vz * sp)
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


def make_sample_vial(
    prefix: str,
    loc=(0.0, 0.0, 0.0),
    scale=(1.0, 1.0, 1.0),
    palette: str = "nature-reviews",
    style: str = "illustration",
    engine: str = "CYCLES",
    opts: dict[str, Any] | None = None,
) -> tuple[list[Any], dict[str, tuple[float, float, float]]]:
    """电解液取样瓶 / ICP-OES 进样瓶（透明玻璃瓶身、半满液面与深色螺旋盖）。"""
    m_glass = SI.make_material(f"{prefix}_glass", SI.resolve_color("glass", palette), alpha=0.28, style=style, engine=engine, kind="glass")
    m_liq = SI.make_material(f"{prefix}_liq", SI.resolve_color("liquid", palette), alpha=0.52, style=style, engine=engine, kind="liquid")
    m_cap = SI.make_material(f"{prefix}_cap", SI.resolve_color("primary", palette), style=style, engine=engine)
    objs = [
        _make_cylinder(f"{prefix}_body", 0.42, 1.15, (0, 0, 0.575), m_glass, segments=40),
        _make_cylinder(f"{prefix}_neck", 0.26, 0.24, (0, 0, 1.25), m_glass, segments=32),
        _make_cylinder(f"{prefix}_liquid", 0.37, 0.64, (0, 0, 0.34), m_liq, segments=36),
        _make_cylinder(f"{prefix}_cap", 0.31, 0.26, (0, 0, 1.46), m_cap, segments=32),
    ]
    _apply_parent_xform(objs, loc, scale)
    raw_anchors = {
        "vial_body": (0.0, -0.42, 0.58),
        "liquid": (0.0, -0.37, 0.38),
        "cap": (0.0, 0.0, 1.56),
    }
    return objs, _offset_anchors(raw_anchors, loc, scale, prefix)


BUILDERS = {
    "three_electrode_cell": make_three_electrode_cell,
    "flow_cell": make_flow_cell,
    "vacuum_chamber": make_vacuum_chamber,
    "layered_stack": make_layered_stack,
    "electrode_interface": make_electrode_interface,
    "crystal_lattice": make_crystal_lattice,
    "sample_vial": make_sample_vial,
}
