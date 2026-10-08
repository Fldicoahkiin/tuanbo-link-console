"""Offline installed-package and attention-fixture verification, including Windows paths.

This is operator-level evidence only, not full upstream inference parity or music accuracy.
The source checkout and fixture must already exist; nothing is downloaded or installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from assets import digest_file, disable_network, write_json_exclusive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("报告路径已存在；请保留旧证据并指定新路径")
    disable_network()
    import allin1_infer
    import torch
    from allin1_infer.models import neighborhood_attention as attention

    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用，未切换 CPU")
    package = Path(allin1_infer.__file__).resolve().parent
    if not package.is_relative_to(Path(sys.prefix).resolve()):
        raise ValueError("必须检查隔离环境中实际安装的包")
    source = args.source.resolve()
    baseline_path = source / "tests/fixtures/delivery_baseline.json"
    fixture_path = source / "tests/fixtures/natten_0_17_5_golden.pt"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    expected = {name.removeprefix("src/allin1_infer/"): value
                for name, value in baseline["source_sha256"].items()}
    paths = [path for path in package.rglob("*") if path.is_file() and path.suffix in (".py", ".toml")]
    installed = {path.relative_to(package).as_posix(): digest_file(path) for path in paths}
    exceptions = ("checkpoints.py", "session.py")
    addition = b"from __future__ import annotations\n\n"
    for name in exceptions:
        data = (package / name).read_bytes()
        if data.count(addition) != 1 or data != (source / "src/allin1_infer" / name).read_bytes():
            raise ValueError(f"已安装注解兼容文件不符合固定源码：{name}")
        installed[name] = hashlib.sha256(data.replace(addition, b"", 1)).hexdigest()
    if installed != expected:
        raise ValueError("已安装源码与固定基线不同，拒绝报告一致性")
    fixture_hash = digest_file(fixture_path)
    if fixture_hash != baseline["fixture_sha256"]["tests/fixtures/natten_0_17_5_golden.pt"]:
        raise ValueError("NATTEN 参考张量摘要不符")
    torch.set_num_threads(1)
    fixture = torch.load(fixture_path, weights_only=True, map_location=args.device)
    fields = []
    with torch.inference_mode():
        for dimension in ("1d", "2d"):
            qk = getattr(attention, "na" + dimension + "_qk")
            av = getattr(attention, "na" + dimension + "_av")
            for index, case in enumerate(fixture[dimension]):
                kernel, dilation = case["kernel_size"], case["dilation"]
                actual = {
                    "attn": qk(case["q"], case["k"], kernel, dilation, rpb=case["rpb"]),
                    "attn_norpb": qk(case["q"], case["k"], kernel, dilation),
                    "out": av(torch.softmax(case["attn"], -1), case["v"], kernel, dilation),
                }
                for name, value in actual.items():
                    reference = case[name]
                    torch.testing.assert_close(value, reference, atol=1e-5, rtol=1e-5)
                    delta = (value - reference).double()
                    fields.append({"dimension": dimension, "case": index, "field": name,
                                   "max_abs": float(delta.abs().max()),
                                   "rms": float(delta.square().mean().sqrt())})
    if len(fields) != 24:
        raise ValueError("参考张量字段数量不符合固定的 24 项基线")
    report = {
        "scope": "installed package bytes and NATTEN recorded operator fixtures only",
        "upstream_full_inference_parity": False, "music_accuracy_validated": False,
        "passed": True, "device": args.device, "torch": torch.__version__,
        "package": str(package), "package_version": allin1_infer.__version__,
        "verified_files": len(installed), "annotation_only_exceptions": exceptions,
        "fixture_sha256": fixture_hash, "baseline_sha256": digest_file(baseline_path),
        "verifier_sha256": digest_file(Path(__file__)),
        "atol": 1e-5, "rtol": 1e-5, "fields": fields,
    }
    write_json_exclusive(args.output, report)
    print(f"{args.device}: 30 个安装文件、24 项算子参考通过；不代表整曲原版一致性或精度")


if __name__ == "__main__":
    main()
