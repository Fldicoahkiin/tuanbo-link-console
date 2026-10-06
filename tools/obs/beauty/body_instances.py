"""Frame-local instance agreement for body masks; no identities or temporal reuse."""
import numpy as np


def protect_body_masks(joints, body_masks, instances, *, anchor_radius=0):
    if type(anchor_radius) is not int or anchor_radius not in (0,1):
        raise ValueError('Anchor radius must be zero or one pixel')
    if len(joints) != len(body_masks) or len(joints) > 6 or len(instances) > 10:
        raise ValueError('Invalid body/instance count')
    all_masks = list(body_masks)+list(instances)
    if not all_masks:
        return [], []
    shape = all_masks[0].shape
    if len(shape) != 2 or not all(0 < n <= 640 for n in shape):
        raise ValueError('Invalid instance dimensions')
    for mask in all_masks:
        if mask.shape != shape or mask.dtype != np.float32 or not np.isfinite(mask).all() or np.any(mask < 0) or np.any(mask > 1):
            raise ValueError('Invalid instance probability')
    height,width = shape
    assignments = []
    for points in joints:
        if points.shape != (33,3) or not np.isfinite(points).all() or np.any(points < 0) or np.any(points > 1):
            raise ValueError('Invalid body joints')
        # Estimated hips can lie behind a different foreground person despite
        # high pose confidence. Establish ownership at the head/shoulders;
        # instance pixels, not hidden hip projections, then limit deformation.
        anchors = points[[0,11,12]]
        anchors = anchors[anchors[:,2] >= .6]
        if len(anchors) < 2 or not instances:
            assignments.append(None)
            continue
        x = np.clip(np.round(anchors[:,0]*(width-1)).astype(int),0,width-1)
        y = np.clip(np.round(anchors[:,1]*(height-1)).astype(int),0,height-1)
        values = [mask[y,x] if not anchor_radius else np.array([
            np.max(mask[max(0,py-1):min(height,py+2),max(0,px-1):min(width,px+2)])
            for px,py in zip(x,y)]) for mask in instances]
        scores = [float(np.average(value,weights=anchors[:,2])) for value in values]
        order = np.argsort(scores)[::-1]
        best = int(order[0])
        runner = scores[int(order[1])] if len(order)>1 else 0
        supported = np.count_nonzero(values[best] >= .6)
        assignments.append(best if supported >= 2 and scores[best] >= .5 and scores[best]-runner >= .15 else None)
    # A single instance cannot safely own two distinct skeletons. Reject the
    # conflict instead of depending on candidate order to choose a winner.
    assignments = [index if index is not None and assignments.count(index)==1 else None for index in assignments]
    protected = []
    for body,index in zip(body_masks,assignments):
        if index is None:
            protected.append(np.zeros(shape,dtype=np.float32))
            continue
        other = np.zeros(shape,dtype=np.float32)
        for candidate,mask in enumerate(instances):
            if candidate != index:
                np.maximum(other,mask,out=other)
        own = np.clip((instances[index]-.6)/.3,0,1)
        exclusion = np.clip((.4-other)/.2,0,1)
        protected.append(body*own*exclusion)
    return protected, assignments
