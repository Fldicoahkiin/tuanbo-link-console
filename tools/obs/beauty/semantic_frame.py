"""Aspect-preserving semantic input and exact source-coordinate restoration."""
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class SemanticFrame:
    pixels: np.ndarray
    source_shape: tuple
    bounds: tuple
    offset: tuple

    def restore(self, confidence):
        edge = self.pixels.shape[0]
        if confidence.shape != (edge, edge) or confidence.dtype != np.float32:
            raise ValueError('Invalid semantic output dimensions or dtype')
        top, bottom, left, right = self.bounds
        y, x = self.offset
        output = np.zeros(self.source_shape, dtype=np.float32)
        output[top:bottom, left:right] = confidence[y:y+bottom-top, x:x+right-left]
        return output


def prepare_frame(rgb):
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8 or not all(0 < size <= 640 for size in rgb.shape[:2]):
        raise ValueError('Semantic input must be bounded uint8 RGB')
    # Remove only exactly black outer borders, retaining all nonzero dark pixels.
    occupied = np.any(rgb != 0, axis=2)
    rows = np.flatnonzero(np.any(occupied, axis=1))
    if not rows.size:
        return None
    columns = np.flatnonzero(np.any(occupied, axis=0))
    top, bottom = int(rows[0]), int(rows[-1])+1
    left, right = int(columns[0]), int(columns[-1])+1
    height, width = bottom-top, right-left
    edge = max(height, width)
    y, x = (edge-height)//2, (edge-width)//2
    square = np.zeros((edge, edge, 3), dtype=np.uint8)
    square[y:y+height, x:x+width] = rgb[top:bottom, left:right]
    return SemanticFrame(square, rgb.shape[:2], (top, bottom, left, right), (y, x))


def analysis_frames(rgb):
    """Whole active content plus two overlapping contextual views, same frame."""
    frame = prepare_frame(rgb)
    if frame is None:
        return []
    top, bottom, left, right = frame.bounds
    height, width = bottom-top, right-left
    if width >= height:
        crops = [(top, bottom, left, left+round(width*.625)),
                 (top, bottom, left+round(width*.375), right)]
    else:
        crops = [(top, top+round(height*.625), left, right),
                 (top+round(height*.375), bottom, left, right)]
    frames = [frame]
    seen = {frame.bounds}
    for y0, y1, x0, x1 in crops:
        if y1 <= y0 or x1 <= x0:
            continue
        local = prepare_frame(rgb[y0:y1, x0:x1])
        if local is None:
            continue
        t, b, l, r = local.bounds
        bounds = (t+y0, b+y0, l+x0, r+x0)
        if bounds in seen:
            continue
        seen.add(bounds)
        frames.append(SemanticFrame(local.pixels, rgb.shape[:2], bounds, local.offset))
    return frames
