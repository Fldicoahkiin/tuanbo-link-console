"""Pinned offline assets. Only prepare.py may download; inference fails closed."""

from __future__ import annotations

import hashlib
import json
import socket
import sys
from pathlib import Path
from typing import Literal

from pydantic import Field

from contracts import Digest, StrictModel


class Asset(StrictModel):
    path: str = Field(min_length=1)
    url: str = Field(pattern=r"^https://")
    sha256: Digest
    license: str = Field(min_length=1)
    provenance: str = Field(min_length=1)


class AssetManifest(StrictModel):
    version: Literal[1] = 1
    assets: list[Asset] = Field(min_length=1)


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def contained_path(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError("资源路径超出模型目录")
    return path


def verify_assets(bundle: Path, manifest_path: Path) -> str:
    manifest = AssetManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    seen: set[Path] = set()
    for asset in manifest.assets:
        path = contained_path(bundle, asset.path)
        if path in seen:
            raise ValueError(f"模型清单重复路径：{asset.path}")
        seen.add(path)
        if not path.is_file() or digest_file(path) != asset.sha256:
            raise ValueError(f"模型文件缺失或摘要不符：{asset.path}；未联网下载或切换引擎")
    return hashlib.sha256(manifest.model_dump_json().encode()).hexdigest()


def disable_network() -> None:
    """Python audit hook covers upstream urllib/requests/HF downloads too."""
    def audit(event: str, arguments: tuple[object, ...]) -> None:
        if event == "socket.connect":
            connection = arguments[0]
            if isinstance(connection, socket.socket) and connection.family in (socket.AF_INET, socket.AF_INET6):
                raise RuntimeError("离线音乐分析禁止网络连接；请在准备阶段下载并校验模型")
        if event == "socket.getaddrinfo":
            raise RuntimeError("离线音乐分析禁止 DNS 请求")
    sys.addaudithook(audit)


def write_json_exclusive(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
