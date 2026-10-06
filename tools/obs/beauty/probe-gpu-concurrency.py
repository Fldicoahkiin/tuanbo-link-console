"""Isolate GPU session thread affinity and cross-model concurrency failures."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys

import cv2
import numpy as np
from directml_segmentation import DirectMLFaceSegmentation
from directml_proposals import DirectMLProposals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['main','thread','parallel'], required=True)
    args = parser.parse_args()
    work = Path('artifacts/beauty-prototype')
    sys.path.insert(0,str((work/'gpu-probe-deps').resolve()))
    rgb = cv2.imdecode(np.frombuffer((work/'face-segmentation-clc958q0/4000-source.png').read_bytes(),dtype=np.uint8),1)[:,:,::-1].copy()
    with DirectMLFaceSegmentation((work/'selfie_multiclass_256x256.onnx').read_bytes()) as semantic, \
            DirectMLProposals((work/'face_detection_yunet_2023mar.onnx').read_bytes()) as proposal, ThreadPoolExecutor(2) as pool:
        def sequential():
            semantic.analyze(rgb)
            proposal.locate(rgb)

        for index in range(200):
            if args.mode == 'main':
                sequential()
            elif args.mode == 'thread':
                pool.submit(sequential).result()
            else:
                first = pool.submit(semantic.analyze,rgb)
                second = pool.submit(proposal.locate,rgb)
                first.result()
                second.result()
            print(f'{args.mode}: {index+1}',flush=True)


if __name__ == '__main__':
    main()
