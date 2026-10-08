import pytest

from consensus import agreed_points


def test_retains_actual_median_model_prediction_without_averaging():
    assert agreed_points([[1., 2.], [1.01, 2.01], [1.02, 2.02]], .03) == [1.01, 2.01]


def test_rejects_opposite_phase_offsets_and_missing_model_beats():
    assert agreed_points([[1., 2.], [.975, 2.], [1.025]], .03) == []


def test_does_not_treat_double_time_as_additional_agreed_beats():
    assert agreed_points([[1., 2., 3.], [1., 1.5, 2., 2.5, 3.], [1., 2., 3.]], .03) == [1., 2., 3.]


def test_requires_three_models():
    with pytest.raises(ValueError):
        agreed_points([[1.], [1.]], .03)
