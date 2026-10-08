import argparse
import hashlib
import json

import pytest

import analyze
from contracts import AnalysisRun, AudioIdentity, MusicLabels, Timings


@pytest.fixture
def cached_run(tmp_path, monkeypatch):
    audio = tmp_path / "song.wav"
    audio.write_bytes(b"fixture")
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffmpeg.write_bytes(b"fixture decoder")
    fingerprint = "a" * 64
    monkeypatch.setattr(analyze, "fingerprint", lambda *_: fingerprint)
    monkeypatch.setattr(analyze, "disable_network", lambda: None)
    digest = hashlib.sha256(audio.read_bytes()).hexdigest()
    cached = AnalysisRun(run_id="earlier", engine_fingerprint=fingerprint, device="cpu",
                         audio=AudioIdentity(source_sha256=digest, pcm_sha256="b" * 64,
                                             sample_rate=48000, sample_count=48000, channels=2),
                         timings=Timings(total_seconds=100., decode_seconds=1., engine_seconds={}),
                         diagnostics={"silence-guard": MusicLabels()})
    cache = tmp_path / "cache"
    cache.mkdir()
    path = cache / f"{digest}-{fingerprint}.json"
    path.write_text(cached.model_dump_json(), encoding="utf-8")
    args = argparse.Namespace(audio=audio, ffmpeg=ffmpeg, bundle=tmp_path, output=tmp_path / "run",
                              device="cpu", engines="full", cache=cache, cancel_file=None)
    return args, path


def test_cache_hit_skips_heavy_inference_and_keeps_research_gate(cached_run):
    args, _ = cached_run
    result = analyze.run(args)
    assert result.timings.cached
    assert result.publication == "not-validated"
    assert result.enabled_capabilities == []
    assert (args.output / "consensus.json").is_file()


def test_wrong_identity_is_an_error_not_an_automatic_rerun(cached_run):
    args, path = cached_run
    data = json.loads(path.read_text(encoding="utf-8"))
    data["engine_fingerprint"] = "c" * 64
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="缓存身份不符"):
        analyze.run(args)
    assert not (args.output / "result.json").exists()


def test_corrupt_cache_is_not_silently_accepted(cached_run):
    args, path = cached_run
    path.write_text("{", encoding="utf-8")
    with pytest.raises(ValueError):
        analyze.run(args)


def test_cancelled_job_never_commits_a_cached_result(cached_run):
    args, _ = cached_run
    args.cancel_file = args.output.parent / "cancel"
    args.cancel_file.touch()
    with pytest.raises(KeyboardInterrupt):
        analyze.run(args)
    assert not (args.output / "result.json").exists()


def test_cancellation_during_consensus_does_not_commit(cached_run, monkeypatch):
    import consensus
    args, _ = cached_run
    args.cancel_file = args.output.parent / "cancel"

    def cancel(_):
        args.cancel_file.touch()
        return {"publication": "not-validated"}

    monkeypatch.setattr(consensus, "summarize", cancel)
    with pytest.raises(KeyboardInterrupt):
        analyze.run(args)
    assert not (args.output / "result.json").exists()
