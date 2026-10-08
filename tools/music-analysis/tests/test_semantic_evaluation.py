import pytest

from contracts import Event, Section
from semantic_evaluation import assignment, score_events, score_section_labels


def test_duplicate_events_do_not_inflate_precision():
    score = score_events([Event(kind="hit", start=1.), Event(kind="hit", start=1.)],
                         [Event(kind="hit", start=1.)])["hit"]
    assert score["matched"] == 1 and score["precision"] == .5 and score["recall"] == 1


def test_wrong_event_class_is_false_positive_and_miss():
    scores = score_events([Event(kind="drop", start=1.)], [Event(kind="hit", start=1.)])
    assert scores["drop"]["precision"] == 0 and scores["hit"]["recall"] == 0


def test_point_tolerance_is_inclusive_and_not_applied_to_intervals():
    scores = score_events([Event(kind="drop", start=1.08), Event(kind="last", start=2.081)],
                          [Event(kind="drop", start=1.), Event(kind="last", start=2.)])
    assert scores["drop"]["matched"] == 1 and scores["last"]["matched"] == 0


def test_short_roll_inside_long_roll_is_not_a_match():
    score = score_events([Event(kind="roll", start=0., end=1.)],
                         [Event(kind="roll", start=0., end=10.)])["roll"]
    assert score["matched"] == 0


def test_interval_boundary_iou_and_one_to_one_assignment():
    score = score_events([Event(kind="build", start=0., end=7.), Event(kind="build", start=0., end=7.)],
                         [Event(kind="build", start=0., end=10.)])["build"]
    assert score["matched"] == 1 and score["median_iou"] == pytest.approx(.7)
    assert score["precision"] == .5


def test_assignment_prioritizes_cardinality_and_validates_costs():
    assert assignment(2, 2, [(0, 0, 0.), (0, 1, .9), (1, 0, .9)]) == [(0, 1), (1, 0)]
    with pytest.raises(ValueError):
        assignment(1, 1, [(0, 0, float("nan"))])


def test_wrong_labels_and_neutral_sections_have_separate_coverage():
    predictions = [Section(start=0., end=5., label="chorus"), Section(start=5., end=10., label="段落 2")]
    reference = [Section(start=0., end=5., label="verse"), Section(start=5., end=10., label="chorus")]
    score = score_section_labels(predictions, reference, 10.)
    assert score["precision"] == 0 and score["named_time_coverage"] == .5
    assert score["geometry_matched"] == 1 and score["reference_section_coverage"] == .5


def test_empty_predictions_are_misses_without_fictitious_perfect_precision():
    scores = score_events([], [Event(kind="last", start=1.)])
    assert scores["last"]["recall"] == 0 and scores["last"]["precision"] is None
    assert scores["drop"]["precision"] is None and scores["drop"]["recall"] is None
    labels = score_section_labels([], [Section(start=0., end=2., label="verse")], 2.)
    assert labels["recall"] == 0 and labels["named_time_coverage"] == 0


def test_neutral_numbered_labels_are_not_named_and_coverage_cannot_exceed_duration():
    neutral = [Section(start=0., end=1., label="段落1"), Section(start=1., end=2., label="section 2")]
    assert score_section_labels(neutral, [], 2.)["named_time_coverage"] == 0
    with pytest.raises(ValueError):
        score_section_labels([Section(start=0., end=3., label="verse")], [], 2.)
    with pytest.raises(ValueError):
        score_section_labels([Section(start=0., end=2., label="verse"),
                              Section(start=1., end=3., label="chorus")], [], 3.)
