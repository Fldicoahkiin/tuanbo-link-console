"""Build a deterministic repeated-portrait fixture, not a multi-identity dataset."""
import argparse
from pathlib import Path
import cv2
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    image = cv2.imdecode(np.frombuffer(args.image.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Cannot decode fixture source")
    # The downloaded official sample is a tall portrait; crop to head/shoulders.
    cropped = image[:int(image.shape[0] * 0.55)]
    tile = cv2.resize(cropped, (410, 282), interpolation=cv2.INTER_AREA)
    paired = np.concatenate([tile, cv2.flip(tile, 1)], axis=1)
    valid, data = cv2.imencode(".png", paired)
    if not valid:
        raise RuntimeError("Fixture encoding failed")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data.tobytes())
    print("Created two regions from ONE repeated portrait; does not verify identity tracking")


if __name__ == "__main__":
    main()
