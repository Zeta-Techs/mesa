#!/usr/bin/env python3
"""顶刊科研插画着色管线与像素锚点导出（blender-research 技能随包）。

核心设计（插画着色与随色描边思路参考 MIT 开源项目 lgwrightlab/schematic-figure）：
- HSL 冷暖色阶（暖亮 light、冷暗 dark / deep、同色系深 42% 轮廓线 line），通过相机空间法线点积 n·l + SmoothStep
  构建 3–4 阶平涂 Emission 着色器（金属叠加天空/地面反射分割，玻璃与液体用 LayerWeight(Facing) 呈现中心通透、边缘加厚），
  在 Cycles（CPU/GPU）下稳定输出锐利顶刊插画观感且关闭降噪器防糊线。
- Freestyle 双线宽随色描边：外轮廓（silhouette/border/contour/external_contour）按 fig_width_mm 换算为精确 outline_pt
  （默认 0.55 pt），内折痕与材质交界线为 0.55×；每条线通过 MATERIAL(LINE) 修饰器自动继承所在物体的专属深色描边。
- 独立扁平接触阴影通道（shadow_floor + holdout pass），将物体脚底单色浅灰阴影干净叠回主成图下方。
- 自动调用 world_to_camera_view 投影命名 3D 锚点为左上角原点 [0..1] 归一化像素坐标，写出 <png>.json 供 schematic-forge 直用。
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

PALETTES: dict[str, dict[str, str]] = {
    "nature-reviews": {
        "primary": "#1B4F72",
        "secondary": "#1F8A70",
        "accent": "#D35400",
        "neutral": "#B4BEC8",
        "glass": "#B8DCF0",
        "liquid": "#A9D6EE",
        "gold": "#D4AC0D",
        "dark": "#3A4654",
        "metal": "#AEB8C4",
        "ptfe": "#D8DCE0",
        "wire_we": "#D99B26",
        "wire_ce": "#1F8A70",
        "wire_re": "#C84B31",
        "line": "#222A32",
    },
    "chem-rev-mineral": {
        "primary": "#2C3E50",
        "secondary": "#148F77",
        "accent": "#D4AC0D",
        "neutral": "#BCC5CE",
        "glass": "#C2E6DE",
        "liquid": "#B6E2D8",
        "gold": "#B7950B",
        "dark": "#263342",
        "metal": "#AAB4BF",
        "ptfe": "#D8DCE0",
        "wire_we": "#D4AC0D",
        "wire_ce": "#148F77",
        "wire_re": "#B03A2E",
        "line": "#1E252B",
    },
    "science-clean": {
        "primary": "#215A8A",
        "secondary": "#2E8B6E",
        "accent": "#C95232",
        "neutral": "#C0C9D2",
        "glass": "#C4E2F5",
        "liquid": "#B0D9F0",
        "gold": "#D99B26",
        "dark": "#2C3540",
        "metal": "#B2BCC6",
        "ptfe": "#DCE0E5",
        "wire_we": "#D99B26",
        "wire_ce": "#2E8B6E",
        "wire_re": "#C95232",
        "line": "#20262C",
    },
}


def _s2l(v: float) -> float:
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return min(hi, max(lo, v))


def _hex_to_srgb(hex_str: str) -> tuple[float, float, float]:
    s = hex_str.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return (0.6, 0.65, 0.7)
    return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)


def hex_to_rgba(hex_str: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """把 #RRGGBB 转为线性空间 RGBA（供 Blender 节点使用）。"""
    r, g, b = _hex_to_srgb(hex_str)
    return (_s2l(r), _s2l(g), _s2l(b), _clamp(float(alpha)))


def _rgb_hsl(r: float, g: float, b: float) -> tuple[float, float, float]:
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2.0
    h = s = 0.0
    if mx != mn:
        d = mx - mn
        s = d / (2.0 - mx - mn) if l > 0.5 else d / (mx + mn)
        if mx == r:
            h = 60.0 * ((g - b) / d + (6.0 if g < b else 0.0))
        elif mx == g:
            h = 60.0 * ((b - r) / d + 2.0)
        else:
            h = 60.0 * ((r - g) / d + 4.0)
    return h, s, l


def _hsl_rgb(h: float, s: float, l: float) -> tuple[float, float, float]:
    h = h % 360.0
    s = _clamp(s)
    l = _clamp(l)
    a = s * min(l, 1.0 - l)

    def f(n: float) -> float:
        k = (n + h / 30.0) % 12.0
        return l - a * max(-1.0, min(k - 3.0, 9.0 - k, 1.0))

    return (f(0), f(8), f(4))


def _toward(h: float, target: float, amt: float) -> float:
    d = ((target - h + 540.0) % 360.0) - 180.0
    return h + math.copysign(min(abs(d), amt), d)


def tone_rgba(hex_str: str, role: str, contrast: float = 1.0, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """从主色派生顶刊插画冷暖色阶（线性 RGBA）：light / glow / dark / deep / line。"""
    params = {
        "light": (50.0, 7.0 * contrast, 1.0 - 0.10 * contrast, 0.50 * contrast, 0.16 * contrast, 0.0, 0.0),
        "glow": (50.0, 7.0 * contrast, 0.60, 0.75, 1.0, 0.0, 0.0),
        "dark": (235.0, 10.0 * contrast, 1.0 + 0.12 * contrast, 0.0, 0.0, 0.24 * contrast, 0.16 * contrast),
        "deep": (235.0, 10.0 * contrast, 1.0 + 0.20 * contrast, 0.0, 0.0, 0.40 * contrast, 0.28 * contrast),
        "line": (235.0, 8.0, 1.15, 0.0, 0.0, 0.44, 1.0),
    }
    if role == "base" or role not in params:
        return hex_to_rgba(hex_str, alpha)
    r, g, b = _hex_to_srgb(hex_str)
    h, s, l = _rgb_hsl(r, g, b)
    hs = min(1.0, 3.0 * s)
    chroma = s * (1.0 - abs(2.0 * l - 1.0))
    tgt, amt, k, uf, um, df, dm = params[role]
    ll = _clamp(l + min(uf * (1.0 - l), um) - min(df * l, dm))
    room = 1.0 - abs(2.0 * ll - 1.0)
    ss = min(1.0, chroma * k / room) if room > 1e-6 else 0.0
    sr, sg, sb = _hsl_rgb(_toward(h, tgt, amt * hs), ss, ll)
    return (_s2l(sr), _s2l(sg), _s2l(sb), _clamp(float(alpha)))


def compute_freestyle_px(width_px: int, fig_width_mm: float = 183.0, line_pt: float = 0.55) -> float:
    """按目标印刷栏宽（mm）把线宽（pt）换算为渲染像素宽（1 pt = 0.352778 mm）。"""
    if width_px <= 0 or fig_width_mm <= 0 or line_pt <= 0:
        return 1.2
    px = (line_pt * 0.352778 / fig_width_mm) * width_px
    return round(max(0.7, min(12.0, px)), 2)


def resolve_color(color_spec: str | None, palette: str = "nature-reviews", fallback: str = "primary") -> str:
    pal = PALETTES.get(palette) or PALETTES["nature-reviews"]
    if not color_spec:
        return pal.get(fallback, "#1B4F72")
    if color_spec.startswith("#"):
        return color_spec
    return pal.get(color_spec, pal.get(fallback, "#1B4F72"))


def check_render_image(png_path: Path) -> dict[str, Any]:
    """检查渲染成图是否为空图或主体紧贴画幅边缘被裁切（仅依赖 Pillow，无则跳过）。"""
    if not png_path.is_file():
        return {"checked": False, "warnings": ["missing_render_png"]}
    try:
        from PIL import Image
    except ImportError:
        return {"checked": False, "warnings": []}

    with Image.open(png_path) as im:
        rgba = im.convert("RGBA")
        w, h = rgba.size
        if w <= 0 or h <= 0:
            return {"checked": True, "warnings": ["empty_render"]}
        pixels = list(rgba.get_flattened_data() if hasattr(rgba, "get_flattened_data") else rgba.getdata())

    has_alpha = any(a < 250 for _, _, _, a in pixels)

    def _is_fg(px: tuple[int, int, int, int]) -> bool:
        r, g, b, a = px
        if has_alpha:
            return a > 20
        return (r < 248) or (g < 248) or (b < 248)

    fg_count = 0
    min_x, min_y, max_x, max_y = w, h, -1, -1
    margin_x = max(1, int(w * 0.015))
    margin_y = max(1, int(h * 0.015))
    edge_hits = {"left": 0, "right": 0, "top": 0, "bottom": 0}
    edge_totals = {
        "left": margin_x * h,
        "right": margin_x * h,
        "top": margin_y * w,
        "bottom": margin_y * w,
    }

    for idx, px in enumerate(pixels):
        if not _is_fg(px):
            continue
        fg_count += 1
        x = idx % w
        y = idx // w
        if x < min_x:
            min_x = x
        if x > max_x:
            max_x = x
        if y < min_y:
            min_y = y
        if y > max_y:
            max_y = y
        if x < margin_x:
            edge_hits["left"] += 1
        if x >= w - margin_x:
            edge_hits["right"] += 1
        if y < margin_y:
            edge_hits["top"] += 1
        if y >= h - margin_y:
            edge_hits["bottom"] += 1

    warnings: list[str] = []
    fg_ratio = fg_count / max(1, w * h)
    if fg_ratio < 0.002:
        warnings.append("empty_render: 渲染图像几乎全空（有效主体占比 < 0.2%），请检查相机朝向、灯光或物体可见性")
        return {"checked": True, "image_size": [w, h], "fg_ratio": round(fg_ratio, 4), "warnings": warnings}

    clipped_sides = [
        side for side, hits in edge_hits.items()
        if hits / max(1, edge_totals[side]) > 0.08
    ]
    if clipped_sides:
        warnings.append(
            f"edge_clipped({','.join(clipped_sides)}): 主体紧贴画幅边缘疑似被裁切，请增大 camera margin 或拉远镜头"
        )
    bbox_cov = ((max_x - min_x + 1) * (max_y - min_y + 1)) / max(1, w * h)
    return {
        "checked": True,
        "image_size": [w, h],
        "fg_ratio": round(fg_ratio, 4),
        "bbox_coverage": round(bbox_cov, 4),
        "bbox_norm": [
            round(min_x / w, 4),
            round(min_y / h, 4),
            round((max_x + 1) / w, 4),
            round((max_y + 1) / h, 4),
        ],
        "warnings": warnings,
    }


def write_anchor_sidecar(
    out_png: Path,
    anchors: dict[str, list[float]],
    image_size: tuple[int, int],
    fig_width_mm: float = 183.0,
    warnings: list[str] | None = None,
) -> Path:
    """写出 <out_png>.json 伴生锚点文件，schematic-forge 的 hero_panel 可直接自动读取。"""
    payload = {
        "schema": "mesa-blender-anchors-v1",
        "image": out_png.name,
        "image_size": [int(image_size[0]), int(image_size[1])],
        "fig_width_mm": float(fig_width_mm),
        "anchors": {k: [round(float(v[0]), 4), round(float(v[1]), 4)] for k, v in anchors.items()},
        "warnings": list(warnings or []),
    }
    sidecar = Path(str(out_png) + ".json")
    sidecar.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return sidecar


# ---------------- 以下函数在 Blender 进程内调用 ----------------


def choose_render_engine(scene: Any, style: str = "illustration", requested: str = "auto") -> str:
    """选择渲染引擎：相机空间平涂插画管线在 CYCLES 下最稳定（支持精确接触阴影与无噪点透明玻璃）。"""
    target = "CYCLES" if requested == "auto" else requested
    try:
        scene.render.engine = target
        return scene.render.engine
    except TypeError:
        avail = [item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items]
        for cand in ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            if cand in avail:
                scene.render.engine = cand
                return cand
        return scene.render.engine


def _camera_light_vecs(azim_deg: float = -135.0, elev_deg: float = 30.0):
    from mathutils import Vector

    a, e = math.radians(azim_deg), math.radians(elev_deg)
    lc = Vector((math.cos(e) * math.cos(a), -math.cos(e) * math.sin(a), -math.sin(e))).normalized()
    hc = (lc + Vector((0.0, 0.0, -1.0))).normalized()
    return lc, hc


def make_material(
    name: str,
    hex_color: str,
    alpha: float = 1.0,
    style: str = "illustration",
    engine: str = "CYCLES",
    kind: str = "opaque",
) -> Any:
    """创建顶刊插画材质（相机空间 4 阶平涂 Emission + 随色 line_color）或哑光 Cycles 材质。

    kind: "opaque" | "metal" | "glass" | "liquid" | "emit"
    """
    import bpy

    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (640, 0)

    if kind == "opaque" and alpha < 0.96:
        kind = "glass" if alpha <= 0.48 else "liquid"

    contrast = 1.32 if kind == "metal" else 1.0
    base_c = tone_rgba(hex_color, "base", contrast)
    light_c = tone_rgba(hex_color, "light", contrast)
    glow_c = tone_rgba(hex_color, "glow", contrast)
    dark_c = tone_rgba(hex_color, "dark", contrast)
    deep_c = tone_rgba(hex_color, "deep", contrast)
    line_c = tone_rgba(hex_color, "line", contrast)
    mat.line_color = line_c

    if style != "illustration":
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.inputs["Base Color"].default_value = base_c
        bsdf.inputs["Roughness"].default_value = 0.25 if alpha < 0.99 else 0.78
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.85 if kind == "metal" else 0.0
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = _clamp(alpha)
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        return mat

    # 仅主相机射线看平涂色，非相机射线看黑漫反射，防止发亮物体照亮接触阴影底板
    lp = nt.nodes.new("ShaderNodeLightPath")
    black = nt.nodes.new("ShaderNodeBsdfDiffuse")
    black.inputs[0].default_value = (0.0, 0.0, 0.0, 1.0)

    def _math(op: str, a: Any, b: Any = 0.0, clamp: bool = False):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        if isinstance(a, bpy.types.NodeSocket):
            nt.links.new(a, n.inputs[0])
        else:
            n.inputs[0].default_value = a
        if isinstance(b, bpy.types.NodeSocket):
            nt.links.new(b, n.inputs[1])
        else:
            n.inputs[1].default_value = b
        return n.outputs[0]

    def _smooth(val: Any, lo: float, hi: float):
        n = nt.nodes.new("ShaderNodeMapRange")
        n.interpolation_type = "SMOOTHSTEP"
        n.clamp = True
        nt.links.new(val, n.inputs[0])
        n.inputs[1].default_value = lo
        n.inputs[2].default_value = hi
        n.inputs[3].default_value = 0.0
        n.inputs[4].default_value = 1.0
        return n.outputs[0]

    def _mix_col(fac: Any, a: Any, b: Any):
        n = nt.nodes.new("ShaderNodeMix")
        n.data_type = "RGBA"
        n.clamp_factor = True
        if isinstance(fac, bpy.types.NodeSocket):
            nt.links.new(fac, n.inputs[0])
        else:
            n.inputs[0].default_value = fac
        if isinstance(a, bpy.types.NodeSocket):
            nt.links.new(a, n.inputs[6])
        else:
            n.inputs[6].default_value = a
        if isinstance(b, bpy.types.NodeSocket):
            nt.links.new(b, n.inputs[7])
        else:
            n.inputs[7].default_value = b
        return n.outputs[2]

    def _mix_sh(fac: Any, a: Any, b: Any):
        n = nt.nodes.new("ShaderNodeMixShader")
        if isinstance(fac, bpy.types.NodeSocket):
            nt.links.new(fac, n.inputs[0])
        else:
            n.inputs[0].default_value = fac
        nt.links.new(a, n.inputs[1])
        nt.links.new(b, n.inputs[2])
        return n.outputs[0]

    if kind == "emit":
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs[0].default_value = base_c
        em.inputs[1].default_value = 1.0
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        return mat

    if kind in ("glass", "liquid"):
        # 中心通透、边缘加厚着色的顶刊玻璃/电解液表现
        face_op = 0.14 if kind == "glass" else max(0.32, min(0.58, alpha))
        edge_op = 0.62 if kind == "glass" else min(0.84, face_op + 0.30)
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.inputs[0].default_value = 0.32
        f_pow = _math("POWER", lw.outputs["Facing"], 1.5, clamp=True)
        op_fac = _math("ADD", _math("MULTIPLY", f_pow, edge_op - face_op), face_op, clamp=True)
        tint_col = _mix_col(f_pow, light_c, dark_c)
        em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(tint_col, em.inputs[0])
        em.inputs[1].default_value = 1.0
        tr1 = nt.nodes.new("ShaderNodeBsdfTransparent")
        tr2 = nt.nodes.new("ShaderNodeBsdfTransparent")
        cam_sh = _mix_sh(op_fac, tr1.outputs[0], em.outputs[0])
        oth_sh = _mix_sh(op_fac, tr2.outputs[0], black.outputs[0])
        final = _mix_sh(lp.outputs["Is Camera Ray"], oth_sh, cam_sh)
        nt.links.new(final, out.inputs["Surface"])
        mat["mesa_tint"] = 1
        return mat

    # 不透明与金属：相机空间法线点积 n·l + 4 阶平涂色阶（含柔和 AO 凹缝暗部与小高光）
    lc, hc = _camera_light_vecs(-135.0, 30.0)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    vt = nt.nodes.new("ShaderNodeVectorTransform")
    vt.vector_type = "NORMAL"
    vt.convert_from = "WORLD"
    vt.convert_to = "CAMERA"
    nt.links.new(geo.outputs["Normal"], vt.inputs[0])

    flip = _math("SUBTRACT", 1.0, _math("MULTIPLY", geo.outputs["Backfacing"], 2.0))
    nsc = nt.nodes.new("ShaderNodeVectorMath")
    nsc.operation = "SCALE"
    nt.links.new(vt.outputs[0], nsc.inputs[0])
    nt.links.new(flip, nsc.inputs["Scale"])

    dl = nt.nodes.new("ShaderNodeVectorMath")
    dl.operation = "DOT_PRODUCT"
    nt.links.new(nsc.outputs[0], dl.inputs[0])
    dl.inputs[1].default_value = tuple(lc)
    d_val = dl.outputs["Value"]

    w = 0.06
    shade = _mix_col(_smooth(d_val, -0.10 - w, -0.10 + w), dark_c, base_c)
    if kind == "metal":
        # 顶刊插画金属：天空/地面水平反射分割，干净无斑马纹
        iv = nt.nodes.new("ShaderNodeVectorTransform")
        iv.vector_type = "VECTOR"
        iv.convert_from = "WORLD"
        iv.convert_to = "CAMERA"
        nt.links.new(geo.outputs["Incoming"], iv.inputs[0])
        rf = nt.nodes.new("ShaderNodeVectorMath")
        rf.operation = "REFLECT"
        nt.links.new(iv.outputs[0], rf.inputs[0])
        nt.links.new(nsc.outputs[0], rf.inputs[1])
        ry = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(rf.outputs[0], ry.inputs[0])
        sky = _smooth(_math("MULTIPLY", ry.outputs["Y"], -1.0), -0.12 - w, -0.12 + w)
        ground_band = _mix_col(_smooth(d_val, -0.10 - w, -0.10 + w), deep_c, dark_c)
        shade = _mix_col(sky, ground_band, shade)

    # 4 阶色带：深暗影 + 暗面 + 主色 + 暖亮面
    shade = _mix_col(_smooth(d_val, -0.55 - w, -0.55 + w), deep_c, shade)
    shade = _mix_col(_smooth(d_val, 0.80 - w, 0.80 + w), shade, light_c)

    # 凹缝轻度 AO 加深
    aon = nt.nodes.new("ShaderNodeAmbientOcclusion")
    aon.samples = 6
    aon.inputs["Distance"].default_value = 0.25
    ao_k = _math("MULTIPLY", _math("SUBTRACT", 1.0, _smooth(aon.outputs["AO"], 0.2, 0.72)), 0.26)
    shade = _mix_col(ao_k, shade, deep_c)

    # 金属加一小块干净高光点
    if kind == "metal":
        dh = nt.nodes.new("ShaderNodeVectorMath")
        dh.operation = "DOT_PRODUCT"
        nt.links.new(nsc.outputs[0], dh.inputs[0])
        dh.inputs[1].default_value = tuple(hc)
        hl_fac = _math("MULTIPLY", _smooth(dh.outputs["Value"], 0.962, 0.972), 0.50)
        shade = _mix_col(hl_fac, shade, glow_c)

    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(shade, em.inputs[0])
    em.inputs[1].default_value = 1.0
    final = _mix_sh(lp.outputs["Is Camera Ray"], black.outputs[0], em.outputs[0])
    nt.links.new(final, out.inputs["Surface"])
    return mat


def setup_illustration_scene(
    scene: Any,
    width_px: int = 1600,
    height_px: int = 1000,
    fig_width_mm: float = 183.0,
    line_pt: float = 0.55,
    transparent: bool = True,
    style: str = "illustration",
    palette: str = "nature-reviews",
    requested_engine: str = "auto",
) -> str:
    """配置顶刊插画渲染参数、Standard 色彩管理、关闭降噪器保锐利与随色双线宽 Freestyle。"""
    import bpy

    engine = choose_render_engine(scene, style=style, requested=requested_engine)
    scene.render.engine = engine
    scene.render.resolution_x = int(width_px)
    scene.render.resolution_y = int(height_px)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    scene.render.film_transparent = bool(transparent)
    scene.render.filter_size = 1.0

    # Standard 色彩空间保证顶刊纯色不被 Filmic / AgX 洗灰
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0
        scene.view_settings.gamma = 1.0
    except Exception:
        pass

    if engine == "CYCLES":
        scene.cycles.samples = 32 if style == "illustration" else 24
        scene.cycles.seed = 0
        scene.cycles.use_denoising = False if style == "illustration" else True
        scene.cycles.max_bounces = 4
        scene.cycles.diffuse_bounces = 1
        scene.cycles.glossy_bounces = 0
        scene.cycles.transmission_bounces = 0
        scene.cycles.volume_bounces = 0
        scene.cycles.transparent_max_bounces = max(getattr(scene.cycles, "transparent_max_bounces", 8), 24)

    # 纯净零能量世界背景（平涂 Emission 材质自驱动，绝不引入 ShaderNodeTexWave 斑马纹）
    if not scene.world:
        scene.world = bpy.data.worlds.new("MesaWorld")
    scene.world.use_nodes = True
    w_nt = scene.world.node_tree
    w_nt.nodes.clear()
    bg = w_nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs["Strength"].default_value = 0.0 if style == "illustration" else 0.45
    w_out = w_nt.nodes.new("ShaderNodeOutputWorld")
    w_nt.links.new(bg.outputs["Background"], w_out.inputs["Surface"])

    # 双线宽随色 Freestyle 描边：外轮廓 1.0×、内折痕与材质交界 0.55×，自动继承材质 line_color
    if style == "illustration":
        scene.render.use_freestyle = True
        scene.render.line_thickness_mode = "ABSOLUTE"
        scene.render.line_thickness = 1.0
        outer_px = compute_freestyle_px(width_px, fig_width_mm, line_pt)
        inner_px = max(0.6, round(outer_px * 0.55, 2))
        for vl in scene.view_layers:
            vl.use_freestyle = True
            fs = vl.freestyle_settings
            fs.mode = "EDITOR"
            fs.use_smoothness = True
            fs.crease_angle = math.radians(138)
            for ls in list(fs.linesets):
                fs.linesets.remove(ls)
            for nm, thick, edge_types in (
                ("MesaOuter", outer_px, ("silhouette", "border", "contour", "external_contour")),
                ("MesaInner", inner_px, ("crease", "material_boundary")),
            ):
                ls = fs.linesets.new(nm)
                ls.select_by_visibility = True
                ls.visibility = "VISIBLE"
                ls.select_by_edge_types = True
                ls.edge_type_combination = "OR"
                for t in (
                    "silhouette", "border", "contour", "external_contour",
                    "crease", "material_boundary", "ridge_valley", "suggestive_contour", "edge_mark",
                ):
                    setattr(ls, "select_" + t, t in edge_types)
                sty = bpy.data.linestyles.new(nm)
                ls.linestyle = sty
                sty.color = (0.12, 0.14, 0.16)
                sty.thickness = thick
                sty.thickness_position = "CENTER"
                sty.caps = "ROUND"
                sty.use_chaining = True
                sty.chaining = "PLAIN"
                sty.use_same_object = True
                cm = sty.color_modifiers.new("mat", "MATERIAL")
                cm.material_attribute = "LINE"
                cm.blend = "MIX"
                cm.influence = 1.0

    return engine


def add_contact_shadow_floor(scene: Any, mesh_objects: list[Any]):
    """在场景所有主体最低点下方放置隐形阴影接收地板，供扁平接触阴影通道使用。"""
    import bpy
    from mathutils import Vector

    min_z = 0.0
    zs = []
    for obj in mesh_objects:
        if obj.type not in ("MESH", "CURVE"):
            continue
        for c in obj.bound_box:
            zs.append((obj.matrix_world @ Vector(c)).z)
    if zs:
        min_z = min(zs) - 0.005

    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0.0, 0.0, min_z))
    floor = bpy.context.object
    floor.name = "MesaShadowFloor"
    floor.is_shadow_catcher = True
    mat = bpy.data.materials.new("MesaShadowCatcher")
    mat.use_nodes = True
    mat["mesa_catcher"] = 1
    floor.data.materials.append(mat)
    floor.hide_render = True
    return floor


def render_with_contact_shadow(
    scene: Any,
    camera: Any,
    out_png: Path,
    floor: Any = None,
    shadow_opacity: float = 0.18,
) -> None:
    """先渲主体图，再跑一次极速独立扁平接触阴影通道叠在底部（纯 Cycles + NumPy，零外部依赖）。"""
    import bpy
    from mathutils import Vector

    scene.render.filepath = str(out_png)
    bpy.ops.render.render(write_still=True)

    if floor is None or shadow_opacity <= 0 or scene.render.engine != "CYCLES":
        return

    try:
        import numpy as np
    except ImportError:
        return

    # 构造近垂直偏右下的定向太阳光，只给阴影通道出干净脚底投影
    m3 = camera.matrix_world.to_3x3()
    right = m3 @ Vector((1, 0, 0))
    right.z = 0
    fwd = m3 @ Vector((0, 0, -1))
    fwd.z = 0
    sun_dir = Vector((0, 0, -1)) + 0.14 * (right.normalized() if right.length else Vector()) + 0.06 * (fwd.normalized() if fwd.length else Vector())
    sun_data = bpy.data.lights.new("MesaContactSun", type="SUN")
    sun_data.energy = 3.0
    sun_data.angle = math.radians(1.5)
    sun_obj = bpy.data.objects.new("MesaContactSun", sun_data)
    sun_obj.location = (0, 0, 12)
    sun_obj.rotation_euler = sun_dir.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(sun_obj)

    saved = []
    for m in bpy.data.materials:
        if not m.use_nodes or not m.node_tree or m.get("mesa_catcher"):
            continue
        out = m.node_tree.get_output_node("CYCLES")
        if out is None:
            continue
        src = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].is_linked else None
        saved.append((m, src))
        ho = m.node_tree.nodes.new("ShaderNodeHoldout")
        m.node_tree.links.new(ho.outputs[0], out.inputs["Surface"])

    shadow_path = out_png.with_suffix(".shadow_tmp.png")
    fs0 = scene.render.use_freestyle
    s0 = scene.cycles.samples
    try:
        scene.render.use_freestyle = False
        scene.cycles.samples = 16
        floor.hide_render = False
        scene.render.filepath = str(shadow_path)
        bpy.ops.render.render(write_still=True)
    finally:
        scene.render.use_freestyle = fs0
        scene.cycles.samples = s0
        floor.hide_render = True
        scene.render.filepath = str(out_png)
        bpy.data.objects.remove(sun_obj, do_unlink=True)
        for m, src in saved:
            out = m.node_tree.get_output_node("CYCLES")
            for lnk in list(out.inputs["Surface"].links):
                m.node_tree.links.remove(lnk)
            if src is not None:
                m.node_tree.links.new(src, out.inputs["Surface"])

    if not shadow_path.is_file():
        return
    try:
        def _load(p: Path):
            img = bpy.data.images.load(str(p), check_existing=False)
            w, h = img.size
            arr = np.empty(w * h * 4, np.float32)
            img.pixels.foreach_get(arr)
            bpy.data.images.remove(img)
            return arr.reshape(h, w, 4), (w, h)

        main_arr, (w, h) = _load(out_png)
        sh_arr, _ = _load(shadow_path)
        frgb, fa = main_arr[..., :3], main_arr[..., 3:4]
        sa = np.clip(sh_arr[..., 3:4], 0.0, 1.0) * float(shadow_opacity)
        brgb = np.broadcast_to(np.array((0.16, 0.19, 0.24), np.float32), frgb.shape)
        oa = fa + sa * (1.0 - fa)
        orgb = np.where(oa > 1e-6, (frgb * fa + brgb * sa * (1.0 - fa)) / np.maximum(oa, 1e-6), 0.0)
        merged = np.concatenate([orgb, oa], axis=2).astype(np.float32).ravel()
        out_img = bpy.data.images.new("MesaMerged", w, h, alpha=True)
        out_img.pixels.foreach_set(merged)
        out_img.filepath_raw = str(out_png)
        out_img.file_format = "PNG"
        out_img.save()
        bpy.data.images.remove(out_img)
    finally:
        try:
            os.remove(shadow_path)
        except OSError:
            pass


def frame_camera(
    scene: Any,
    mesh_objects: list[Any],
    azim_deg: float = -35.0,
    elev_deg: float = 24.0,
    ortho: bool = True,
    margin: float = 0.16,
    distance: float | None = None,
) -> Any:
    """按场景物体包围盒自动计算安全焦距/正交视野并留白，杜绝裁边。"""
    import bpy
    from mathutils import Vector

    corners: list[Any] = []
    for obj in mesh_objects:
        if obj.type not in ("MESH", "CURVE") or getattr(obj, "is_shadow_catcher", False):
            continue
        for c in obj.bound_box:
            corners.append(obj.matrix_world @ Vector(c))

    if corners:
        xs = [v.x for v in corners]
        ys = [v.y for v in corners]
        zs = [v.z for v in corners]
        center = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2))
        radius = max(0.5, max((v - center).length for v in corners))
    else:
        center = Vector((0.0, 0.0, 0.0))
        radius = 2.0

    az = math.radians(azim_deg)
    el = math.radians(elev_deg)
    dist = distance if (distance and distance > 0) else max(5.0, radius * 4.2)
    cam_pos = center + Vector((
        dist * math.cos(el) * math.sin(az),
        -dist * math.cos(el) * math.cos(az),
        dist * math.sin(el),
    ))

    cam_data = bpy.data.cameras.new("MesaCamera")
    cam_obj = bpy.data.objects.new("MesaCamera", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = cam_pos
    cam_obj.rotation_euler = (center - cam_pos).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam_obj

    bpy.context.view_layer.update()
    aspect = scene.render.resolution_x / max(1, scene.render.resolution_y)

    if ortho:
        cam_data.type = "ORTHO"
        inv_mat = cam_obj.matrix_world.inverted()
        if corners:
            cam_pts = [inv_mat @ v for v in corners]
            span_x = max(p.x for p in cam_pts) - min(p.x for p in cam_pts)
            span_y = max(p.y for p in cam_pts) - min(p.y for p in cam_pts)
            need_w = max(span_x, span_y * aspect) * (1.0 + 2.0 * margin)
            cam_data.ortho_scale = max(1.0, need_w)
        else:
            cam_data.ortho_scale = radius * 2.4
    else:
        cam_data.type = "PERSP"
        cam_data.lens = 50.0
    return cam_obj


def project_anchors_to_sidecar(
    scene: Any,
    camera: Any,
    anchor_world_map: dict[str, tuple[float, float, float]],
    out_png: Path,
    fig_width_mm: float = 183.0,
) -> tuple[Path | None, list[str]]:
    """将 3D 世界坐标锚点投影到相机 2D 归一化坐标（左上角原点 [0..1]）并写出 <out_png>.json。"""
    if not anchor_world_map:
        return None, []
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    projected: dict[str, list[float]] = {}
    warnings: list[str] = []
    for name, pos in anchor_world_map.items():
        co = world_to_camera_view(scene, camera, Vector(pos))
        nx = float(co.x)
        ny = 1.0 - float(co.y)
        projected[name] = [round(nx, 4), round(ny, 4)]
        if co.z < 0 or nx < 0.0 or nx > 1.0 or ny < 0.0 or ny > 1.0:
            warnings.append(f"anchor '{name}' 投影越界 ({nx:.3f}, {ny:.3f}, z={co.z:.2f})")
    sidecar = write_anchor_sidecar(
        out_png,
        projected,
        (scene.render.resolution_x, scene.render.resolution_y),
        fig_width_mm=fig_width_mm,
        warnings=warnings,
    )
    return sidecar, warnings
