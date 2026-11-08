"""把出图模型给的一行动作条（青色底）切成透明帧：抠色 + 去溢色 + 连通块分帧 + 统一基线。"""
import json, sys
from pathlib import Path
from PIL import Image
import numpy as np
from collections import deque

def key_alpha(rgb):
    r, g, b = [rgb[..., i].astype(np.float32) for i in range(3)]
    c = np.minimum(g, b) - r            # 青色程度：纯青 255，白/墨/米色 ≤ 0
    a = np.clip((150 - c) / (150 - 40), 0, 1)
    # 去溢色：观测 = a*F + (1-a)*K，K = (0,255,255)
    out = rgb.astype(np.float32).copy()
    m = (a > 0) & (a < 1)
    for i, k in enumerate((0, 255, 255)):
        ch = out[..., i]
        ch[m] = (ch[m] - (1 - a[m]) * k) / np.maximum(a[m], 1e-3)
    # 残余青边：G/B 不得明显高于 R（米色、墨色、琥珀都满足）
    rr = out[..., 0]
    for i in (1, 2):
        ch = out[..., i]
        edge = a < 0.98
        ch[edge] = np.minimum(ch[edge], rr[edge] + 10)
    return np.clip(out, 0, 255).astype(np.uint8), (a * 255).astype(np.uint8)

def components(mask):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32); comps = []; n = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]: continue
        n += 1; q = deque([(y0, x0)]); lab[y0, x0] = n
        x1 = x2 = x0; y1 = y2 = y0; area = 0
        while q:
            y, x = q.popleft(); area += 1
            x1 = min(x1, x); x2 = max(x2, x); y1 = min(y1, y); y2 = max(y2, y)
            for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                yy, xx = y+dy, x+dx
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n; q.append((yy, xx))
        comps.append(dict(id=n, area=area, box=(x1, y1, x2+1, y2+1)))
    return lab, comps

def extract(path, n):
    src = Image.open(path)
    im = src.convert("RGB")
    rgba0 = np.asarray(src.convert("RGBA"))
    if src.mode in ("RGBA", "LA") and (rgba0[..., 3] < 10).mean() > 0.3:
        col, alpha = rgba0[..., :3].copy(), rgba0[..., 3].copy()   # 模型直接给了透明底
    else:
        col, alpha = key_alpha(np.asarray(im))
    # 先缩一半找块（快），再回原图裁
    small = Image.fromarray(alpha).resize((im.width // 2, im.height // 2))
    lab, comps = components(np.asarray(small) > 128)
    comps = [c for c in comps if c["area"] > 30]
    comps.sort(key=lambda c: -c["area"])
    big = sorted(comps[:n], key=lambda c: c["box"][0])
    if len(big) < n or big[-1]["area"] < 0.35 * big[0]["area"]:
        return None, f"只找到 {len([c for c in comps if c['area'] > 0.35*comps[0]['area']])} 个主体，要 {n}"
    frames = [[c] for c in big]
    for c in comps[n:]:
        cx = (c["box"][0] + c["box"][2]) / 2
        j = min(range(n), key=lambda i: max(0, frames[i][0]["box"][0] - cx, cx - frames[i][0]["box"][2]))
        d = max(0, frames[j][0]["box"][0] - cx, cx - frames[j][0]["box"][2])
        if d < 40: frames[j].append(c)        # 贴着的 z / 热气 / 泪滴；远的散点丢掉
    out = []
    rgba = np.dstack([col, alpha])
    for fr in frames:
        keep = np.isin(lab, [c["id"] for c in fr])
        keep = np.asarray(Image.fromarray(keep.astype(np.uint8) * 255).resize((im.width, im.height))) > 0
        # 膨胀一点把半透明边带上
        k = keep.copy()
        for dy in (-2, -1, 1, 2):
            k |= np.roll(keep, dy, 0)
        for dx in (-2, -1, 1, 2):
            k |= np.roll(keep, dx, 1)
        x1 = min(c["box"][0] for c in fr) * 2 - 4; y1 = min(c["box"][1] for c in fr) * 2 - 4
        x2 = max(c["box"][2] for c in fr) * 2 + 4; y2 = max(c["box"][3] for c in fr) * 2 + 4
        x1, y1 = max(0, x1), max(0, y1); x2, y2 = min(im.width, x2), min(im.height, y2)
        a = rgba.copy(); a[..., 3] = np.where(k, a[..., 3], 0)
        crop = a[y1:y2, x1:x2]
        # 下 35% 的横向质心（腿和身子下沿）做水平锚点，举手不带歪身子
        al = crop[..., 3].astype(np.float32)
        hh = al.shape[0]; low = al[int(hh * 0.65):]
        cx = (low.sum(0) * np.arange(al.shape[1])).sum() / max(low.sum(), 1)
        out.append(dict(img=Image.fromarray(crop, "RGBA"), ax=cx, x=x1 + cx, top=y1, bottom=y2, w=x2 - x1, h=y2 - y1))
    return out, None

if __name__ == "__main__":
    print(json.dumps({k: (extract(sys.argv[1], int(sys.argv[2]))[1]) for k in [0]}))
