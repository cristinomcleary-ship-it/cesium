#!/usr/bin/env python3
"""Double-click GUI and CLI for DJI SRT detection/export."""
from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence


SERVICE_ROOT = Path(__file__).resolve().parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))
LOCAL_TCL_ROOT = SERVICE_ROOT / ".venv" / "tcl_runtime"
if (LOCAL_TCL_ROOT / "tcl8.6" / "init.tcl").is_file():
    os.environ.setdefault("TCL_LIBRARY", str(LOCAL_TCL_ROOT / "tcl8.6"))
if (LOCAL_TCL_ROOT / "tk8.6" / "tk.tcl").is_file():
    os.environ.setdefault("TK_LIBRARY", str(LOCAL_TCL_ROOT / "tk8.6"))

from backend_v1.dji_srt_exporter import (  # noqa: E402
    SrtPreparationResult,
    prepare_dji_srt,
)
from backend_v1.dji_telemetry_extractor import (  # noqa: E402
    ExtractionCancelled,
    ExtractionError,
)


APP_VERSION = "1.0.0"
LAUNCHER_LOG_PATH = SERVICE_ROOT / "dji_srt_extractor_launcher.log"
SUCCESS_STATUSES = {"existing_sidecar", "extracted_embedded"}


def _append_launcher_log(message: str) -> None:
    try:
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        with LAUNCHER_LOG_PATH.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(f"\n[{timestamp}] {message.rstrip()}\n")
    except BaseException:
        pass


def _strict_sidecar(video: Path) -> Path | None:
    try:
        matches = sorted(
            (
                path
                for path in video.parent.iterdir()
                if path.is_file()
                and path.suffix.casefold() == ".srt"
                and path.stem.casefold() == video.stem.casefold()
            ),
            key=lambda path: path.name.casefold(),
        )
    except OSError:
        return None
    return matches[0] if len(matches) == 1 else None


def _result_details(result: SrtPreparationResult) -> str:
    lines = [f"状态：{result.status}", result.message]
    if result.output_srt:
        lines.append(f"SRT：{result.output_srt}")
    if result.report_path:
        lines.append(f"报告：{result.report_path}")
    if result.selected_stream_index is not None:
        lines.append(f"字幕流：{result.selected_stream_index}")
    if result.validation:
        lines.append(f"样本数：{result.validation.sample_count}")
        lines.append(f"AR 完整：{'是' if result.validation.ar_ready else '否'}")
        for issue in result.validation.issues:
            lines.append(f"校验：{issue}")
    if result.candidates:
        lines.append("候选流：")
        for candidate in result.candidates:
            index = candidate.get("stream_index", candidate.get("proprietary_stream_index", "?"))
            lines.append(
                f"  stream {index} · codec={candidate.get('codec_name', '?')} · "
                f"AR={'是' if candidate.get('ar_ready') else '否'} · score={candidate.get('score', 0)}"
            )
    for warning in result.warnings:
        lines.append(f"警告：{warning}")
    return "\n".join(lines)


def launch_gui(*, smoke_test: bool = False) -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"DJI 视频 SRT 检测与导出工具 {APP_VERSION}")
    root.geometry("820x620")
    root.minsize(720, 540)

    def report_callback_exception(
        exception_type: type[BaseException], exception: BaseException, tb: Any
    ) -> None:
        details = "".join(traceback.format_exception(exception_type, exception, tb))
        _append_launcher_log(f"Tk 回调异常\n{details}")
        try:
            messagebox.showerror(
                "程序错误",
                f"界面发生错误：{exception}\n\n完整日志：\n{LAUNCHER_LOG_PATH}",
                parent=root,
            )
        except BaseException:
            pass

    root.report_callback_exception = report_callback_exception

    video_var = tk.StringVar()
    sidecar_var = tk.StringVar()
    output_var = tk.StringVar()
    stream_var = tk.StringVar()
    status_var = tk.StringVar(value="请选择 DJI MP4/MOV。外置 SRT 可留空。")
    events: queue.Queue[tuple[str, Any]] = queue.Queue()
    cancel_event = threading.Event()
    worker_thread: threading.Thread | None = None
    pending_close = False

    frame = ttk.Frame(root, padding=16)
    frame.pack(fill="both", expand=True)
    frame.columnconfigure(1, weight=1)

    def choose_video() -> None:
        selected = filedialog.askopenfilename(
            title="选择 DJI 航拍视频",
            filetypes=[
                ("航拍视频", "*.mp4 *.MP4 *.mov *.MOV *.m4v *.M4V"),
                ("全部文件", "*.*"),
            ],
        )
        if not selected:
            return
        video = Path(selected)
        # Never retain a sidecar selected for the previous video.
        sidecar_var.set("")
        video_var.set(str(video))
        output_var.set(str(video.parent / f"{video.stem}_SRT提取结果"))
        exact = _strict_sidecar(video)
        if exact:
            sidecar_var.set(str(exact))
            status_var.set("已发现严格同名外置 SRT；开始后将做字段完整性校验。")
        else:
            status_var.set("未发现严格同名外置 SRT；开始后检查视频内嵌字幕流。")

    def choose_sidecar() -> None:
        selected = filedialog.askopenfilename(
            title="选择拍摄时生成的 DJI SRT（可选）",
            filetypes=[("SRT 字幕", "*.srt *.SRT"), ("全部文件", "*.*")],
        )
        if selected:
            sidecar_var.set(selected)

    def choose_output() -> None:
        selected = filedialog.askdirectory(title="选择输出目录")
        if selected:
            output_var.set(selected)

    ttk.Label(frame, text="DJI 视频").grid(row=0, column=0, sticky="w", padx=(0, 10), pady=6)
    video_entry = ttk.Entry(frame, textvariable=video_var)
    video_entry.grid(row=0, column=1, sticky="ew", pady=6)
    video_button = ttk.Button(frame, text="选择视频", command=choose_video)
    video_button.grid(row=0, column=2, padx=(10, 0), pady=6)

    ttk.Label(frame, text="外置 SRT（可空）").grid(row=1, column=0, sticky="w", padx=(0, 10), pady=6)
    sidecar_entry = ttk.Entry(frame, textvariable=sidecar_var)
    sidecar_entry.grid(row=1, column=1, sticky="ew", pady=6)
    sidecar_button = ttk.Button(frame, text="选择 SRT", command=choose_sidecar)
    sidecar_button.grid(row=1, column=2, padx=(10, 0), pady=6)

    ttk.Label(frame, text="输出目录").grid(row=2, column=0, sticky="w", padx=(0, 10), pady=6)
    output_entry = ttk.Entry(frame, textvariable=output_var)
    output_entry.grid(row=2, column=1, sticky="ew", pady=6)
    output_button = ttk.Button(frame, text="选择目录", command=choose_output)
    output_button.grid(row=2, column=2, padx=(10, 0), pady=6)

    ttk.Label(frame, text="字幕流号（可空）").grid(row=3, column=0, sticky="w", padx=(0, 10), pady=6)
    stream_entry = ttk.Entry(frame, textvariable=stream_var, width=12)
    stream_entry.grid(row=3, column=1, sticky="w", pady=6)
    ttk.Label(frame, text="仅当报告显示多个可用 stream 时填写", foreground="#666666").grid(
        row=3, column=1, sticky="w", padx=(130, 0), pady=6
    )

    explanation = (
        "本工具只导出视频中真实存在的标准内嵌字幕，或验证拍摄时生成的外置 SRT。"
        "它会检查经纬度、高程、云台三轴、焦距和 PTS；普通字幕、错配 SRT 与未支持的 djmd 数据不会伪装成 AR 数据。"
    )
    ttk.Label(frame, text=explanation, wraplength=780, foreground="#444444").grid(
        row=4, column=0, columnspan=3, sticky="w", pady=(10, 8)
    )
    ttk.Label(frame, textvariable=status_var, foreground="#175a8a", wraplength=780).grid(
        row=5, column=0, columnspan=3, sticky="w", pady=(0, 6)
    )
    progress = ttk.Progressbar(frame, mode="indeterminate")
    progress.grid(row=6, column=0, columnspan=3, sticky="ew", pady=6)
    log = tk.Text(frame, height=16, wrap="word", state="disabled")
    log.grid(row=7, column=0, columnspan=3, sticky="nsew", pady=6)
    frame.rowconfigure(7, weight=1)

    action_widgets = [
        video_entry,
        video_button,
        sidecar_entry,
        sidecar_button,
        output_entry,
        output_button,
        stream_entry,
    ]

    def append_log(text: str) -> None:
        log.configure(state="normal")
        log.insert("end", text.rstrip() + "\n")
        try:
            line_count = int(log.index("end-1c").split(".")[0])
            if line_count > 1200:
                log.delete("1.0", f"{line_count - 1000}.0")
        except (ValueError, tk.TclError):
            pass
        log.see("end")
        log.configure(state="disabled")

    def set_busy(busy: bool) -> None:
        for widget in action_widgets:
            try:
                widget.configure(state="disabled" if busy else "normal")
            except tk.TclError:
                pass
        start_button.configure(state="disabled" if busy else "normal")
        cancel_button.configure(state="normal" if busy else "disabled")
        if busy:
            progress.start(12)
        else:
            progress.stop()

    def worker(
        video: Path,
        output: Path,
        sidecar: Path | None,
        stream_index: int | None,
    ) -> None:
        try:
            result = prepare_dji_srt(
                video,
                output,
                explicit_sidecar=sidecar,
                subtitle_stream_index=stream_index,
                cancel_event=cancel_event,
            )
            events.put(("result", result))
        except ExtractionCancelled as exc:
            events.put(("cancelled", exc))
        except BaseException as exc:
            _append_launcher_log(f"SRT 提取任务失败\n{traceback.format_exc()}")
            events.put(("error", exc))

    def start() -> None:
        nonlocal worker_thread
        video_text = video_var.get().strip()
        output_text = output_var.get().strip()
        sidecar_text = sidecar_var.get().strip()
        stream_text = stream_var.get().strip()
        if not video_text or not Path(video_text).is_file():
            messagebox.showerror("无法开始", "请先选择有效的 DJI MP4/MOV 视频", parent=root)
            return
        if sidecar_text and not Path(sidecar_text).is_file():
            messagebox.showerror("无法开始", "指定的外置 SRT 不存在", parent=root)
            return
        if not output_text:
            messagebox.showerror("无法开始", "请选择输出目录", parent=root)
            return
        try:
            stream_index = int(stream_text) if stream_text else None
            if stream_index is not None and stream_index < 0:
                raise ValueError
        except ValueError:
            messagebox.showerror("流号无效", "字幕流号必须是非负整数，或留空", parent=root)
            return
        cancel_event.clear()
        append_log("开始检查严格同名外置 SRT 和视频容器字幕流……")
        status_var.set("正在后台检测；大视频不会阻塞界面，可随时取消。")
        set_busy(True)
        worker_thread = threading.Thread(
            target=worker,
            args=(
                Path(video_text),
                Path(output_text),
                Path(sidecar_text) if sidecar_text else None,
                stream_index,
            ),
            name="dji-srt-extractor",
            daemon=False,
        )
        worker_thread.start()

    def cancel() -> None:
        if worker_thread is not None and worker_thread.is_alive():
            cancel_event.set()
            cancel_button.configure(state="disabled")
            status_var.set("正在取消并清理临时文件……")

    def close_window() -> None:
        nonlocal pending_close
        if worker_thread is not None and worker_thread.is_alive():
            if not messagebox.askyesno("任务仍在运行", "取消当前任务并关闭窗口吗？", parent=root):
                return
            pending_close = True
            cancel()
            return
        root.destroy()

    def poll() -> None:
        nonlocal pending_close
        terminal = False
        for _ in range(30):
            try:
                kind, payload = events.get_nowait()
            except queue.Empty:
                break
            terminal = True
            set_busy(False)
            if kind == "result":
                result: SrtPreparationResult = payload
                details = _result_details(result)
                append_log(details)
                status_var.set(result.message)
                if result.status in SUCCESS_STATUSES and result.ar_ready:
                    if result.output_srt:
                        sidecar_var.set(result.output_srt)
                    messagebox.showinfo("SRT 已就绪", details, parent=root)
                else:
                    messagebox.showwarning("未生成可用于 AR 的 SRT", details, parent=root)
            elif kind == "cancelled":
                append_log(f"已取消：{payload}")
                status_var.set("任务已取消；没有发布不完整文件。")
                if not pending_close:
                    messagebox.showinfo("已取消", str(payload), parent=root)
            else:
                append_log(f"失败：{payload}")
                status_var.set("提取失败；请查看启动日志。")
                if not pending_close:
                    messagebox.showerror("提取失败", str(payload), parent=root)
            if pending_close:
                root.destroy()
                return
        if pending_close and not terminal and (worker_thread is None or not worker_thread.is_alive()):
            root.destroy()
            return
        root.after(100, poll)

    start_button = ttk.Button(frame, text="检测并获取 SRT", command=start)
    start_button.grid(row=8, column=1, sticky="e", padx=(0, 80), pady=(10, 0))
    cancel_button = ttk.Button(frame, text="取消", command=cancel, state="disabled")
    cancel_button.grid(row=8, column=1, sticky="e", pady=(10, 0))
    root.protocol("WM_DELETE_WINDOW", close_window)
    root.after(100, poll)
    if smoke_test:
        root.withdraw()
        root.after(250, root.destroy)
    root.mainloop()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="检测 DJI 视频配套/内嵌 SRT，并校验是否满足 AR 投影输入"
    )
    parser.add_argument("video", type=Path, nargs="?", help="DJI MP4/MOV；省略时打开图形界面")
    parser.add_argument("-s", "--srt", type=Path, help="可选的拍摄配套外置 SRT")
    parser.add_argument("-o", "--output-dir", type=Path, help="输出目录")
    parser.add_argument("--stream-index", type=int, help="多个字幕流时指定 ffprobe stream index")
    parser.add_argument("--ffprobe", default="ffprobe", help="可选 ffprobe 路径")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="可选 ffmpeg 路径")
    parser.add_argument("--overwrite", action="store_true", help="允许覆盖默认导出文件")
    parser.add_argument("--gui", action="store_true", help="打开图形界面")
    parser.add_argument("--gui-smoke-test", action="store_true", help=argparse.SUPPRESS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.gui_smoke_test:
        return launch_gui(smoke_test=True)
    if args.gui or args.video is None:
        return launch_gui()
    video = args.video.expanduser().resolve()
    output = args.output_dir or video.parent / f"{video.stem}_SRT提取结果"
    try:
        result = prepare_dji_srt(
            video,
            output,
            explicit_sidecar=args.srt,
            subtitle_stream_index=args.stream_index,
            ffprobe_bin=args.ffprobe,
            ffmpeg_bin=args.ffmpeg,
            overwrite=args.overwrite,
        )
    except (ExtractionError, OSError, ValueError) as exc:
        print(f"SRT 检测失败：{exc}", file=sys.stderr)
        return 2
    print(_result_details(result))
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if result.status in SUCCESS_STATUSES and result.ar_ready else 3


def _show_fatal_gui_error(details: str) -> None:
    _append_launcher_log(f"未处理异常\n{details}")
    try:
        import tkinter as tk
        from tkinter import messagebox

        dialog_root = tk.Tk()
        dialog_root.withdraw()
        summary = details.strip().splitlines()[-1] if details.strip() else "未知错误"
        messagebox.showerror(
            "DJI SRT 工具启动失败",
            f"程序发生错误：{summary}\n\n完整日志：\n{LAUNCHER_LOG_PATH}",
            parent=dialog_root,
        )
        dialog_root.destroy()
    except BaseException:
        pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        fatal_details = traceback.format_exc()
        print(fatal_details, file=sys.stderr)
        _show_fatal_gui_error(fatal_details)
        raise SystemExit(1)
