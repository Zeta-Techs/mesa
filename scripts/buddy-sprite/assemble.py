"""各行切帧 → 统一尺寸与基线 → 一张精灵图 + 联系表（浅底 / 深底各一张 jpg）。
用法：python3 -I assemble.py <动作条目录> <out.webp> [行名=缩放倍率 ...]
动作条目录里每行一张 <行名>.png（见 ROWS），出图模型给的透明底或青色 #00FFFF 底都行。
行表改了要同步 src/buddy-sprite.ts。"""
import json, sys
from pathlib import Path
from PIL import Image, ImageFilter
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from extract import extract

CELL = 224; BASE = 214; STAND_H = 168
ROWS = [  # 行名, 帧数, 每帧毫秒
    ("idle", 6, [280, 110, 110, 140, 140, 320]),
    ("waving", 4, [140, 140, 140, 280]),
    ("running", 6, [120] * 5 + [220]),
    ("jumping", 5, [140] * 4 + [280]),
    ("failed", 8, [140] * 7 + [240]),
    ("sleep", 6, [420, 380, 380, 380, 380, 520]),
    ("idle-coffee", 6, [280, 110, 110, 140, 140, 320]),
    ("idle-lamp", 6, [280, 110, 110, 140, 140, 320]),
    # 桌宠用（2026-11-09）：等你回、被拖着往右 / 往左走（左走由右走镜像，不另出）
    ("waiting", 6, [150] * 5 + [260]),
    ("walk-right", 8, [120] * 7 + [220]),
    ("walk-left", 8, [120] * 7 + [220]),
]
MIRROR = {"walk-left": "walk-right"}
# 同一行内换帧（不跨代拼）：2026-11-09 那一版 idle 第 3 帧眯眼像不高兴，换成第 1 帧；重孵后按联系表重定
SWAP = {"idle": {2: 0}}
# 跳起的高度压一点，峰值不出格
LIFT = {"jumping": 0.72}
run = Path(sys.argv[1]); out = Path(sys.argv[2])
mult = {k: float(v) for k, v in (a.split("=") for a in sys.argv[3:])}
sheet = Image.new("RGBA", (CELL * 8, CELL * len(ROWS)), (0, 0, 0, 0))
done = {}
meta = []; problems = []
for r, (name, n, dur) in enumerate(ROWS):
    if name in MIRROR:
        src = done[MIRROR[name]]
        for i in range(n):
            cell = sheet.crop((i * CELL, src * CELL, (i + 1) * CELL, (src + 1) * CELL)).transpose(Image.FLIP_LEFT_RIGHT)
            sheet.alpha_composite(cell, (i * CELL, r * CELL))
        meta.append(dict(row=r, name=name, frames=n, durations=dur, mirror_of=MIRROR[name])); continue
    done[name] = r
    p = run / f"{name}.png"
    if not p.exists():
        problems.append(f"{name}: 没有图"); meta.append(None); continue
    frames, err = extract(p, n)
    if err:
        problems.append(f"{name}: {err}"); meta.append(None); continue
    s = STAND_H / float(np.median([f["h"] for f in frames])) * mult.get(name, 1.0)
    if name == "idle":
        IDLE_W = float(np.median([f["w"] for f in frames])) * s
    if name in ("idle-coffee", "idle-lamp"):   # 桌上多了东西，按宽对齐 idle，别让人变小
        s = IDLE_W / float(np.median([f["w"] for f in frames]))
    bottom = max(f["bottom"] for f in frames)
    for i, j in SWAP.get(name, {}).items():
        frames[i] = frames[j]
    for i, f in enumerate(frames):
        im = f["img"].resize((max(1, round(f["w"] * s)), max(1, round(f["h"] * s))), Image.LANCZOS)
        dx = round(CELL / 2 - f["ax"] * s)
        dy = round(BASE - f["h"] * s - (bottom - f["bottom"]) * s * LIFT.get(name, 1.0))
        cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        cell.alpha_composite(im, (max(-im.width, dx), max(-im.height, dy)))
        # 贴纸白边：深色底上墨线、脚、z 不再隐进背景；浅色底上几乎看不出
        ring = cell.getchannel("A").point(lambda v: 255 if v > 90 else 0).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(0.6))
        border = Image.new("RGBA", cell.size, (250, 246, 236, 0)); border.putalpha(ring)
        border.alpha_composite(cell)
        sheet.alpha_composite(border, (i * CELL, r * CELL))
        if dy < 0 or dx < 0 or dx + im.width > CELL:
            problems.append(f"{name} 第 {i+1} 帧出格（dx={dx} dy={dy} w={im.width}）")
    meta.append(dict(row=r, name=name, frames=n, durations=dur))
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out, "WEBP", quality=84, method=6)
# 联系表：棋盘浅底 + 深底各一份，缩一半
cs = Image.new("RGBA", sheet.size, (247, 246, 242, 255)); cs.alpha_composite(sheet)
cs.convert("RGB").resize((sheet.width // 2, sheet.height // 2)).save(out.with_suffix(".contact.jpg"), quality=82)
cd = Image.new("RGBA", sheet.size, (30, 30, 34, 255)); cd.alpha_composite(sheet)
cd.convert("RGB").resize((sheet.width // 2, sheet.height // 2)).save(out.with_suffix(".dark.jpg"), quality=82)
print(json.dumps(dict(meta=meta, problems=problems, bytes=out.stat().st_size), ensure_ascii=False, indent=1))
