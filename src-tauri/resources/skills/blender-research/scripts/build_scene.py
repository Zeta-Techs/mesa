#!/usr/bin/env python3
"""Build an explicitly specified schematic (single scene or multi-asset batch) in a NEW Blender background process.

支持两种渲染风格与两种组织形态：
- style: "illustration"（默认用于科研构件/传了 fig_width_mm 时：4 阶平涂漫反射 + 按栏宽换算的 Freestyle 描边 + 自动导出 .png.json 像素锚点）
  或 "cycles"（向后兼容旧版基础几何示意）。
- 单场景（objects）或多图复用批量资产（assets: [{name, objects, anchors, camera}, ...]），全部产物哈希、锚点文件与成图边缘裁切自检记入 blender-manifest.json。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import scene_illus as SI  # noqa: E402
import apparatus_kit as AK  # noqa: E402

BASIC_SHAPES = ("cube", "sphere", "cylinder")
ALL_SHAPES = BASIC_SHAPES + AK.SUPPORTED_KIT_SHAPES


def _validate_vec3(val: Any, label: str, positive: bool = False) -> None:
    if not isinstance(val, list) or len(val) != 3 or any(not isinstance(v, (float, int)) or not math.isfinite(v) for v in val):
        raise ValueError(f"Invalid {label}")
    if positive and any(v <= 0 for v in val):
        raise ValueError(f"{label} must be positive")


def _validate_objects(objects: Any, scope: str = "scene") -> None:
    if not isinstance(objects, list) or not 1 <= len(objects) <= 200:
        raise ValueError(f"{scope}: Expected 1..200 explicit objects")
    for obj in objects:
        if not isinstance(obj, dict):
            raise ValueError(f"{scope}: Object entry must be an object")
        if obj.get("shape") not in ALL_SHAPES:
            raise ValueError(f"{scope}: Unsupported primitive {obj.get('shape')!r}; allowed: {', '.join(ALL_SHAPES)}")
        _validate_vec3(obj.get("location", [0, 0, 0]) if obj.get("shape") in AK.SUPPORTED_KIT_SHAPES else obj.get("location"), "location")
        _validate_vec3(obj.get("scale", [1, 1, 1]) if obj.get("shape") in AK.SUPPORTED_KIT_SHAPES else obj.get("scale"), "scale", positive=True)


def _validate_anchors(anchors: Any, scope: str = "scene") -> None:
    if anchors is None:
        return
    if not isinstance(anchors, dict):
        raise ValueError(f"{scope}: anchors must be an object mapping name -> [x, y, z]")
    for k, v in anchors.items():
        if not isinstance(k, str) or not k.strip():
            raise ValueError(f"{scope}: anchor name must be non-empty string")
        _validate_vec3(v, f"{scope}.anchors.{k}")


def validate(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("Params JSON must be an object")
    if data.get("kind") != "schematic":
        raise ValueError("Only explicitly labeled schematic scenes supported")
    if data.get("units") not in ("METRIC", "IMPERIAL", "NONE"):
        raise ValueError("Declare units (or NONE for not-to-scale)")
    if not data.get("provenance") or not data.get("limitations"):
        raise ValueError("Source/provenance and limitations are required")
    style = data.get("style", "auto")
    if style not in ("auto", "illustration", "cycles"):
        raise ValueError("style must be 'auto', 'illustration', or 'cycles'")
    if "fig_width_mm" in data:
        fw = data["fig_width_mm"]
        if not isinstance(fw, (int, float)) or not math.isfinite(fw) or fw <= 0:
            raise ValueError("fig_width_mm must be a positive number")
    if "assets" in data:
        assets = data["assets"]
        if not isinstance(assets, list) or not 1 <= len(assets) <= 40:
            raise ValueError("Expected 1..40 explicit assets in batch mode")
        seen_names: set[str] = set()
        for asset in assets:
            if not isinstance(asset, dict):
                raise ValueError("Each asset entry must be an object")
            aname = str(asset.get("name") or "").strip()
            if not aname or any(c in aname for c in "/\\.. "):
                raise ValueError(f"Invalid asset name: {aname!r}")
            if aname in seen_names:
                raise ValueError(f"Duplicate asset name: {aname!r}")
            seen_names.add(aname)
            _validate_objects(asset.get("objects"), scope=f"asset:{aname}")
            _validate_anchors(asset.get("anchors"), scope=f"asset:{aname}")
    else:
        _validate_objects(data.get("objects"), scope="scene")
        _validate_anchors(data.get("anchors"), scope="scene")
    return data


def _resolve_style(data: dict[str, Any], objects: list[dict[str, Any]]) -> str:
    style = data.get("style", "auto")
    if style in ("illustration", "cycles"):
        return style
    if "fig_width_mm" in data or any(o.get("shape") in AK.SUPPORTED_KIT_SHAPES for o in objects):
        return "illustration"
    return "cycles"


def _render_single_unit(
    data: dict[str, Any],
    objects: list[dict[str, Any]],
    explicit_anchors: dict[str, list[float]] | None,
    camera_cfg: dict[str, Any] | None,
    out_png: Path,
    out_blend: Path,
    width_px: int,
    height_px: int,
) -> dict[str, Any]:
    import bpy
    from mathutils import Vector

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = data["units"]

    style = _resolve_style(data, objects)
    palette = str(data.get("palette") or "nature-reviews")
    fig_width_mm = float(data.get("fig_width_mm") or 183.0)
    line_pt = float(data.get("line_pt") or 0.55)
    transparent = bool(data.get("transparent", style == "illustration"))
    requested_engine = str(data.get("engine") or "auto")
    shadow_opacity = float(data.get("shadow_opacity", 0.18 if style == "illustration" else 0.0))

    if style == "illustration":
        engine = SI.setup_illustration_scene(
            scene,
            width_px=width_px,
            height_px=height_px,
            fig_width_mm=fig_width_mm,
            line_pt=line_pt,
            transparent=transparent,
            style="illustration",
            palette=palette,
            requested_engine=requested_engine,
        )
    else:
        engine = SI.choose_render_engine(scene, style="cycles", requested=requested_engine)
        scene.render.engine = engine
        if engine == "CYCLES":
            scene.cycles.samples = int(data.get("samples") or 16)
            scene.cycles.seed = 0
        scene.render.resolution_x = int(width_px)
        scene.render.resolution_y = int(height_px)
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.film_transparent = transparent
        bpy.ops.object.light_add(type="AREA", location=(3, -4, 7))
        light = bpy.context.object
        light.data.energy = 1200
        light.data.shape = "DISK"
        light.data.size = 5

    mesh_objs: list[Any] = []
    anchors_world: dict[str, tuple[float, float, float]] = {}

    for idx, item in enumerate(objects):
        shape = item["shape"]
        loc = tuple(float(v) for v in item.get("location", [0.0, 0.0, 0.0]))
        sc = tuple(float(v) for v in item.get("scale", [1.0, 1.0, 1.0]))
        name = str(item.get("name") or f"{shape}_{idx}")

        if shape in AK.BUILDERS:
            prefix = str(item.get("name") or "")
            built_objs, built_anchors = AK.BUILDERS[shape](
                prefix=prefix,
                loc=loc,
                scale=sc,
                palette=palette,
                style=style,
                engine=engine,
                opts=item.get("options") or {},
            )
            mesh_objs.extend(built_objs)
            anchors_world.update(built_anchors)
        else:
            if shape == "cube":
                bpy.ops.mesh.primitive_cube_add(size=1)
            elif shape == "sphere":
                bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5)
            else:
                bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1)
            obj = bpy.context.object
            obj.name = name
            obj.location = loc
            obj.scale = sc
            col = item.get("color")
            if col or style == "illustration":
                hex_c = SI.resolve_color(col, palette)
                mat = SI.make_material(f"mat_{name}", hex_c, alpha=float(item.get("alpha", 1.0)), style=style, engine=engine)
                obj.data.materials.append(mat)
            mesh_objs.append(obj)
            anchors_world[name] = loc

    if explicit_anchors:
        for k, v in explicit_anchors.items():
            anchors_world[str(k)] = (float(v[0]), float(v[1]), float(v[2]))

    cam_opt = camera_cfg or data.get("camera") or {}
    if style == "illustration" or cam_opt:
        cam = SI.frame_camera(
            scene,
            mesh_objs,
            azim_deg=float(cam_opt.get("azim_deg", -38.0)),
            elev_deg=float(cam_opt.get("elev_deg", 26.0)),
            ortho=bool(cam_opt.get("ortho", True)),
            margin=float(cam_opt.get("margin", 0.16)),
            distance=cam_opt.get("distance"),
        )
    else:
        bpy.ops.object.camera_add(location=(6, -8, 6))
        cam = bpy.context.object
        cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam

    scene.render.filepath = str(out_png)
    scene["mesa_kind"] = "schematic"
    scene["mesa_provenance"] = str(data["provenance"])
    scene["mesa_limitations"] = str(data["limitations"])
    scene["mesa_style"] = style

    floor = SI.add_contact_shadow_floor(scene, mesh_objs) if (style == "illustration" and shadow_opacity > 0) else None
    bpy.ops.wm.save_as_mainfile(filepath=str(out_blend))
    if style == "illustration":
        SI.render_with_contact_shadow(scene, cam, out_png, floor=floor, shadow_opacity=shadow_opacity)
    else:
        bpy.ops.render.render(write_still=True)

    if not out_blend.is_file() or not out_blend.stat().st_size:
        raise ValueError(f"Missing {out_blend.name}")
    if not out_png.is_file() or not out_png.stat().st_size:
        raise ValueError(f"Missing {out_png.name}")

    anchor_path, anchor_warnings = SI.project_anchors_to_sidecar(
        scene, cam, anchors_world, out_png, fig_width_mm=fig_width_mm
    )
    img_check = SI.check_render_image(out_png)
    all_warnings = list(anchor_warnings) + list(img_check.get("warnings") or [])

    return {
        "style": style,
        "engine": engine,
        "blend": out_blend,
        "png": out_png,
        "anchors_file": anchor_path,
        "anchor_count": len(anchors_world),
        "image_check": img_check,
        "warnings": all_warnings,
    }


def inside(params: Path, output: Path) -> None:
    import bpy

    data = validate(json.loads(params.read_text(encoding="utf-8")))
    res = data.get("resolution") or {}
    default_w = int(res.get("width", 1400 if data.get("style") == "illustration" or "fig_width_mm" in data else 800))
    default_h = int(res.get("height", 1000 if data.get("style") == "illustration" or "fig_width_mm" in data else 600))

    outputs: list[dict[str, Any]] = []
    warnings: list[str] = []
    units_report: list[dict[str, Any]] = []

    if "assets" in data:
        for asset in data["assets"]:
            aname = str(asset["name"]).strip()
            ares = asset.get("resolution") or {}
            w = int(ares.get("width", default_w))
            h = int(ares.get("height", default_h))
            info = _render_single_unit(
                data,
                asset["objects"],
                asset.get("anchors"),
                asset.get("camera"),
                output / f"{aname}.png",
                output / f"{aname}.blend",
                w,
                h,
            )
            for key in ("blend", "png", "anchors_file"):
                p = info[key]
                if p and p.is_file():
                    outputs.append({"path": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
            warnings.extend(f"[{aname}] {wmsg}" for wmsg in info["warnings"])
            units_report.append({
                "name": aname,
                "style": info["style"],
                "engine": info["engine"],
                "png": info["png"].name,
                "anchorsFile": info["anchors_file"].name if info["anchors_file"] else None,
                "anchorCount": info["anchor_count"],
                "imageCheck": info["image_check"],
            })
    else:
        info = _render_single_unit(
            data,
            data["objects"],
            data.get("anchors"),
            data.get("camera"),
            output / "schematic.png",
            output / "scene.blend",
            default_w,
            default_h,
        )
        for key in ("blend", "png", "anchors_file"):
            p = info[key]
            if p and p.is_file():
                outputs.append({"path": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
        warnings.extend(info["warnings"])
        units_report.append({
            "name": "schematic",
            "style": info["style"],
            "engine": info["engine"],
            "png": info["png"].name,
            "anchorsFile": info["anchors_file"].name if info["anchors_file"] else None,
            "anchorCount": info["anchor_count"],
            "imageCheck": info["image_check"],
        })

    manifest = {
        "status": "generated-awaiting-review",
        "blenderVersion": bpy.app.version_string,
        "kind": "schematic",
        "units": data["units"],
        "provenance": data["provenance"],
        "limitations": data["limitations"],
        "parametersHash": hashlib.sha256(params.read_bytes()).hexdigest(),
        "outputs": outputs,
        "unitsReport": units_report,
        "warnings": warnings,
    }
    (output / "blender-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--params", type=Path, required=True)
    p.add_argument("--output", type=Path)
    p.add_argument("--blender")
    p.add_argument("--validate", action="store_true")
    p.add_argument("--inside-blender", action="store_true")
    a = p.parse_args(args)
    try:
        validate(json.loads(a.params.read_text(encoding="utf-8")))
        if a.validate:
            print("Validated schematic parameters; no Blender execution")
            return 0
        if not a.output:
            p.error("--output required for rendering")
        if a.inside_blender:
            inside(a.params.resolve(), a.output.resolve())
            return 0
        binary = a.blender or shutil.which("blender")
        if not binary:
            raise ValueError("Provide --blender absolute executable path")
        if a.output.exists():
            raise ValueError("Output exists; refusing overwrite")
        a.output.mkdir(parents=True)
        command = [
            binary,
            "--background",
            "--factory-startup",
            "--offline-mode",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--inside-blender",
            "--params",
            str(a.params.resolve()),
            "--output",
            str(a.output.resolve()),
        ]
        with (a.output / "render.log").open("w", encoding="utf-8") as log:
            run = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        if run.returncode:
            raise ValueError("Blender failed; inspect render.log")
        manifest_path = a.output / "blender-manifest.json"
        if not manifest_path.is_file():
            raise ValueError("Missing render manifest")
        # Blender 内置 Python 通常不含 Pillow，这里在宿主进程用 Pillow 补做空图与边缘裁切自检并回写 manifest
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            changed = False
            for unit in manifest.get("unitsReport") or []:
                ic = unit.get("imageCheck") or {}
                if not ic.get("checked") and unit.get("png"):
                    res = SI.check_render_image(a.output / unit["png"])
                    if res.get("checked"):
                        unit["imageCheck"] = res
                        for wmsg in res.get("warnings") or []:
                            prefix = f"[{unit['name']}] " if len(manifest.get("unitsReport") or []) > 1 else ""
                            manifest.setdefault("warnings", []).append(prefix + wmsg)
                        changed = True
            if changed:
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
