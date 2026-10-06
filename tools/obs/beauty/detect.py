"""Offline feasibility probe. Reads an image file, never a camera or live output."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import cv2
import mediapipe as mp
from landmarks import POINT_IDS


def face_region(points):
    # The ellipse bounds local warps; the complete mesh supplies feature contours.
    # A mesh is not an occlusion or skin segmentation mask.
    oval = [points[i] for i in (10, 152, 234, 454)]
    x0, x1 = min(p.x for p in oval), max(p.x for p in oval)
    y0, y1 = min(p.y for p in oval), max(p.y for p in oval)
    left = ((points[33].x + points[133].x) / 2, (points[33].y + points[133].y) / 2)
    right = ((points[362].x + points[263].x) / 2, (points[362].y + points[263].y) / 2)
    # Leave a margin for contour displacement to fade before the region boundary.
    return dict(cx=(x0 + x1) / 2, cy=(y0 + y1) / 2, rx=min(0.5, (x1 - x0) * 0.60), ry=min(0.5, (y1 - y0) * 0.56),
                lx=left[0], ly=left[1], ex=right[0], ey=right[1],
                smooth=0.5, white=0.25, slim=0.5, eye=0.4,
                **{f"p{point}{axis}": getattr(points[point], axis) for point in POINT_IDS for axis in "xy"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-faces", type=int, default=6, choices=range(1, 7))
    args = parser.parse_args()
    expected = json.loads(Path(__file__).with_name("assets.json").read_text(encoding="utf-8"))["model"]["sha256"]
    model = args.model.read_bytes()
    if hashlib.sha256(model).hexdigest() != expected:
        raise ValueError("Face model SHA-256 mismatch; refusing an incomplete or different model")
    # imdecode supports Windows paths containing Chinese characters.
    import numpy as np
    bgr = cv2.imdecode(np.frombuffer(args.image.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Cannot decode image: {args.image}")
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_buffer=model),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, num_faces=args.max_faces)
    started = time.perf_counter()
    with mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
        loaded = time.perf_counter()
        result = detector.detect(image)
        finished = time.perf_counter()
    faces = sorted((face_region(points) for points in result.face_landmarks), key=lambda face: face["cx"])
    packet = dict(version=3, mode="static-fixture", faces=faces)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(packet, ensure_ascii=False, indent=2), encoding="utf-8")
    report = dict(image=str(args.image), width=bgr.shape[1], height=bgr.shape[0], faces=len(faces),
                  load_ms=round((loaded-started)*1000, 2), inference_ms=round((finished-loaded)*1000, 2),
                  model_sha256=hashlib.sha256(model).hexdigest(),
                  scope="offline still image; no identity tracking, live transport or body processing")
    args.output.with_suffix(".report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if not faces:
        raise SystemExit("No faces detected; no usable fixture generated")


if __name__ == "__main__":
    main()
