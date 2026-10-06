"""Bounded current-frame supplemental face proposal views."""
import cv2
import numpy as np


def tiled_proposals(detector, rgb, edge, *, batched=False):
    """Fixed supplemental views, with original-coordinate NMS; no prior-frame state."""
    if edge not in (256,384,512,640):
        raise ValueError("Unsupported proposal view size")
    candidates = []
    occupied = np.any(rgb != 0,axis=2)
    rows, columns = np.flatnonzero(np.any(occupied,axis=1)), np.flatnonzero(np.any(occupied,axis=0))
    if rows.size == 0:
        return None
    left,top,right,bottom = int(columns[0]),int(rows[0]),int(columns[-1])+1,int(rows[-1])+1
    width,height = right-left,bottom-top
    views = [(left,top,right,bottom)]
    if width >= height:
        views += [(left,top,left+max(1,round(width*.625)),bottom),(left+min(width-1,round(width*.375)),top,right,bottom)]
    else:
        views += [(left,top,right,top+max(1,round(height*.625))),(left,top+min(height-1,round(height*.375)),right,bottom)]
    # The whole active image already supplies the global view. Running the
    # padded OBS canvas as well spends a fourth inference on smaller faces.
    # Degenerate one-pixel regions can make tile bounds identical.
    def prepared_views():
        for x0,y0,x1,y1 in dict.fromkeys(views):
            scale = edge/max(x1-x0,y1-y0)
            view = cv2.resize(rgb[y0:y1,x0:x1],(max(1,round((x1-x0)*scale)),max(1,round((y1-y0)*scale))),interpolation=cv2.INTER_LINEAR)
            yield (x0,y0,x1,y1),view
    if batched:
        prepared=list(prepared_views())
        found_views=detector.locate_many([view for _,view in prepared])
        if len(found_views)!=len(prepared):
            raise ValueError('Batched proposal view count changed')
        results=((bounds,view,found) for (bounds,view),found in zip(prepared,found_views))
    else:
        results=((bounds,view,detector.locate(view)) for bounds,view in prepared_views())
    for (x0,y0,x1,y1),view,found in results:
        if found is None:
            continue
        sx,sy = view.shape[1]/(x1-x0),view.shape[0]/(y1-y0)
        for row in found:
            row = row.copy()
            row[[0,2,4,6,8,10,12]] /= sx
            row[[1,3,5,7,9,11,13]] /= sy
            row[[0,4,6,8,10,12]] += x0
            row[[1,5,7,9,11,13]] += y0
            candidates.append(row)
    if not candidates:
        return None
    candidates = np.asarray(candidates,dtype=np.float32)
    indices = cv2.dnn.NMSBoxes(candidates[:,:4].tolist(),candidates[:,14].tolist(),.7,.3)
    return candidates[np.asarray(indices,dtype=np.int32).reshape(-1)]

