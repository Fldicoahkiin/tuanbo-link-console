"""Codec timing acceptance with known pulses; not a music-recognition accuracy test."""

from pathlib import Path
import subprocess

import numpy as np
import pytest
from scipy.signal import correlate, correlation_lags
import soundfile as sf

from analyze import decode


FFMPEG = Path(__file__).resolve().parents[3] / "node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg.exe"


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("extension,codec", [("wav", "pcm_s16le"), ("mp3", "libmp3lame"),
                                           ("m4a", "aac"), ("flac", "flac")])
def test_gapless_containers_preserve_pulse_origin_and_spacing(tmp_path, rate, extension, codec):
    if not FFMPEG.is_file():
        pytest.skip("需要仓库固定的 Windows FFmpeg")
    signal = np.zeros((rate * 2, 2), dtype=np.float32)
    random = np.random.default_rng(20261008)
    for at in [0.35, 1.55]:
        count = round(0.055 * rate)
        pulse = random.normal(0, 0.15, count) * np.hanning(count)
        signal[round(at * rate):round(at * rate) + count, :] = pulse[:, None]
    original = tmp_path / "中文原声.wav"
    encoded = tmp_path / f"转换音源.{extension}"
    sf.write(original, signal, rate, subtype="PCM_16")
    subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-n",
                    "-i", str(original), "-c:a", codec, str(encoded)], check=True, capture_output=True)
    reference = tmp_path / "参考基准.wav"
    decoded = tmp_path / "分析基准.wav"
    decode(FFMPEG, original, reference, 48000)
    decode(FFMPEG, encoded, decoded, 48000)
    expected, expected_rate = sf.read(reference, always_2d=True)
    actual, actual_rate = sf.read(decoded, always_2d=True)
    assert expected_rate == actual_rate == 48000
    assert expected.shape[1] == actual.shape[1] == 2
    offsets = []
    for left, right in [(0.2, 0.7), (1.4, 1.9)]:
        start, stop = round(left * 48000), round(right * 48000)
        a, b = actual[start:stop, 0], expected[start:stop, 0]
        lag = int(correlation_lags(len(a), len(b))[np.argmax(correlate(a, b, method="fft"))])
        offsets.append(lag)
        assert abs(lag) <= 48, (extension, rate, "起点偏移超过 1ms", lag)
    assert abs(offsets[1] - offsets[0]) <= 48, (extension, rate, "脉冲间距漂移", offsets)
