"""One isolated offline analysis job with a strict JSON-lines host protocol."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import sys
from typing import Callable, Literal
from uuid import UUID

from pydantic import Field, model_validator

import analyze
from assets import digest_file
from contracts import AnalysisRun, Digest, StrictModel


class WorkerRequest(StrictModel):
    version: Literal[1]
    task_id: UUID
    audio: str = Field(min_length=1)
    source_sha256: Digest
    bundle: str = Field(min_length=1)
    ffmpeg: str = Field(min_length=1)
    output: str = Field(min_length=1)
    cache: str = Field(min_length=1)
    cancel_file: str = Field(min_length=1)
    device: Literal["cpu", "cuda"]

    @model_validator(mode="after")
    def absolute_paths(self):
        for key in ("audio", "bundle", "ffmpeg", "output", "cache", "cancel_file"):
            if not Path(getattr(self, key)).is_absolute():
                raise ValueError("分析进程只接受主进程核验后的绝对路径")
        return self


def execute(request: WorkerRequest, emit: Callable[[dict[str, object]], None],
            runner: Callable[..., AnalysisRun] = analyze.run) -> int:
    def send(kind: str, **payload: object) -> None:
        emit(dict(version=1, taskId=str(request.task_id), type=kind, **payload))

    try:
        if digest_file(Path(request.audio)) != request.source_sha256:
            raise ValueError("音源已改变，未开始识别")
        args = argparse.Namespace(**{key: Path(getattr(request, key)) for key in
                                     ("audio", "bundle", "ffmpeg", "output", "cache", "cancel_file")},
                                  device=request.device, engines="rhythm-structure")
        with contextlib.redirect_stdout(sys.stderr):
            result = runner(args, on_progress=lambda stage: send("progress", stage=stage))
        if result.audio.source_sha256 != request.source_sha256:
            raise ValueError("识别结果的音源身份不符，未交付结果")
        if Path(request.cancel_file).exists():
            raise KeyboardInterrupt
        send("result", result=result.model_dump())
        return 0
    except KeyboardInterrupt:
        send("cancelled")
        return 130
    except Exception as error:
        send("error", message=str(error))
        return 1


def main() -> int:
    if sys.platform == "win32":
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000):
            print("无法将音乐识别设为后台优先级", file=sys.stderr)
            return 2
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    output = sys.stdout

    def emit(value: dict[str, object]) -> None:
        print(json.dumps(value, ensure_ascii=False, allow_nan=False), file=output, flush=True)

    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("分析请求超过长度限制")
        request = WorkerRequest.model_validate_json(raw)
    except Exception as error:
        # An invalid request has no trusted task ID and never starts inference.
        print(str(error), file=sys.stderr)
        return 2
    return execute(request, emit)


if __name__ == "__main__":
    raise SystemExit(main())
