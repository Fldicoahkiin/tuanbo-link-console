from itertools import combinations, permutations

import numpy as np
import pytest

from contracts import Corpus, CorpusTrack
from evaluate import evaluate, match_points, score_points


def test_one_reference_cannot_be_matched_twice():
    score = score_points([.48, .51], [.5], .05)
    assert score.matched == 1
    assert score.precision == .5
    assert score.recall == 1
    assert score.median_error_ms == pytest.approx(10)


def test_cardinality_has_priority_over_nearest_point():
    assert match_points([.08, .16], [0., .1], .09) == [(0, 0), (1, 1)]


def test_silence_does_not_create_a_fictitious_100_percent_score():
    score = score_points([], [], .05)
    assert score.precision is None and score.recall is None
    assert score_points([], [.5], .05).recall == 0
    assert score_points([.5], [], .05).precision == 0


def test_matcher_agrees_with_exhaustive_small_examples():
    rng = np.random.default_rng(100)
    for _ in range(30):
        predicted = sorted(rng.random(4).tolist())
        reference = sorted(rng.random(3).tolist())
        candidates = []
        for count in range(4):
            for left in combinations(range(4), count):
                for right in permutations(range(3), count):
                    errors = [abs(predicted[i] - reference[j]) for i, j in zip(left, right)]
                    if all(error <= .15 for error in errors):
                        candidates.append((-count, sum(errors)))
        best = min(candidates)
        matches = match_points(predicted, reference, .15)
        assert -len(matches) == best[0]
        assert sum(abs(predicted[i] - reference[j]) for i, j in matches) == pytest.approx(best[1])


def test_unlabelled_video_is_not_a_pass():
    corpus = Corpus(tracks=[CorpusTrack(id="video", family="video", genre="dj", split="test",
                                        audio_path="video.mp4", source_sha256="a" * 64, duration=51.)])
    report = evaluate(corpus, {}, "beat-this-final0")
    assert report["status"] == "not-validated"
    assert report["enabled_capabilities"] == []
    assert len(report["blockers"]) >= 4
