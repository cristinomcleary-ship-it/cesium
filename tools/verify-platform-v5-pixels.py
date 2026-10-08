"""Measure actual paired mesh pixels; this supplements, never replaces, visual review."""
from pathlib import Path
import json
import math
from PIL import Image

root = Path(__file__).resolve().parents[1]
out = root / "output/platform-v5"
report = json.loads((out / "scene-acceptance-report.json").read_text(encoding="utf-8"))
assert report["result"] == "passed"
a = Image.open(out / "v5-03-showcase-scene-only.png").convert("RGB")
b = Image.open(out / "v5-04-reality-scene-only.png").convert("RGB")
assert a.size == b.size
samples = [s for s in report["meshEvidence"]["commonSamples"] if s["sameMesh"] and s["distance"] < .05]
pa, pb = [], []
for s in samples:
    x, y = round(s["x"]), round(s["y"])
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            pa.append(a.getpixel((x + dx, y + dy)))
            pb.append(b.getpixel((x + dx, y + dy)))

def mean(values):
    return sum(values) / len(values)

def luminance(p):
    return .2126 * p[0] + .7152 * p[1] + .0722 * p[2]

la, lb = list(map(luminance, pa)), list(map(luminance, pb))
ma, mb = mean(la), mean(lb)
cov = sum((x - ma) * (y - mb) for x, y in zip(la, lb))
denominator = math.sqrt(sum((x - ma)**2 for x in la) * sum((y - mb)**2 for y in lb))
result = {
    "scope": "Actual Production_2; same camera and verified common real mesh positions, 5x5 pixel neighborhoods. No reference/fixture pixels used.",
    "images": ["v5-03-showcase-scene-only.png", "v5-04-reality-scene-only.png"],
    "commonMeshSamples": len(samples), "pixelCount": len(pa),
    "meanAbsoluteRgbDifference": mean([abs(x-y) for p, q in zip(pa, pb) for x, y in zip(p, q)]),
    "changedPixelFraction": mean([p != q for p, q in zip(pa, pb)]),
    "showcaseMeanRgb": [mean([p[i] for p in pa]) for i in range(3)],
    "realityMeanRgb": [mean([p[i] for p in pb]) for i in range(3)],
    "showcaseLuminanceStdDev": math.sqrt(mean([(x-ma)**2 for x in la])),
    "realityLuminanceStdDev": math.sqrt(mean([(x-mb)**2 for x in lb])),
    "pairedLuminanceCorrelation": cov / denominator if denominator else None,
    "limitation": "Numerical evidence of changed actual surface and retained tonal variation. Does not establish mesh topology quality, video registration, or substitute for visual G03/G04 review."
}
assert result["commonMeshSamples"] > 50
assert result["changedPixelFraction"] > .75
assert result["showcaseLuminanceStdDev"] > 8
result["result"] = "passed"
(out / "material-pixel-comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
