import hashlib

import numpy as np
import pytest
import soundfile as sf

from contracts import AnalysisRun, AudioIdentity, MusicLabels, Timings
from review import create_review


def fixture_run(directory):
    pcm = np.zeros((144000, 2), dtype="<i2")
    sf.write(directory / "analysis.wav", pcm, 48000, subtype="PCM_16")
    result = AnalysisRun(run_id="audition", engine_fingerprint="a" * 64, device="cpu",
                         audio=AudioIdentity(source_sha256="b" * 64,
                                             pcm_sha256=hashlib.sha256(pcm.tobytes()).hexdigest(),
                                             sample_rate=48000, sample_count=len(pcm), channels=2),
                         timings=Timings(total_seconds=1., decode_seconds=.1, engine_seconds={}),
                         diagnostics={f"beat-this-final{i}": MusicLabels(beats=[1.], downbeats=[1.])
                                      for i in range(3)})
    (directory / "result.json").write_text(result.model_dump_json(), encoding="utf-8")


def test_click_uses_canonical_sample_time_without_new_delay(tmp_path):
    fixture_run(tmp_path)
    create_review(tmp_path, tmp_path / "review")
    mixed, rate = sf.read(tmp_path / "review/candidate-clicks.wav", dtype="int16", always_2d=True)
    nonzero = np.flatnonzero(mixed[:, 0])
    assert rate == 48000 and len(mixed) == 144000
    # The sine starts at zero; its first nonzero sample is exactly one sample later.
    assert nonzero[0] == 48001
    assert nonzero[-1] < 48000 + 1680
    assert np.array_equal(mixed[:, 0], mixed[:, 1])


def test_replaced_same_length_pcm_cannot_be_used_for_audition(tmp_path):
    fixture_run(tmp_path)
    sf.write(tmp_path / "analysis.wav", np.ones((144000, 2), dtype="int16"), 48000, subtype="PCM_16")
    with pytest.raises(ValueError, match="时间基准不符"):
        create_review(tmp_path, tmp_path / "review")
    assert not (tmp_path / "review").exists()
