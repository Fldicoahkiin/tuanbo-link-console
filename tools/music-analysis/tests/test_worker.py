from pathlib import Path
from uuid import uuid4

import pytest

from assets import digest_file
from contracts import AnalysisRun, AudioIdentity, MusicLabels, Timings
from worker import WorkerRequest, execute


def request_for(tmp_path):
    audio = tmp_path / "中文音源.wav"
    audio.write_bytes(b"sample")
    return WorkerRequest(version=1, task_id=uuid4(), audio=str(audio), source_sha256=digest_file(audio),
                         bundle=str(tmp_path / "models"), ffmpeg=str(tmp_path / "ffmpeg.exe"),
                         output=str(tmp_path / "output"), cache=str(tmp_path / "cache"),
                         cancel_file=str(tmp_path / "cancel"), device="cpu")


def test_worker_isolates_library_stdout_and_preserves_unvalidated_gate(tmp_path, capsys):
    request = request_for(tmp_path)
    events = []

    def runner(args, on_progress):
        print("third-party progress")
        on_progress("beat-this-final0")
        assert args.device == "cpu"
        return AnalysisRun(run_id=str(uuid4()), engine_fingerprint="a" * 64, device="cpu",
                           audio=AudioIdentity(source_sha256=request.source_sha256, pcm_sha256="b" * 64,
                                               sample_rate=48000, sample_count=48000, channels=2),
                           diagnostics={"silence-guard": MusicLabels()},
                           timings=Timings(total_seconds=1., decode_seconds=.1, engine_seconds={}))

    assert execute(request, events.append, runner) == 0
    assert [event["type"] for event in events] == ["progress", "result"]
    assert all(event["taskId"] == str(request.task_id) for event in events)
    assert events[-1]["result"]["enabled_capabilities"] == []
    captured = capsys.readouterr()
    assert captured.out == "" and "third-party progress" in captured.err


def test_worker_rejects_replaced_audio_before_inference(tmp_path):
    request = request_for(tmp_path)
    Path(request.audio).write_bytes(b"changed")
    events = []

    def never_run(*args, **kwargs):
        raise AssertionError("must not start inference")

    assert execute(request, events.append, never_run) == 1
    assert events[-1]["type"] == "error"
    assert "音源已改变" in events[-1]["message"]


def test_worker_cancellation_has_no_result(tmp_path):
    request = request_for(tmp_path)
    events = []

    def cancelled(*args, **kwargs):
        raise KeyboardInterrupt

    assert execute(request, events.append, cancelled) == 130
    assert [event["type"] for event in events] == ["cancelled"]


def test_worker_refuses_relative_paths_and_unknown_fields(tmp_path):
    data = request_for(tmp_path).model_dump()
    data["audio"] = "../source.wav"
    with pytest.raises(ValueError):
        WorkerRequest.model_validate(data)
    data = request_for(tmp_path).model_dump()
    data["auto_download"] = True
    with pytest.raises(ValueError):
        WorkerRequest.model_validate(data)
