"""Experimental NumPy/OpenCV decoding of the pinned RTMDet-Ins-tiny heads.

Keeps class-aware NMS and the global detection limit before selecting people.
Not enabled in the shipping worker until real-frame parity is verified.
"""
import math

import cv2
import numpy as np


def prepare_image(bgr):
    if bgr.dtype != np.uint8 or bgr.ndim != 3 or bgr.shape[2] != 3 or min(bgr.shape[:2]) < 1:
        raise ValueError('Expected a nonempty uint8 BGR image')
    height, width = bgr.shape[:2]
    ratio = 640 / max(height, width)
    resized_w, resized_h = int(width * ratio + .5), int(height * ratio + .5)
    resized = cv2.resize(bgr, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
    normalized = np.empty((3,640,640),dtype=np.float32)
    mean=np.array([103.53,116.28,123.675],dtype=np.float32)
    deviation=np.array([57.375,57.12,58.395],dtype=np.float32)
    for channel in range(3):
        normalized[channel].fill((np.float32(114)-mean[channel])/deviation[channel])
        target=normalized[channel,:resized_h,:resized_w]
        np.subtract(resized[:,:,channel],mean[channel],out=target,dtype=np.float32)
        np.divide(target,deviation[channel],out=target)
    metadata = {'ori_shape': (height, width), 'img_shape': (640, 640),
                'scale_factor': (resized_w / width, resized_h / height)}
    return np.ascontiguousarray(normalized[None]), metadata


def restoration_extent(output_size, visible_size):
    # Both resizes must retain their exact scale. A crop aligned to this
    # period preserves the 8x first resize and 640/output_size second resize.
    period=math.lcm(8,640//math.gcd(640,output_size))
    last_source=(visible_size-.5)*640/output_size-.5
    # Four source pixels cover the first resize's half-pixel boundary;
    # two more retain the second resize's interpolation neighbour.
    extent=min(640,math.ceil((last_source+6)/period)*period)
    return extent,extent*output_size//640


def decode_people(raw, metadata):
    shapes = [(1, channels, size, size) for channels in (80, 4, 169) for size in (80, 40, 20)] + [(1, 8, 80, 80)]
    if len(raw) != len(shapes) or any(item.shape != shape or item.dtype != np.float32 or not np.isfinite(item).all() for item, shape in zip(raw, shapes)):
        raise ValueError('Unexpected RTMDet raw head shape, type or nonfinite value')
    boxes, scores, labels, kernels, priors = [], [], [], [], []
    image_h, image_w = metadata['img_shape'][:2]
    scale = np.array(metadata['scale_factor'], dtype=np.float32)
    for level, stride in enumerate((8, 16, 32)):
        logits = raw[level][0].transpose(1, 2, 0).reshape(-1, 80)
        # sigmoid(logit) can exceed .5 only for positive logits. Evaluate the
        # expensive exponential only for candidates, then retain the exact
        # float32 probability threshold (tiny positive logits can round to .5).
        anchors, classes = np.nonzero(logits > 0)
        values = 1 / (1 + np.exp(-np.clip(logits[anchors,classes],-80,80)))
        passing=values>.5
        anchors,classes,values=anchors[passing],classes[passing],values[passing]
        order = np.argsort(-values, kind='stable')[:1000]
        anchors, classes, values = anchors[order], classes[order], values[order]
        width = raw[level].shape[3]
        points = np.stack((anchors % width, anchors // width), axis=1).astype(np.float32) * stride
        distances = raw[level + 3][0].transpose(1, 2, 0).reshape(-1, 4)[anchors]
        bounds = np.concatenate((points - distances[:, :2], points + distances[:, 2:]), axis=1)
        bounds[:, (0, 2)] = np.clip(bounds[:, (0, 2)], 0, image_w)
        bounds[:, (1, 3)] = np.clip(bounds[:, (1, 3)], 0, image_h)
        boxes.append(bounds / np.tile(scale, 2))
        scores.append(values)
        labels.append(classes)
        kernels.append(raw[level + 6][0].transpose(1, 2, 0).reshape(-1, 169)[anchors])
        priors.append(np.concatenate((points, np.full_like(points, stride)), axis=1))
    boxes, scores, labels, kernels, priors = [np.concatenate(items) for items in (boxes, scores, labels, kernels, priors)]
    valid = np.all(boxes[:, 2:] > boxes[:, :2], axis=1)
    order = np.argsort(-scores, kind='stable')
    order = order[valid[order]]
    area = (boxes[:, 2:] - boxes[:, :2]).prod(axis=1)
    keep = []
    while order.size and len(keep) < 100:
        index = order[0]
        keep.append(index)
        remaining = order[1:]
        overlap = np.maximum(0, np.minimum(boxes[index, 2:], boxes[remaining, 2:]) - np.maximum(boxes[index, :2], boxes[remaining, :2]))
        intersection = overlap.prod(axis=1)
        iou = intersection / np.maximum(area[index] + area[remaining] - intersection, 1e-12)
        order = remaining[(labels[remaining] != labels[index]) | (iou <= .6)]
    keep = np.array([index for index in keep if labels[index] == 0], dtype=np.int64)
    original_h, original_w = metadata['ori_shape'][:2]
    masks = np.empty((len(keep), original_h, original_w), dtype=np.bool_)
    feature = raw[9][0]
    yy, xx = np.mgrid[:80, :80].astype(np.float32)
    grid = np.stack((xx, yy)) * 8
    scale_x, scale_y = metadata['scale_factor']
    restored_w,restored_h=math.ceil(640/scale_y),math.ceil(640/scale_x)
    extent_w,target_w=restoration_extent(restored_w,original_w)
    extent_h,target_h=restoration_extent(restored_h,original_h)
    for position, index in enumerate(keep):
        relative = (priors[index, :2, None, None] - grid) / (priors[index, 2] * 8)
        value = np.concatenate((relative, feature)).reshape(10, -1)
        params = kernels[index]
        for weight, bias, relu in (
            (params[:80].reshape(8, 10), params[152:160], True),
            (params[80:144].reshape(8, 8), params[160:168], True),
            (params[144:152].reshape(1, 8), params[168:169], False),
        ):
            value = cv2.gemm(weight, value, 1, None, 0) + bias[:, None]
            if relu:
                np.maximum(value, 0, out=value)
        logits = cv2.resize(value.reshape(80,80)[:extent_h//8,:extent_w//8],
            (extent_w,extent_h),interpolation=cv2.INTER_LINEAR)
        restored = cv2.resize(logits,(target_w,target_h),interpolation=cv2.INTER_LINEAR)
        masks[position] = restored[:original_h, :original_w] > 0
    return boxes[keep], scores[keep], masks
