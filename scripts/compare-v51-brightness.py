#!/usr/bin/env python3
"""v5.1 objective brightness proof — compares old (v5.0 'boring') vs new (v5.1
bright) screenshots: mean luminance, mean saturation, green-hue share."""
from PIL import Image
import colorsys, sys, os

def stats(path):
    im = Image.open(path).convert("RGB").resize((360, 225))
    px = list(im.getdata())
    n = len(px)
    lum = sat = green = 0
    for r, g, b in px:
        h, s, v = colorsys.rgb_to_hsv(r/255, g/255, b/255)
        lum += v
        sat += s
        # green-ish hue band (70–170 deg of 360) with visible chroma
        if 0.19 <= h <= 0.47 and s > 0.15:
            green += 1
    return {
        "mean_lum": round(lum/n, 3),
        "mean_sat": round(sat/n, 3),
        "green_share": round(green/n, 3),
    }

pairs = [
    ("scripts/verify-v50-home-bright.png", "scripts/verify-v51-prod-home.png", "HOME old→new"),
]
old, new = pairs[0][0], pairs[0][1]
for label in ["old(v5.0)", "new(v5.1)"]:
    p = old if label.startswith("old") else new
    if os.path.exists(p):
        print(f"{label}: {stats(p)}  ({p})")
    else:
        print(f"{label}: MISSING {p}")

# also check tracker + stackblitz new shots
for p in ["scripts/verify-v51-prod-tracker.png", "scripts/verify-v51-prod-stackblitz.png"]:
    if os.path.exists(p):
        print(f"new extra: {stats(p)}  ({p})")
