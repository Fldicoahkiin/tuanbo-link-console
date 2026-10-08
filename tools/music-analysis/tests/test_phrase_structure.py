import numpy as np

from phrase_structure import feature_boundaries


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
