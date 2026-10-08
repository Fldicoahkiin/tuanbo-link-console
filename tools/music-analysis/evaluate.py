"""One-to-one timing evaluation. Model agreement is not ground-truth accuracy."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path
from typing import Annotated

import numpy as np
from pydantic import Field
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import min_weight_full_bipartite_matching

from assets import write_json_exclusive
from contracts import AnalysisRun, Corpus, StrictModel
from semantic_evaluation import POINT_EVENTS, INTERVAL_EVENTS, score_events, score_section_labels


class Score(StrictModel):
    predicted: int
    reference: int
    matched: int
    precision: float | None
    recall: float | None
    median_error_ms: float | None
    p95_error_ms: float | None


class RunIndex(StrictModel):
    runs: dict[str, str] = Field(min_length=1)


def match_points(predicted: list[float], reference: list[float], tolerance: float) -> list[tuple[int, int]]:
    """Maximum count, then minimum total timing error; each point used at most once.

    Dummy columns allow unmatched predictions without a dense all-song cost matrix.
    A dummy costs more than all real edges combined, so recall comes before distance.
    """
    if tolerance <= 0 or not np.isfinite(tolerance):
        raise ValueError("时间容差必须为有限正数")
    for points in (predicted, reference):
        if any(not np.isfinite(t) or t < 0 for t in points) or points != sorted(set(points)):
            raise ValueError("时间点必须非负、有限且严格递增")
    if not predicted or not reference:
        return []
    refs = np.asarray(reference)
    rows, columns, costs = [], [], []
    for index, time in enumerate(predicted):
        begin = int(np.searchsorted(refs, time - tolerance - 1e-12, side="left"))
        end = int(np.searchsorted(refs, time + tolerance + 1e-12, side="right"))
        for target in range(begin, end):
            rows.append(index)
            columns.append(target)
            costs.append(abs(time - reference[target]) / tolerance + 1e-9)
        rows.append(index)
        columns.append(len(reference) + index)
        costs.append(len(predicted) + 2.0)
    matrix = coo_matrix((costs, (rows, columns)),
                        shape=(len(predicted), len(reference) + len(predicted))).tocsr()
    row_indices, col_indices = min_weight_full_bipartite_matching(matrix)
    return [(int(i), int(j)) for i, j in zip(row_indices, col_indices) if j < len(reference)]


def score_points(predicted: list[float], reference: list[float], tolerance: float) -> Score:
    pairs = match_points(predicted, reference, tolerance)
    errors = [abs(predicted[i] - reference[j]) * 1000 for i, j in pairs]
    return Score(predicted=len(predicted), reference=len(reference), matched=len(pairs),
                 precision=len(pairs) / len(predicted) if predicted else None,
                 recall=len(pairs) / len(reference) if reference else None,
                 median_error_ms=float(np.median(errors)) if errors else None,
                 p95_error_ms=float(np.percentile(errors, 95)) if errors else None)


class MetricGate(StrictModel):
    precision: Annotated[float, Field(ge=0, le=1)]
    recall: Annotated[float, Field(ge=0, le=1)]


GATES = {"beats": MetricGate(precision=.99, recall=.95),
         "downbeats": MetricGate(precision=.98, recall=.90),
         "boundaries": MetricGate(precision=.95, recall=.85)}


def evaluate(corpus: Corpus, runs: dict[str, AnalysisRun], engine: str) -> dict[str, object]:
    if set(runs) - {track.id for track in corpus.tracks}:
        raise ValueError("分析清单存在不属于曲库的曲目")
    counts = Counter(track.split for track in corpus.tracks)
    reasons: list[str] = []
    for split, minimum in (("train", 80), ("calibration", 30), ("test", 40)):
        if counts[split] < minimum:
            reasons.append(f"{split} 只有 {counts[split]} 首，要求至少 {minimum} 首")
    songs: list[dict[str, object]] = []
    genres: dict[str, list[dict[str, object]]] = defaultdict(list)
    for track in corpus.tracks:
        if track.split != "test":
            continue
        run = runs.get(track.id)
        if run is None or engine not in run.diagnostics:
            reasons.append(f"{track.id} 缺少指定引擎的完整结果")
            continue
        if run.audio.source_sha256 != track.source_sha256 or abs(run.audio.duration - track.duration) > .001:
            raise ValueError(f"{track.id} 分析与参考音源身份/时长不一致")
        if track.reference is None or not track.reference.reviewed:
            reasons.append(f"{track.id} 没有双人复核参考标注")
            continue
        if not track.reference.rhythm_audit_passed:
            reasons.append(f"{track.id} 持续半速/倍速/错相位检查未通过")
        prediction, reference = run.diagnostics[engine], track.reference.labels
        metrics = {
            "beats": score_points(prediction.beats, reference.beats, .05),
            "downbeats": score_points(prediction.downbeats, reference.downbeats, .07),
            # File start/end are not detected boundaries and do not inflate F1.
            "boundaries": score_points([s.start for s in prediction.sections if s.start > 0],
                                       [s.start for s in reference.sections if s.start > 0], .25),
        }
        row = dict(id=track.id, genre=track.genre, metrics={k: v.model_dump() for k, v in metrics.items()},
                   events=score_events(prediction.events, reference.events),
                   labels=score_section_labels(prediction.sections, reference.sections, track.duration))
        songs.append(row)
        genres[track.genre].append(row)
    # Per-song macro averages avoid allowing one long easy song to dominate the score.
    def aggregate(rows: list[dict[str, object]]) -> dict[str, object]:
        summary: dict[str, object] = {}
        for metric in GATES:
            scores = [row["metrics"][metric] for row in rows]
            summary[metric] = {
                field: float(np.mean([s[field] for s in scores if s[field] is not None]))
                if any(s[field] is not None for s in scores) else None
                for field in ("precision", "recall")
            }
            summary[metric]["evaluated_songs"] = len(scores)
            summary[metric]["empty_predictions"] = sum(s["predicted"] == 0 for s in scores)
        return summary
    summary = aggregate(songs)
    by_genre = {genre: aggregate(rows) for genre, rows in genres.items()}
    def semantic_summary(rows: list[dict[str, object]]) -> dict[str, object]:
        def mean(scores: list[dict], field: str) -> float | None:
            values = [score[field] for score in scores if score[field] is not None]
            return float(np.mean(values)) if values else None
        events = {}
        for kind in POINT_EVENTS + INTERVAL_EVENTS:
            scores = [row["events"][kind] for row in rows]
            events[kind] = {field: mean(scores, field) for field in ("precision", "recall")}
            events[kind].update({field: sum(score[field] for score in scores)
                                 for field in ("predicted", "reference", "matched")})
        labels = [row["labels"] for row in rows]
        return dict(events=events, labels={field: mean(labels, field)
                    for field in ("precision", "recall", "named_time_coverage", "reference_section_coverage")})
    semantics = semantic_summary(songs)
    semantics_by_genre = {genre: semantic_summary(rows) for genre, rows in genres.items()}
    for kind, score in semantics["events"].items():
        if score["reference"] < 100:
            reasons.append(f"{kind} 盲测参考实例仅 {score['reference']} 个，要求至少 100 个")
        precision_target = .98 if kind in POINT_EVENTS else .95
        if score["precision"] is None or score["precision"] < precision_target or score["recall"] is None or score["recall"] < .8:
            reasons.append(f"{kind} 事件精度或召回未通过")
    if semantics["labels"]["precision"] is None or semantics["labels"]["precision"] < .95:
        reasons.append("结构标签正确率未达到 95%，覆盖率单独报告")
    for group, metrics in {"all": summary, **by_genre}.items():
        for metric, gate in GATES.items():
            for field, target in gate.model_dump().items():
                value = metrics[metric][field]
                if value is None or value < target:
                    reasons.append(f"{group}/{metric}/{field} 未达到 {target:.0%}")
    # Scoring code is not evidence of classifier quality or independent calibration.
    reasons.append("类别分类器、真实校准、误差尾部、实际播放对齐、原版一致性与曲库性能尚未完成发布审核")
    return dict(version=1, status="not-validated", enabled_capabilities=[], engine=engine,
                split_counts=dict(counts), timing_summary=summary, by_genre=by_genre,
                semantic_summary=semantics, semantic_by_genre=semantics_by_genre,
                songs=songs, blockers=reasons)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    corpus = Corpus.model_validate_json(args.corpus.read_text(encoding="utf-8"))
    index = RunIndex.model_validate_json(args.runs.read_text(encoding="utf-8"))
    runs = {key: AnalysisRun.model_validate_json((args.runs.parent / value).read_text(encoding="utf-8"))
            for key, value in index.runs.items()}
    write_json_exclusive(args.output, evaluate(corpus, runs, args.engine))


if __name__ == "__main__":
    main()
