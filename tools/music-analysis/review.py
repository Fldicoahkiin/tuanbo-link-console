"""Produce an offline, inspectable research audition; never modify a project."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf

from consensus import summarize
from contracts import AnalysisRun


def create_review(run_dir: Path, output: Path) -> None:
    run = AnalysisRun.model_validate_json((run_dir / "result.json").read_text(encoding="utf-8"))
    summary = summarize(run)
    candidates = summary.get("candidates", {"beats": [], "downbeats": []})
    pcm, rate = sf.read(run_dir / "analysis.wav", dtype="int16", always_2d=True)
    if (rate != run.audio.sample_rate or len(pcm) != run.audio.sample_count
            or pcm.shape[1] != run.audio.channels
            or hashlib.sha256(pcm.astype("<i2").tobytes()).hexdigest() != run.audio.pcm_sha256):
        raise ValueError("试听音频与分析时间基准不符")
    output.mkdir(parents=True, exist_ok=False)
    signal = pcm.astype(np.float32) / 32768
    shutil.copyfile(run_dir / "analysis.wav", output / "reference.wav")
    mixed = signal * .8
    for time in candidates["beats"]:
        start = round(time * rate)
        length = min(round(.035 * rate), len(signal) - start)
        if length <= 0:
            continue
        downbeat = any(abs(time - point) < .05 for point in candidates["downbeats"])
        t = np.arange(length) / rate
        click = .16 * np.sin(2 * np.pi * (2200 if downbeat else 1500) * t) * np.exp(-t * 110)
        mixed[start:start + length] += click[:, None]
    sf.write(output / "candidate-clicks.wav", np.clip(mixed, -1., 1.), rate, subtype="PCM_16")
    mono = np.max(np.abs(signal), axis=1)
    step = max(1, len(signal) // 2400)
    peaks = [float(np.max(mono[start:start + step])) for start in range(0, len(signal), step)]
    payload = {"run": run.model_dump(), "summary": summary, "peaks": peaks,
               "duration": run.audio.duration}
    serialized = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
    template = (Path(__file__).parent / "review.html").read_text(encoding="utf-8")
    (output / "index.html").write_text(template.replace("__RESEARCH_DATA__", serialized), encoding="utf-8")
    (output / "result.json").write_text(run.model_dump_json(indent=2), encoding="utf-8")
    (output / "consensus.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    create_review(args.run, args.output)
