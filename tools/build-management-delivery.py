"""Build the management evidence gallery; --package is an explicit final-only step.

Only screenshots/recordings named by a successful report are selected. This never
copies project-data, reference source media, browser frames, cookies, or a database.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "output/platform-management"
BASELINE = "39be5f3"
REPORTS = [
    ("formal", "正式项目 · 现有用户数据", "actual/formal-project-report.json", "正式项目只读检查；真实模型与既有人工铁路，未注入验收任务或几何。"),
    ("actual", "隔离项目 · 手工定义与业务贯通", "actual/workflow-report.json", "实际工程模型及浏览器操作；任务、区域和问题为明确标识的隔离验收数据。"),
    ("actual", "隔离项目 · 实际三维与原始录像", "actual/media-scene-report.json", "实际 Viewer、工程网格及原始 4K 录像；高程未核验时不启用相机跟随。"),
    ("actual", "隔离项目 · 编辑、测量及独立锚点", "actual/spatial-tools-report.json", "真实模型表面取点；只展示完整通过报告列出的操作证据。"),
    ("management", "隔离管理 · 实际浏览器业务", "actual/extended-management-report.json", "实际主入口、HTTP 和 SQLite；禁用 GPU 与模型请求，不作为三维或视频精度证据。"),
    ("management", "隔离管理 · 批量安排、需求复用及实际投入", "actual/management-workflows-report.json", "实际主路由与真实后端；部分失败保稿、逐项重试和独立投入确认，无三维验收声明。"),
    ("management", "隔离管理 · 实际角色与资源权限", "actual/browser-permission-report.json", "实际登录及资源访问；使用小型权限夹具，不作为真实模型画面。"),
]
SUPPORT = [
    "api-acceptance.json", "legacy-actor-acceptance.json", "spatial-revision-http.json",
    "form-contract-report.json", "feature-evidence-map.json", "feature-http-evidence.json",
    "formal-data-preservation.json", "formal-view-change.json", "cpu-regression-report.json", "final-source-regression-report.json", "launcher-regression.json",
    "hotpath-regression-report.json", "reference-audit.json", "reference/interaction-report.json",
    "baseline/report.json", "actual/acceptance-business-snapshot.json",
    "actual/workflow-recording-metadata.json", "actual/acceptance-business-snapshot-after-tools.json",
    "actual/media-spatial-recording-metadata.json",
]
DOCS = ["README.md", "docs/platform-management-acceptance.md", "docs/management-api.md", "docs/platform-management-ui.md"]


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def passed(data: dict) -> bool:
    if data.get("failure") or data.get("error") or data.get("result") == "failed":
        return False
    if data.get("result") == "passed" or data.get("passed") is True:
        return True
    return isinstance(data.get("pass"), int) and data["pass"] > 0 and data.get("fail") == 0


def safe_asset(report: Path, value: str) -> Path:
    # Report media are relative to that report's directory, never arbitrary paths.
    candidate = (report.parent / value).resolve()
    if not candidate.is_relative_to(report.parent.resolve()):
        raise ValueError(f"Report media escapes its evidence directory: {value}")
    if not candidate.is_file() or candidate.stat().st_size == 0:
        raise ValueError(f"Missing or empty evidence: {candidate}")
    return candidate


def collect() -> tuple[list[dict], set[Path], list[str]]:
    groups, files, pending = [], set(), []
    for category, title, relative, scope in REPORTS:
        path = EVIDENCE / relative
        data = read(path) if path.exists() else {}
        if not passed(data):
            pending.append(relative)
            groups.append(dict(category=category, title=title, scope=scope, pending=True, images=[], videos=[]))
            continue
        images, videos = [], []
        files.add(path)
        for entry in data.get("screenshots", []):
            name = entry if isinstance(entry, str) else entry.get("file") or entry.get("path")
            if not name:
                continue
            asset = safe_asset(path, name)
            if asset.suffix.lower() not in {".png", ".jpg", ".webp"}:
                raise ValueError(f"Invalid screenshot type: {asset}")
            files.add(asset)
            images.append(asset)
        for entry in data.get("recordings", []):
            name = entry if isinstance(entry, str) else entry.get("file")
            if not name:
                continue
            asset = safe_asset(path, name)
            if asset.suffix.lower() not in {".mp4", ".webm"}:
                raise ValueError(f"Invalid recording type: {asset}")
            files.add(asset)
            videos.append((asset, entry if isinstance(entry, dict) else {}))
        groups.append(dict(category=category, title=title, scope=scope, pending=False,
                           report=path, data=data, images=images, videos=videos))
    for relative in SUPPORT:
        path = EVIDENCE / relative
        if path.is_file():
            files.add(path)
    # Logs remain clearly classified as CPU/contract records, not project imagery.
    files.update(EVIDENCE.glob("*.log"))
    ui = ROOT / "output/management-studio/ui-dom"
    if (ui / "report.json").exists():
        files.add(ui / "report.json")
    for name in ["test-run.log", "typecheck.log", "build.log"]:
        if (ui / name).exists():
            files.add(ui / name)
    workflow_dom = ROOT / "output/management-studio/workflows-dom/report.json"
    if workflow_dom.exists():
        files.add(workflow_dom)
    final_ui = ROOT / "output/management-studio/final-ui-validation.json"
    if final_ui.exists():
        files.add(final_ui)
    files.update(ROOT / name for name in DOCS if (ROOT / name).exists())
    return groups, files, pending


def url(path: Path, packaged: bool = False) -> str:
    if packaged:
        return quote(path.relative_to(ROOT).as_posix(), safe="/")
    import os
    return quote(Path(os.path.relpath(path, EVIDENCE)).as_posix(), safe="/")


def render(groups: list[dict], files: set[Path], pending: list[str], packaged: bool = False) -> str:
    esc = html.escape
    blocks = []
    titles = {"formal": "正式项目", "actual": "隔离实际操作", "management": "实际管理与权限"}
    for category, label in titles.items():
        content = []
        for group in [g for g in groups if g["category"] == category]:
            heading = f'<h3>{esc(group["title"])}</h3><p class="scope">{esc(group["scope"])}</p>'
            if group["pending"]:
                content.append(heading + '<p class="pending">最终报告尚未通过或尚未生成，当前不展示该组截图/录像。</p>')
                continue
            data = group["data"]
            count = len(data.get("checks", []))
            report_link = f'<a href="{url(group["report"], packaged)}">查看原始报告</a>'
            heading += f'<p class="meta">报告通过 · {count} 项检查 · {len(group["images"])} 张截图 · {report_link}</p>'
            cards = []
            for asset, recording in group["videos"]:
                duration = recording.get("actualDurationMs")
                note = f"录制墙钟 {duration / 1000:.3f} 秒；" if isinstance(duration, (int, float)) else ""
                cards.append(f'<article class="video"><video controls preload="metadata" src="{url(asset, packaged)}"></video><strong>{esc(asset.name)}</strong><p>{note}编码帧率不等于应用性能。</p></article>')
            if cards:
                heading += '<div class="videos">' + ''.join(cards) + '</div>'
            images = ''.join(f'<figure><button class="zoom" data-src="{url(asset, packaged)}" data-title="{esc(asset.name)}" aria-label="放大 {esc(asset.name)}"><img loading="lazy" src="{url(asset, packaged)}" alt="{esc(asset.name)}"></button><figcaption>{esc(asset.name)}</figcaption></figure>' for asset in group["images"])
            content.append(heading + '<div class="gallery">' + images + '</div>')
        blocks.append(f'<section id="{category}"><h2>{label}</h2>' + ''.join(content) + '</section>')
    technical = [p for p in sorted(files) if p.suffix in {".json", ".log", ".md"} and p not in {g.get("report") for g in groups}]
    links = ''.join(f'<li><a href="{url(p, packaged)}">{esc(p.relative_to(ROOT).as_posix())}</a>{" · 空输出日志，结论见对应结构化报告" if p.stat().st_size == 0 else ""}</li>' for p in technical)
    blocks.append('<section id="contracts"><h2>DOM、HTTP、CPU 与数据保留</h2><p>接口与 DOM 结果只证明各自合同。小型隔离夹具、无 GPU 界面及 CPU 测试不作为真实工程网格、视频配准或性能验收。</p><ul class="reports">' + links + '</ul></section>')
    blocks.append('<section id="reference"><h2>设计参考与历史基线</h2><p>参考包 535 文件仅用于核对布局、业务与素材完整性，概念图、合成场景及参考录像未放入实际项目截图或操作录像。reference-audit.json 与 reference/interaction-report.json 明确记录其参考性质。旧 V5 基线报告也不代表本轮新功能通过。</p></section>')
    media = next((g.get("data", {}) for g in groups if "media-scene" in str(g.get("report"))), {})
    perf = media.get("performance", {})
    perf_text = f'{perf.get("fps", 0):.2f} FPS · p95 {perf.get("p95FrameMs", 0):.1f} ms · 视频丢帧 {perf.get("droppedVideoFrames", 0)}/{perf.get("videoFrames", 0)}' if perf else "等待固定条件性能报告"
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>项目统筹平台 · 实际证据</title><style>' + CSS + '</style><header><span class="eyebrow">CESIUM / MANAGEMENT EVIDENCE</span><h1>项目统筹平台 · 实际运行证据</h1><p>正式数据、隔离实测与参考素材分层展示。仅收录通过报告明确引用的截图和录像。</p><div class="metric">' + esc(perf_text) + '</div><p class="fine">性能环境：RTX 4080，1920×1080，实际 3840×2160 原片，30.506 秒样本。高程基准未核验，可靠相机跟随未通过；源网格和处理服务未接入，未声称拓扑修复完成。</p></header><nav><a href="#formal">正式项目</a><a href="#actual">隔离操作</a><a href="#management">管理与权限</a><a href="#contracts">接口与记录</a><a href="#reference">参考边界</a></nav><main>' + ''.join(blocks) + '</main><footer>生成于 ' + esc(datetime.now(timezone.utc).isoformat()) + f' · {len(pending)} 组最终报告尚未就绪。文件指纹见 evidence-manifest.json。</footer><dialog><button id="close" aria-label="关闭大图">关闭 ×</button><img alt=""><p></p></dialog><script>' + JS + '</script></html>'


CSS = """*{box-sizing:border-box}body{margin:0;background:#f3f6f9;color:#173041;font:15px/1.65 system-ui,'Microsoft YaHei',sans-serif}header{background:#0d2438;color:#eaf2f8;padding:42px max(24px,calc((100vw - 1380px)/2));border-bottom:4px solid #30b9d6}h1{font-size:32px;margin:8px 0 12px}.eyebrow{font-size:12px;letter-spacing:3px;color:#7ecbda}.metric{display:inline-block;background:#173d51;padding:8px 16px;border-radius:8px;color:#a5e9f4}.fine{font-size:13px;color:#aec3d0;max-width:1100px}nav{position:sticky;top:0;display:flex;gap:24px;flex-wrap:wrap;background:#fff;padding:12px max(24px,calc((100vw - 1380px)/2));z-index:2;border-bottom:1px solid #dfe7ed}a{color:#087f9b}main{max-width:1430px;margin:auto;padding:22px 24px}section{scroll-margin-top:90px;background:#fff;padding:24px;border:1px solid #dfe7ed;border-radius:10px;margin-bottom:24px}h2{font-size:23px;margin-top:0}h3{margin-top:30px}.scope{margin-bottom:4px;color:#546c7c}.meta{font-size:13px;color:#697e8d}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.gallery figure{margin:0;border:1px solid #dfe7ed;border-radius:8px;overflow:hidden;background:#f8fafb}.zoom{border:0;padding:0;width:100%;cursor:zoom-in;background:#0d2438}.zoom img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}.gallery figcaption{padding:8px 12px;font-size:12px;overflow-wrap:anywhere}.videos{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px;margin:16px 0 24px}.video video{width:100%;background:#081725;border-radius:8px}.video p{font-size:12px;color:#697e8d}.pending{padding:16px;border-left:4px solid #d69f48;background:#fff6e5}.reports{columns:2;overflow-wrap:anywhere}.reports li{break-inside:avoid;margin-bottom:8px;font-size:13px}footer{padding:24px;text-align:center;color:#697e8d}dialog{border:1px solid #25465e;background:#0d2438;color:#eaf2f8;max-width:96vw;max-height:96vh;padding:18px;border-radius:8px}dialog::backdrop{background:#001322df}dialog img{max-width:92vw;max-height:82vh;display:block}dialog button{display:block;margin-left:auto;margin-bottom:10px;cursor:pointer;padding:8px 14px}dialog p{margin-bottom:0}@media(max-width:700px){header{padding:28px 20px}h1{font-size:25px}main{padding:12px}section{padding:16px}.reports{columns:1}.videos,.gallery{grid-template-columns:1fr}nav{gap:14px;padding:10px 16px;font-size:13px}}"""
JS = """const dialog=document.querySelector('dialog');document.querySelectorAll('.zoom').forEach(b=>b.addEventListener('click',()=>{dialog.querySelector('img').src=b.dataset.src;dialog.querySelector('img').alt=b.dataset.title;dialog.querySelector('p').textContent=b.dataset.title;dialog.showModal()}));document.querySelector('#close').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});"""


def manifest(files: set[Path], pending: list[str]) -> dict:
    return {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
            "scope": "Only media referenced by passed reports; technical evidence separately classified.",
            "pendingFinalReports": pending, "baseline": BASELINE,
            "files": [{"path": p.relative_to(ROOT).as_posix(), "bytes": p.stat().st_size, "sha256": digest(p)} for p in sorted(files)]}


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=ROOT)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--package", action="store_true", help="Final only: require all reports and committed source, then build source+evidence ZIP.")
    ap.add_argument("--preflight", action="store_true", help="Validate report assets without generating files.")
    args = ap.parse_args()
    groups, files, pending = collect()
    if args.preflight:
        print(json.dumps({"selectedFiles": len(files), "pending": pending, "packageReady": not pending}, ensure_ascii=False))
        return
    if args.package:
        if pending:
            raise SystemExit("Final package blocked by reports: " + ", ".join(pending))
        # Recompute original file hashes read-only. A disclosed display preference is
        # the sole allowed difference; never call all original JSON byte-identical.
        initial = read(EVIDENCE / "baseline/report.json")["beforeHashes"]
        changes, missing = [], []
        for relative, old_hash in initial.items():
            current = (ROOT / relative.replace("\\", "/")).resolve()
            if not current.is_relative_to(ROOT) or not current.is_file():
                missing.append(relative)
                continue
            new_hash = digest(current)
            if new_hash != old_hash:
                changes.append({"path": relative.replace("\\", "/"), "before": old_hash, "after": new_hash})
        if missing or any(c["path"] != "project-data/view.json" for c in changes):
            raise SystemExit("Formal business/source files changed or disappeared; packaging stopped")
        if changes:
            documented = read(EVIDENCE / "formal-view-change.json")
            if documented.get("baselineSha256") != changes[0]["before"] or documented.get("currentSha256") != changes[0]["after"]:
                raise SystemExit("Current view preference differs from the disclosed hashes; review before packaging")
        packaging_preservation = {"checkedAt": datetime.now(timezone.utc).isoformat(), "baselineCount": len(initial), "unchangedCount": len(initial) - len(changes), "changed": changes, "missing": missing, "note": "Business/source files unchanged. Any disclosed view.json difference remains explicitly recorded; no formal file was altered by packaging."}
        if git("diff", "--name-only", "HEAD", "--", "src", "server", "tools", "docs", "README.md", "package.json", "pnpm-lock.yaml", "vite.config.ts").strip():
            raise SystemExit("Commit final source/docs/tools before creating source archive")
        untracked = git("ls-files", "--others", "--exclude-standard", "--", "src", "server", "tools", "docs").strip()
        if untracked:
            raise SystemExit("Untracked deliverable source exists; review and commit before packaging")
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    index = EVIDENCE / "index.html"
    index.write_text(render(groups, files, pending), encoding="utf-8", newline="\n")
    files.add(index)
    data = manifest(files, pending)
    if args.package:
        data["packagingDataPreservation"] = packaging_preservation
    (EVIDENCE / "evidence-manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.package:
        head = git("rev-parse", "HEAD").decode().strip()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        destination = ROOT / "output" / f"management-delivery-{head[:8]}-{stamp}"
        destination.mkdir(exist_ok=False)
        for source in sorted(files):
            target = destination / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        (destination / "index.html").write_text(render(groups, files, pending, packaged=True), encoding="utf-8", newline="\n")
        archive = destination / "source.zip"
        subprocess.check_call(["git", "archive", "--format=zip", f"--output={archive}", "HEAD"], cwd=ROOT)
        (destination / "changes-from-39be5f3.patch").write_bytes(git("diff", "--binary", BASELINE, "HEAD"))
        (destination / "packaging-data-preservation.json").write_text(json.dumps(packaging_preservation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (destination / "source-version.json").write_text(json.dumps({"baseline": git("rev-parse", BASELINE).decode().strip(), "head": head}, indent=2), encoding="utf-8")
        packaged_files = sorted(p for p in destination.rglob("*") if p.is_file())
        hashes = {"sourceCommit": head, "baseline": BASELINE, "files": [{"path": p.relative_to(destination).as_posix(), "bytes": p.stat().st_size, "sha256": digest(p)} for p in packaged_files]}
        (destination / "evidence-manifest.json").write_text(json.dumps(hashes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        zip_path = destination.with_suffix(".zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for path in sorted(destination.rglob("*")):
                if path.is_file():
                    z.write(path, path.relative_to(destination).as_posix())
        zip_path.with_suffix(".zip.sha256").write_text(digest(zip_path) + "  " + zip_path.name + "\n", encoding="utf-8")
        print(str(zip_path))
    else:
        print(json.dumps({"index": str(index), "files": len(files), "pending": pending, "zipCreated": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
