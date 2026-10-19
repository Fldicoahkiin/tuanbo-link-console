import numpy as np

from phrase_structure import feature_boundaries
from phrase_structure import rhythm_sections
from contracts import MusicLabels


def test_steady_features_do_not_create_periodic_cuts():
    assert feature_boundaries(np.ones((24, 64)), np.arange(65) * .5) == []


def test_sustained_timbre_changes_are_detected_within_one_tempo():
    features = np.ones((24, 48))
    features[:, 12:28] = 8
    features[:, 28:] = 3
    points = feature_boundaries(features, np.arange(49) * .5)
    assert [at for at, _ in points] == [6.0, 14.0]


def test_repeated_alternating_pulses_do_not_cut_each_beat():
    features = np.ones((24, 48))
    features[:, ::2] = 8
    assert feature_boundaries(features, np.arange(49) * .5) == []


def test_audio_sections_keep_continuous_beats_and_neutral_names(monkeypatch):
    import phrase_structure
    import pytest
    monkeypatch.setattr(phrase_structure, "refine_sections", lambda audio, rate, labels: labels)
    beats = [i * .5 for i in range(24)]
    models = [MusicLabels(beats=beats), MusicLabels(beats=[t for i, t in enumerate(beats) if i != 5]),
              MusicLabels(beats=[t + .01 for t in beats])]
    result = rhythm_sections(np.zeros((12000, 2)), 1000, models)
    assert len(result.beats) == 24
    assert result.sections[0].start == 0. and result.sections[0].end == 12.
    assert result.sections[0].label == "section"
    with pytest.raises(ValueError, match="三个"):
        rhythm_sections(np.zeros((12000, 2)), 1000, models[:2])
