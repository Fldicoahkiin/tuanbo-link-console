"""One-to-one event and section-label scoring against independently reviewed truth."""

from __future__ import annotations

from collections.abc import Iterable
import re

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import min_weight_full_bipartite_matching

from contracts import Event, Section


def assignment(predicted: int, reference: int,
               edges: Iterable[tuple[int, int, float]]) -> list[tuple[int, int]]:
    """Maximize match count before minimizing normalized error; duplicates stay false positives."""
    if not predicted or not reference:
        return []
    rows, columns, costs = [], [], []
    for left, right, cost in edges:
        if not 0 <= cost <= 1 or not np.isfinite(cost):
            raise ValueError("匹配代价必须在 0 到 1 之间")
        rows.append(left)
        columns.append(right)
        costs.append(cost + 1e-9)
    for left in range(predicted):
        rows.append(left)
        columns.append(reference + left)
        costs.append(predicted + 2.)
    matrix = coo_matrix((costs, (rows, columns)), shape=(predicted, reference + predicted)).tocsr()
    lefts, rights = min_weight_full_bipartite_matching(matrix)
    return [(int(left), int(right)) for left, right in zip(lefts, rights) if right < reference]


def interval_iou(start: float, end: float, reference_start: float, reference_end: float) -> float:
    intersection = max(0., min(end, reference_end) - max(start, reference_start))
    union = max(end, reference_end) - min(start, reference_start)
    return intersection / union if union > 0 else 0.


def counts(predicted: int, reference: int, matched: int) -> dict[str, int | float | None]:
    return dict(predicted=predicted, reference=reference, matched=matched,
                precision=matched / predicted if predicted else None,
                recall=matched / reference if reference else None)


POINT_EVENTS = ("hit", "drop", "stop", "last")
INTERVAL_EVENTS = ("roll", "build", "ending")


def score_events(predicted: list[Event], reference: list[Event]) -> dict[str, dict]:
    result = {}
    for kind in POINT_EVENTS + INTERVAL_EVENTS:
        left = [event for event in predicted if event.kind == kind]
        right = [event for event in reference if event.kind == kind]
        is_interval = kind in INTERVAL_EVENTS
        edges = []
        for i, event in enumerate(left):
            for j, truth in enumerate(right):
                if is_interval:
                    if event.end is None or truth.end is None:
                        raise ValueError("区间事件必须有终点")
                    iou = interval_iou(event.start, event.end, truth.start, truth.end)
                    if iou + 1e-12 >= .7:
                        edges.append((i, j, 1 - iou))
                else:
                    error = abs(event.start - truth.start)
                    if error <= .08 + 1e-12:
                        edges.append((i, j, min(1., error / .08)))
        matches = assignment(len(left), len(right), edges)
        score = counts(len(left), len(right), len(matches))
        if is_interval:
            values = [interval_iou(left[i].start, left[i].end, right[j].start, right[j].end)
                      for i, j in matches]
            score["median_iou"] = float(np.median(values)) if values else None
        else:
            errors = [abs(left[i].start - right[j].start) * 1000 for i, j in matches]
            score["median_error_ms"] = float(np.median(errors)) if errors else None
            score["p95_error_ms"] = float(np.percentile(errors, 95)) if errors else None
        result[kind] = score
    return result


def score_section_labels(predicted: list[Section], reference: list[Section], duration: float) -> dict:
    """Compare labels only after geometry matching, never optimize matching to favor labels."""
    if duration <= 0 or not np.isfinite(duration):
        raise ValueError("音乐时长必须为有限正数")
    for sections in (predicted, reference):
        if any(section.end > duration for section in sections) or any(
                current.start < previous.end for previous, current in zip(sections, sections[1:])):
            raise ValueError("段落必须有序、互不重叠且不超出音频")
    neutral = {"", "unknown", "section", "unlabeled", "段落"}
    named = [section for section in predicted if section.label.strip().lower() not in neutral
             and not re.fullmatch(r"(?:段落\s*|section\s+)\d+", section.label.strip(), re.IGNORECASE)]
    edges = []
    for i, section in enumerate(named):
        for j, truth in enumerate(reference):
            iou = interval_iou(section.start, section.end, truth.start, truth.end)
            if iou + 1e-12 >= .7:
                edges.append((i, j, 1 - iou))
    matches = assignment(len(named), len(reference), edges)
    correct = sum(named[i].label == reference[j].label for i, j in matches)
    score = counts(len(named), len(reference), correct)
    score["geometry_matched"] = len(matches)
    score["named_time_coverage"] = sum(section.end - section.start for section in named) / duration
    score["reference_section_coverage"] = len(matches) / len(reference) if reference else None
    return score
