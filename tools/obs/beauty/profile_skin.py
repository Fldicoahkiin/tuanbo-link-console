"""Same-frame detail protection for detected faces without a valid dense mesh."""
import cv2
import numpy as np
from face_proposals import proposal_error, ALIGNMENT_LIMIT


def smoothstep(low, high, value):
    t = np.clip((value-low)/(high-low), 0, 1)
    return t*t*(3-2*t)


def profile_guard(shape, boxes, faces, confidence):
    """Return protected regions with usable semantic support; never geometry."""
    height, width = shape
    if not all(isinstance(v,int) and 0 < v <= 640 for v in shape) or len(faces) > 6:
        raise ValueError('Invalid profile image dimensions or mesh count')
    guard = np.zeros((height,width), dtype=np.float32)
    if confidence is None or confidence.shape != shape or confidence.dtype != np.float32 or not np.isfinite(confidence).all() or np.any(confidence < 0) or np.any(confidence > 1):
        raise ValueError('Invalid profile semantic confidence')
    if boxes is None or len(faces) == 6:
        return guard, 0
    if boxes.ndim != 2 or boxes.shape[1] != 15 or not np.isfinite(boxes).all():
        raise ValueError('Invalid profile proposals')
    # Match transport quantization and the shader's independent semantic gate.
    # This is eligibility only: do not multiply confidence into the guard.
    semantic = None
    count = 0
    for box in sorted(boxes,key=lambda b:-b[14]):
        x,y,w,h = box[:4]
        if w <= 0 or h <= 0 or box[14] < .7 or box[14] > 1:
            continue
        if not (0 <= x < x+w <= width and 0 <= y < y+h <= height):
            continue
        points = box[4:14].reshape(5,2)
        if not (np.all(points[:,0] >= x) and np.all(points[:,0] <= x+w) and np.all(points[:,1] >= y) and np.all(points[:,1] <= y+h)):
            continue
        if any((error := proposal_error(face,box,width,height)) is not None and error <= ALIGNMENT_LIMIT for face in faces):
            continue
        # Dense meshes already cover these detections. Only pay for the
        # transport-resolution eligibility image when a fallback needs it.
        if semantic is None:
            packed = np.round(cv2.resize(confidence,(160,160),interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
            semantic = cv2.resize(packed.astype(np.float32)/255,(width,height),interpolation=cv2.INTER_LINEAR)
        y0,y1 = int(np.floor(y)),int(np.ceil(y+h))
        x0,x1 = int(np.floor(x)),int(np.ceil(x+w))
        yy,xx = np.ogrid[y0:y1,x0:x1]
        ellipse = ((xx-(x+w/2))/(w/2))**2+((yy-(y+h/2))/(h/2))**2
        local = 1-smoothstep(.45,1,ellipse)
        for index in (4,6):
            distance = ((xx-box[index])/max(1,w*.2))**2+((yy-box[index+1])/max(1,h*.1))**2
            local *= smoothstep(.25,1,distance)
        mx,my = (box[10]+box[12])/2,(box[11]+box[13])/2
        distance = ((xx-mx)/max(1,w*.28))**2+((yy-my)/max(1,h*.12))**2
        local *= smoothstep(.25,1,distance)
        if not np.any((local > 0) & (semantic[y0:y1,x0:x1] > .55)):
            continue
        region = guard[y0:y1,x0:x1]
        np.maximum(region,local,out=region)
        count += 1
        if count == 6-len(faces):
            break
    return guard, count


def pack_guard(mask):
    if mask.ndim != 2 or mask.dtype != np.float32 or not all(0 < v <= 640 for v in mask.shape) or not np.isfinite(mask).all() or np.any(mask < 0) or np.any(mask > 1):
        raise ValueError('Invalid profile guard')
    # Keep this independent of semantic confidence. Thresholding their product
    # would silently change the established semantic acceptance threshold.
    return np.round(cv2.resize(mask,(160,160),interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
