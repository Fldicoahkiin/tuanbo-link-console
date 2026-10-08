"""Offline feasibility runner. Outputs diagnostics, never publishable project markers."""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import uuid
from typing import Callable

from assets import digest_file, disable_network, verify_assets, write_json_exclusive
from contracts import AnalysisRun, AudioIdentity, MusicLabels, Section, Timings


def progress(stage: str) -> None:
    print(json.dumps({"version": 1, "type": "progress", "stage": stage}), flush=True)


def decode(ffmpeg: Path, source: Path, destination: Path, rate: int) -> None:
    # No shell, overwrite, guessed stream, timestamp shift or MP3-specific compensation.
    command = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-n",
               "-protocol_whitelist", "file,pipe", "-i", str(source),
               "-map", "0:a:0", "-vn", "-ar", str(rate), "-ac", "2", "-c:a", "pcm_s16le",
               str(destination)]
    result = subprocess.run(command, capture_output=True, timeout=180, check=False)
    if result.returncode:
        raise RuntimeError("音频解码失败：" + result.stderr.decode("utf-8", errors="replace"))


def fingerprint(bundle: Path, ffmpeg: Path, device: str, engines: str) -> str:
    manifest_hash = verify_assets(bundle, bundle / "manifest.json")
    package_names = ["torch", "torchaudio", "numpy", "beat-this", "all-in-one-infer",
                     "demucs-infer", "madmom-infer", "librosa", "soundfile"]
    versions = {name: importlib.metadata.version(name) for name in package_names}
    root = Path(__file__).parent
    sources = {name: digest_file(root / name) for name in
               ("analyze.py", "phrase_structure.py", "assets.py", "contracts.py", "consensus.py", "evaluate.py", "semantic_evaluation.py",
                "pyproject.toml", "uv.lock")}
    value = dict(models=manifest_hash, packages=versions, sources=sources, ffmpeg=digest_file(ffmpeg),
                 device=device, engines=engines, separation_rate=44100, seed=0, float16=False)
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def structure_analysis(wav: Path, bundle: Path, output: Path, device: str, duration: float) -> MusicLabels:
    from allin1_infer.session import AllInOneSession
    from allin1_infer.stems import DemucsProvider
    from demucs_infer.checkpoint_runtime import CheckpointRuntime

    class LocalDemucsProvider(DemucsProvider):
        @property
        def model(self):
            if self._model is None:
                self._model = CheckpointRuntime("htdemucs", cache_dir=bundle / "demucs").load_registered_model()
                self._model = self._model.to(self.device).eval()
            return self._model

    provider = LocalDemucsProvider(device=device)
    try:
        with AllInOneSession(model="harmonix-all", device=device, cache_dir=bundle / "all-in-one") as session:
            result = session.infer(
                wav, out_dir=output / "all-in-one", demix_dir=output / "stems", spec_dir=output / "spec",
                keep_byproducts=True, multiprocess=False, include_activations=True,
                include_embeddings=False, stem_provider=provider, compile_model=False,
            )
            # The final endpoint is a container boundary, not a predicted structure boundary.
            sections = [Section(start=float(item.start), end=min(float(item.end), duration), label=item.label)
                        for item in result.segments if float(item.start) < duration]
            return MusicLabels(beats=[float(t) for t in result.beats if 0 <= t < duration],
                               downbeats=[float(t) for t in result.downbeats if 0 <= t < duration],
                               sections=sections)
    finally:
        provider.release()


def run(args: argparse.Namespace, on_progress: Callable[[str], None] = progress) -> AnalysisRun:
    started = time.perf_counter()
    bundle, source, ffmpeg, output = (p.resolve() for p in (args.bundle, args.audio, args.ffmpeg, args.output))
    if not source.is_file() or not ffmpeg.is_file():
        raise ValueError("本地音源或 FFmpeg 不存在")
    output.mkdir(parents=True, exist_ok=False)
    # Library downloads fail rather than contacting any server during inference.
    disable_network()
    on_progress("verify-assets")
    engine_fingerprint = fingerprint(bundle, ffmpeg, args.device, args.engines)
    source_hash = digest_file(source)
    cache_file = (args.cache.resolve() / f"{source_hash}-{engine_fingerprint}.json") if args.cache else None
    if args.cancel_file and args.cancel_file.exists():
        raise KeyboardInterrupt
    if cache_file and cache_file.exists():
        cached = AnalysisRun.model_validate_json(cache_file.read_text(encoding="utf-8"))
        if cached.audio.source_sha256 != source_hash or cached.engine_fingerprint != engine_fingerprint:
            raise ValueError("缓存身份不符；未采用缓存或自动重跑")
        if digest_file(source) != source_hash:
            raise ValueError("读取缓存时音源已改变")
        from consensus import summarize
        write_json_exclusive(output / "consensus.json", summarize(cached))
        if args.cancel_file and args.cancel_file.exists():
            raise KeyboardInterrupt
        cached = cached.model_copy(update={"run_id": str(uuid.uuid4()),
                                          "timings": Timings(total_seconds=time.perf_counter() - started,
                                                             decode_seconds=0, engine_seconds={}, cached=True)})
        write_json_exclusive(output / "result.json", cached.model_dump())
        on_progress("cached-research-only")
        return cached
    import numpy as np
    import soundfile as sf
    import torch
    from beat_this.inference import Audio2Beats

    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用；本次停止，未切换 CPU")
    torch.set_num_threads(8)
    torch.manual_seed(0)
    np.random.seed(0)
    import random
    random.seed(0)
    decode_start = time.perf_counter()
    on_progress("decode-48000-stereo")
    wav = output / "analysis.wav"
    decode(ffmpeg, source, wav, 48000)
    signal, sr = sf.read(wav, dtype="int16", always_2d=True)
    if sr != 48000 or len(signal) == 0:
        raise ValueError("解码未得到有效音频")
    identity = AudioIdentity(source_sha256=source_hash,
                             pcm_sha256=hashlib.sha256(signal.astype("<i2").tobytes()).hexdigest(),
                             sample_rate=48000, sample_count=len(signal), channels=2)
    decode_seconds = time.perf_counter() - decode_start
    diagnostics: dict[str, MusicLabels] = {}
    timings: dict[str, float] = {}
    audio = signal.astype(np.float32) / 32768
    # Exactly silent input must never be sent to rhythm models that hallucinate a grid.
    if np.any(signal):
        for index in range(3):
            if args.cancel_file and args.cancel_file.exists():
                raise KeyboardInterrupt
            name = f"beat-this-final{index}"
            on_progress(name)
            stage_start = time.perf_counter()
            model = Audio2Beats(checkpoint_path=str(bundle / f"beat-this/final{index}.ckpt"),
                               device=args.device, float16=False, dbn=False)
            beats, downbeats = model(audio, sr)
            diagnostics[name] = MusicLabels(beats=[float(t) for t in beats if 0 <= t < identity.duration],
                                           downbeats=[float(t) for t in downbeats if 0 <= t < identity.duration])
            del model
            gc.collect()
            if args.device == "cuda":
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
            timings[name] = time.perf_counter() - stage_start
        if args.engines == "full":
            if args.cancel_file and args.cancel_file.exists():
                raise KeyboardInterrupt
            on_progress("all-in-one-harmonix-all")
            stage_start = time.perf_counter()
            structure_wav = output / "structure-44100.wav"
            # HTDemucs is trained for 44.1 kHz. The community provider does not resample here.
            decode(ffmpeg, wav, structure_wav, 44100)
            diagnostics["all-in-one"] = structure_analysis(
                structure_wav, bundle, output, args.device, identity.duration)
            from phrase_structure import refine_sections
            diagnostics["all-in-one"] = refine_sections(audio, sr, diagnostics["all-in-one"])
            timings["all-in-one"] = time.perf_counter() - stage_start
    else:
        diagnostics["silence-guard"] = MusicLabels()
    if args.cancel_file and args.cancel_file.exists():
        raise KeyboardInterrupt
    if digest_file(source) != source_hash:
        raise ValueError("分析期间源文件被替换；本次结果未提交")
    result = AnalysisRun(run_id=str(uuid.uuid4()), engine_fingerprint=engine_fingerprint,
                         device=args.device, audio=identity, diagnostics=diagnostics,
                         timings=Timings(total_seconds=time.perf_counter() - started,
                                         decode_seconds=decode_seconds, engine_seconds=timings))
    from consensus import summarize
    write_json_exclusive(output / "consensus.json", summarize(result))
    if args.cancel_file and args.cancel_file.exists():
        raise KeyboardInterrupt
    result.timings.total_seconds = time.perf_counter() - started
    write_json_exclusive(output / "result.json", result.model_dump())
    if cache_file:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_file.with_suffix(f".{uuid.uuid4().hex}.pending")
        write_json_exclusive(temporary, result.model_dump())
        temporary.replace(cache_file)
    on_progress("completed-research-only")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory; never overwrite an earlier run")
    parser.add_argument("--device", choices=["cuda", "cpu"], required=True)
    parser.add_argument("--engines", choices=["beat-this", "full"], default="full")
    parser.add_argument("--cache", type=Path, help="Optional validated analysis cache")
    parser.add_argument("--cancel-file", type=Path, help="Cooperative cancellation checked between model stages")
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        run(args)
        return 0
    except KeyboardInterrupt:
        print(json.dumps({"version": 1, "type": "cancelled"}), file=sys.stderr)
        return 130
    except Exception as error:
        traceback.print_exc()
        print(json.dumps({"version": 1, "type": "error", "message": str(error)}, ensure_ascii=False),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
