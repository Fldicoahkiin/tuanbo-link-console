import pytest
from pydantic import ValidationError

from contracts import AnalysisRun, AudioIdentity, Corpus, CorpusTrack, MusicLabels, Reference, Section, Timings


def track(identifier="a", digest="a" * 64, split="train"):
    return CorpusTrack(id=identifier, family="same-song", genre="dj", split=split,
                       source_sha256=digest, duration=51.0, audio_path="input.wav")


def test_same_song_edits_cannot_leak_to_blind_test():
    with pytest.raises(ValidationError, match="不能跨"):
        Corpus(tracks=[track(), track("b", "b" * 64, "test")])


def test_duplicate_audio_cannot_inflate_corpus():
    with pytest.raises(ValidationError, match="重复"):
        Corpus(tracks=[track(), track("b")])


def test_two_different_reviewers_required():
    with pytest.raises(ValidationError):
        Reference(labels=MusicLabels(), reviewers=["a", " a "], reviewed=True, rhythm_audit_passed=True)


@pytest.mark.parametrize("beats", [[.2, .2], [.2, .1], [float("nan")], [-.1]])
def test_bad_points_rejected(beats):
    with pytest.raises(ValidationError):
        MusicLabels(beats=beats)


def test_overlapping_sections_rejected():
    with pytest.raises(ValidationError):
        MusicLabels(sections=[Section(start=0., end=2., label="verse"),
                              Section(start=1., end=3., label="chorus")])


def test_research_outputs_cannot_be_published_or_exceed_duration():
    data = dict(run_id="id", engine_fingerprint="b" * 64, device="cpu",
                audio=AudioIdentity(source_sha256="a" * 64, pcm_sha256="b" * 64,
                                    sample_rate=48000, sample_count=48000, channels=2),
                timings=Timings(total_seconds=2., decode_seconds=.1, engine_seconds={}),
                diagnostics={"model": MusicLabels(beats=[.5])})
    assert AnalysisRun(**data).enabled_capabilities == []
    with pytest.raises(ValidationError):
        AnalysisRun(**data, enabled_capabilities=["beats"])
    with pytest.raises(ValidationError):
        AnalysisRun(**data, publication="approved")
    data["diagnostics"] = {"model": MusicLabels(beats=[1.1])}
    with pytest.raises(ValidationError):
        AnalysisRun(**data)


def test_unknown_fields_are_not_silently_stripped():
    with pytest.raises(ValidationError):
        MusicLabels.model_validate({"beats": [], "sneaky_tempo_map": []})
