"""Conservative research candidates. Agreement is not calibrated accuracy."""

from __future__ import annotations

from bisect import bisect_left
from statistics import median

from contracts import AnalysisRun, MusicLabels
from evaluate import match_points, score_points


def agreed_points(series: list[list[float]], tolerance: float) -> list[float]:
    if len(series) < 3:
        raise ValueError("一致性检查至少需要三个独立模型结果")
    matches = [dict(match_points(series[0], other, tolerance)) for other in series[1:]]
    points = []
    for index, time in enumerate(series[0]):
        if not all(index in pairs for pairs in matches):
            continue
        votes = [time] + [other[pairs[index]] for other, pairs in zip(series[1:], matches)]
        # Check the full spread; two opposite offsets from an anchor are still a conflict.
        if max(votes) - min(votes) <= tolerance + 1e-12:
            points.append(float(median(votes)))
    return points


def summarize(run: AnalysisRun) -> dict[str, object]:
    names = [f"beat-this-final{index}" for index in range(3)]
    if not all(name in run.diagnostics for name in names):
        return {"version": 1, "publication": "not-validated", "reason": "没有三模型节拍结果"}
    models = [run.diagnostics[name] for name in names]
    beats = agreed_points([model.beats for model in models], .03)
    downbeats = agreed_points([model.downbeats for model in models], .05)
    # Never output a downbeat without a nearby agreed beat.
    downbeats = [time for time in downbeats if any(abs(beat - time) <= .05 for beat in
                 beats[max(0, bisect_left(beats, time) - 1):bisect_left(beats, time) + 1])]
    comparison = {}
    for index, name in enumerate(names):
        for other in names[index + 1:]:
            comparison[f"{name}/{other}"] = score_points(
                run.diagnostics[name].beats, run.diagnostics[other].beats, .05).model_dump()
    conflicts = []
    for start in range(0, int(run.audio.duration) + 1, 8):
        counts = [sum(start <= time < start + 8 for time in model.beats) for model in models]
        positive = [count for count in counts if count]
        if positive and (0 in counts or max(counts) / min(positive) >= 1.7):
            conflicts.append({"start": start, "end": min(start + 8, run.audio.duration),
                              "counts": counts, "reason": "节奏密度冲突，可能半速或倍速"})
    if "all-in-one" in run.diagnostics:
        comparison["consensus/all-in-one"] = score_points(
            beats, run.diagnostics["all-in-one"].beats, .05).model_dump()
    candidate = MusicLabels(beats=beats, downbeats=downbeats)
    return {"version": 1, "publication": "not-validated", "ground_truth_accuracy": None,
            "meaning": "模型一致性诊断，不是准确率；候选不得直接作为正式工程标记",
            "candidates": candidate.model_dump(), "model_comparison": comparison,
            "rhythm_conflicts": conflicts,
            "candidate_coverage": len(beats) / max(1, max(len(model.beats) for model in models))}
