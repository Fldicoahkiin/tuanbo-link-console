"""Refine model sections at audible, beat-synchronous feature changes.

No fixed beat-count cuts: constant/repeated features produce no extra boundary.
This is an editable estimate, not semantic ground truth or a Cue generator.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks

from contracts import MusicLabels, Section


def rhythm_sections(audio: np.ndarray, sample_rate: int, models: list[MusicLabels]) -> MusicLabels:
    """Use a continuous supported beat clock and acoustic changes, without vocal separation."""
    from bisect import bisect_left

    if len(models) != 3:
        raise ValueError("分段需要完整的三个节拍模型结果")

    def nearest(points: list[float], at: float) -> float:
        index = bisect_left(points, at)
        return min(points[max(0, index - 1):index + 1], key=lambda value: abs(value - at), default=float("inf"))

    def agreement(a: list[float], b: list[float]) -> float:
        return (sum(abs(nearest(b, at) - at) <= .07 for at in a)
                + sum(abs(nearest(a, at) - at) <= .07 for at in b)) / max(1, len(a) + len(b))

    reference = max(models, key=lambda model: sum(agreement(model.beats, other.beats) for other in models))
    beats = []
    for at in reference.beats:
        votes = sorted(value for model in models if abs((value := nearest(model.beats, at)) - at) <= .07)
        point = votes[len(votes) // 2] if len(votes) >= 2 else at
        if not beats or point > beats[-1]:
            beats.append(point)
    duration = len(audio) / sample_rate
    return refine_sections(audio, sample_rate, MusicLabels(beats=beats, sections=[Section(start=0., end=duration, label="section")]))


def feature_boundaries(features: np.ndarray, edges: np.ndarray) -> list[tuple[float, float]]:
    """Compare two beats on each side; require a sustained feature discontinuity."""
    if features.shape[1] < 6:
        return []
    scale = np.maximum(np.percentile(features, 90, axis=1) - np.percentile(features, 10, axis=1), 1.0)
    normalized = features / scale[:, None]
    novelty = np.zeros(features.shape[1])
    for index in range(2, features.shape[1] - 2):
        left, right = normalized[:, index - 2:index], normalized[:, index:index + 2]
        difference = np.mean(np.abs(left.mean(axis=1) - right.mean(axis=1)))
        within = (np.mean(np.abs(left[:, 1] - left[:, 0])) + np.mean(np.abs(right[:, 1] - right[:, 0]))) / 2
        novelty[index] = max(0.0, difference - within * .45)
    center = float(np.median(novelty))
    spread = float(np.median(np.abs(novelty - center)))
    peaks, _ = find_peaks(novelty, height=max(.12, center + spread * 1.5), prominence=max(.06, spread), distance=2)
    return [(float(edges[index]), float(novelty[index])) for index in peaks]


def refine_sections(audio: np.ndarray, sample_rate: int, labels: MusicLabels) -> MusicLabels:
    import librosa

    duration = len(audio) / sample_rate
    beats = np.array(labels.beats, dtype=float)
    if len(beats) < 6 or not labels.sections:
        return labels
    # Downsample before spectral features; keep the original timeline origin.
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    rate, hop = 12000, 120
    mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=rate)
    power = librosa.feature.melspectrogram(y=mono, sr=rate, hop_length=hop, n_fft=1024, n_mels=24)
    log_power = librosa.power_to_db(power, ref=1.0, top_db=80)
    onset = librosa.onset.onset_strength(S=log_power, sr=rate, hop_length=hop)
    edges = np.unique(np.concatenate(([0.0], beats[(beats > 0) & (beats < duration)], [duration])))
    frames = np.clip(np.rint(edges * rate / hop).astype(int), 0, log_power.shape[1])
    features = []
    for start, end in zip(frames, frames[1:]):
        end = max(start + 1, end)
        spectral = log_power[:, start:end].mean(axis=1)
        pulse = onset[start:end]
        features.append(np.concatenate((spectral, [float(np.mean(pulse)) * 4, float(np.max(pulse)) * 2])))
    proposals = feature_boundaries(np.stack(features, axis=1), edges)
    min_gap = max(1.5, float(np.median(np.diff(beats))) * 4)
    refined = []
    for section in labels.sections:
        cuts = [section.start, section.end]
        for at, score in sorted(proposals, key=lambda item: item[1], reverse=True):
            if section.start < at < section.end and all(abs(at - cut) >= min_gap for cut in cuts):
                cuts.append(at)
        cuts.sort()
        refined.extend(Section(start=float(start), end=float(end), label=section.label)
                       for start, end in zip(cuts, cuts[1:]))
    return labels.model_copy(update={"sections": refined})
