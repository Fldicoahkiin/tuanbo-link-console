import json
from pathlib import Path
import subprocess
import sys

import pytest

from assets import contained_path, digest_file, verify_assets, write_json_exclusive


def test_missing_or_corrupt_asset_does_not_download(tmp_path):
    model = tmp_path / "model.ckpt"
    model.write_bytes(b"expected model")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(dict(version=1, assets=[dict(path="model.ckpt", sha256=digest_file(model),
                         url="https://invalid.example/model", license="MIT", provenance="test")])))
    assert len(verify_assets(tmp_path, manifest)) == 64
    model.write_bytes(b"truncated")
    with pytest.raises(ValueError, match="摘要不符"):
        verify_assets(tmp_path, manifest)


@pytest.mark.parametrize("relative", ["../outside", ".", "folder/../../outside"])
def test_asset_path_cannot_escape_bundle(tmp_path, relative):
    with pytest.raises(ValueError):
        contained_path(tmp_path, relative)


def test_offline_guard_catches_upstream_download_before_dns():
    script = "from assets import disable_network; import socket; disable_network(); socket.getaddrinfo('example.com',443)"
    result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1],
                            capture_output=True, timeout=10)
    assert result.returncode != 0
    assert b"RuntimeError" in result.stderr


def test_results_never_overwrite_existing_evidence(tmp_path):
    path = tmp_path / "result.json"
    write_json_exclusive(path, {"original": 1})
    with pytest.raises(FileExistsError):
        write_json_exclusive(path, {"replacement": 2})
    assert json.loads(path.read_text())["original"] == 1
