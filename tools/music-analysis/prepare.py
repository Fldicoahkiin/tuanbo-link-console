"""Explicit online preparation, separate from the offline inference entry point.

First download records hashes for research, not a trusted release signature. A release
must ship the reviewed manifest and all third-party notices, never run this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FOLDS = [
    ("0-0vra4ys2", "0db596dfb0995f41d62f6267d76a9d54c046f1649bd35e1dbeca0c5f9a7b8acd"),
    ("1-3ozjhtsj", "607b4864eaabccd4f6951410d5ea6676666ad1cfa6ce2e18bc99f3824b77c3b7"),
    ("2-gmgo0nsy", "67c28ec7ca612d365e5fcb152f6530eb53e34c4303940afb30fd17a295c958a4"),
    ("3-i92b7m8p", "446d05672b2669cdb7d9b8bbbc228a4f3592484335a7995cca89a744e3950ddc"),
    ("4-1bql5qo0", "96327222ab9b33c005388b788ba602f529aa03cc4dde1c859c011f1004490493"),
    ("5-x4z5zeef", "c87f162a1090290bcbb863688746784919cf912c56744fb3d81a1a7dba3b114e"),
    ("6-x7t226rq", "13e7e639bf30fcd3fa049ad863088773a4e57b06d7c68581385b3ef625c60688"),
    ("7-qwwskhg6", "b888b7fba95efa3d5a37ca013fe7efe2741621ea9ca335e6b2723e4fd0fade57"),
]


def download(bundle: Path, item: tuple[str, str, str | None, str, str], resume: bool = False) -> dict[str, str]:
    relative, url, expected, license_name, provenance = item
    target = bundle / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".partial")
    if target.exists():
        with target.open("rb") as stream:
            existing_digest = hashlib.file_digest(stream, "sha256").hexdigest()
        valid = zipfile.is_zipfile(target) and (expected is None or existing_digest == expected)
        if not valid:
            if not resume:
                raise ValueError(f"资源损坏：{relative}；需显式 --resume 重新准备")
            if not target.resolve().is_relative_to(bundle.resolve()):
                raise ValueError("模型目录越界")
            if partial.exists():
                raise ValueError(f"已有另一份未完成下载：{partial}")
            target.rename(partial)
    if not target.exists():
        offset = partial.stat().st_size if resume and partial.exists() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=120) as response:
            if offset and (response.status != 206 or
                           not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-")):
                raise ValueError(f"服务器不支持准确续传：{relative}")
            expected_size = int(response.headers["Content-Length"])
            received = 0
            with partial.open("ab" if offset else "xb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    received += len(chunk)
        if received != expected_size:
            raise ValueError(f"模型下载不完整：{relative} ({received}/{expected_size})；未自动重试")
        with partial.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if expected is not None and digest != expected:
            raise ValueError(f"模型摘要不符：{relative}")
        if not zipfile.is_zipfile(partial):
            raise ValueError(f"模型归档损坏：{relative}")
        partial.rename(target)
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if expected is not None and digest != expected:
        raise ValueError(f"模型摘要不符：{relative}")
    if not zipfile.is_zipfile(target):
        raise ValueError(f"模型归档损坏：{relative}")
    print(f"准备完成：{relative} ({target.stat().st_size} bytes)", flush=True)
    return dict(path=relative, url=url, sha256=digest, license=license_name, provenance=provenance)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--resume", action="store_true", help="Explicitly resume incomplete downloads once")
    parser.add_argument("--only", help="Prepare one exact relative asset path; does not write a manifest")
    args = parser.parse_args()
    jobs = []
    for index in range(3):
        jobs.append((
            f"beat-this/final{index}.ckpt",
            f"https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final{index}.ckpt",
            None, "MIT", "https://github.com/CPJKU/beat_this",
        ))
    for name, digest in FOLDS:
        filename = f"harmonix-fold{name}.pth"
        jobs.append((
            f"all-in-one/{filename}",
            f"https://huggingface.co/taejunkim/allinone/resolve/main/{filename}", digest,
            "UNRESOLVED: author MIT; community config CC-BY-NC-SA-4.0",
            "https://huggingface.co/taejunkim/allinone",
        ))
    jobs.append((
        "demucs/955717e8-8726e21a.th",
        "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th",
        "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
        "MIT", "https://github.com/facebookresearch/demucs",
    ))
    if args.only:
        jobs = [job for job in jobs if job[0] == args.only]
        if not jobs:
            raise ValueError("未知模型资源")
    with ThreadPoolExecutor(max_workers=4) as pool:
        assets = list(pool.map(lambda item: download(args.bundle, item, args.resume), jobs))
    if args.only:
        return
    with (args.bundle / "manifest.json").open("x", encoding="utf-8") as output:
        json.dump({"version": 1, "assets": assets}, output, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
