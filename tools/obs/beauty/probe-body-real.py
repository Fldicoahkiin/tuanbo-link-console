"""Inspect body geometry and exclusive masks on hash-pinned real group frames."""
import hashlib
import argparse
import json
from pathlib import Path
import tempfile
import time

import cv2
import numpy as np
import mediapipe as mp
from body import BodyAnalyzer, exclusive_masks, geometry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['lite','full'], default='lite')
    args = parser.parse_args()
    source = Path(__file__).parent
    work = source.resolve().parents[2]/'artifacts/beauty-prototype'
    annotations = json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
    asset = json.loads((source/'assets.json').read_text(encoding='utf-8'))['bodyLiteModel' if args.model=='lite' else 'bodyModel']
    model = (work/asset['file']).read_bytes()
    if hashlib.sha256(model).hexdigest() != asset['sha256']:
        raise ValueError('Body model checksum mismatch')
    directory = Path(tempfile.mkdtemp(prefix='body-real-',dir=work))
    report = {'qualityAccepted':False, 'scope':__doc__, 'model':args.model, 'modelSha256':asset['sha256'], 'attribution':annotations['attribution'], 'samples':[]}
    with BodyAnalyzer(model) as detector:
        for sample in annotations['samples']:
            stamp = sample['timestampMs']
            image = cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError('Real frame missing')
            rgb = cv2.cvtColor(image,cv2.COLOR_BGR2RGB)
            if hashlib.sha256(rgb.tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Real frame checksum mismatch')
            started = time.perf_counter()
            bodies = detector.analyze(rgb)
            masks = exclusive_masks(bodies)
            # Inspect unfiltered whole-frame proposals to distinguish missing
            # detections from geometry() rejecting an incomplete torso.
            raw = detector.detectors[0].detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb))
            raw_poses = [[{'index':i,'x':pose[i].x,'y':pose[i].y,
                'confidence':pose[i].visibility*pose[i].presence} for i in (0,11,12,23,24)] for pose in raw.pose_landmarks]
            height,width = image.shape[:2]
            crop_proposals = []
            for view,(x0,x1,y0,y1) in enumerate((x0,x1,y0,y1) for x0,x1 in [(0,.6),(.2,.8),(.4,1)] for y0,y1 in [(0,.6),(.4,1)]):
                left,right,top,bottom = int(x0*width),int(x1*width),int(y0*height),int(y1*height)
                crop = np.ascontiguousarray(rgb[top:bottom,left:right])
                detected = detector.detectors[0].detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=crop))
                proposals = []
                for index,(pose,mask_image) in enumerate(zip(detected.pose_landmarks,detected.segmentation_masks or [])):
                    mask = mask_image.numpy_view()
                    valid = geometry(pose,mask,right-left,bottom-top) is not None
                    points = [{'index':i,'x':(pose[i].x*(right-left)+left)/width,'y':(pose[i].y*(bottom-top)+top)/height,
                        'confidence':pose[i].visibility*pose[i].presence} for i in (0,11,12,23,24)]
                    full = np.zeros((height,width),dtype=np.uint8)
                    full[top:bottom,left:right] = np.round(mask*255).astype(np.uint8)
                    cv2.imencode('.png',full)[1].tofile(directory/f'{stamp}-view-{view}-proposal-{index}.png')
                    proposals.append({'geometryAccepted':valid,'points':points})
                crop_proposals.append({'bounds':[left,top,right,bottom],'proposals':proposals})
            overlay = image.copy()
            people = []
            protection = []
            for index,(body,mask) in enumerate(zip(bodies,masks)):
                color = [(70,220,70),(240,160,60),(80,70,240),(230,70,200),(60,220,220),(220,220,60)][index]
                # Display effective support only; this is an annotation, not a beauty output.
                alpha = mask[:,:,None]*.55
                overlay = np.round(overlay*(1-alpha)+np.array(color)*alpha).astype(np.uint8)
                for a,b in [(11,12),(11,23),(12,24),(23,24),(23,25),(25,27),(24,26),(26,28)]:
                    if body.usable((a,b)):
                        p = tuple(np.round(body.joints[a,:2]*(width,height)).astype(int))
                        q = tuple(np.round(body.joints[b,:2]*(width,height)).astype(int))
                        cv2.line(overlay,p,q,color,2)
                center = tuple(np.round(np.mean(body.joints[[11,12,23,24],:2],axis=0)*(width,height)).astype(int))
                cv2.putText(overlay,str(index+1),center,cv2.FONT_HERSHEY_SIMPLEX,.7,(255,255,255),2)
                cv2.imencode('.png',np.round(mask*255).astype(np.uint8))[1].tofile(directory/f'{stamp}-mask-{index}.png')
                people.append({'joints':body.joints.tolist(),'activePixels':int(np.count_nonzero(mask)),
                    'leftLeg':body.usable((23,25,27)), 'rightLeg':body.usable((24,26,28))})
                # Visually reviewed on the pinned 12-second image: the left
                # rear subject must not own the foreground shoulder/back.
                if stamp == 12000 and center[0] < width*.5:
                    yy,xx = np.ogrid[:height,:width]
                    for cx,cy,radius in [(180,250,5),(230,245,5),(265,230,5)]:
                        region = (xx-cx)**2+(yy-cy)**2 <= radius**2
                        protection.append({'bodyIndex':index,'kind':'foreground-other-person',
                            'circle':[cx,cy,radius],'meanMask':float(mask[region].mean()),
                            'maxMask':float(mask[region].max()),'excluded':bool(np.all(mask[region]==0))})
            cv2.imencode('.png',np.hstack((image,overlay)))[1].tofile(directory/f'{stamp}-geometry.png')
            report['samples'].append({'timestampMs':stamp,'rawSha256':sample['rawSha256'],
                'elapsedMs':(time.perf_counter()-started)*1000,'bodies':people,'reviewedProtection':protection,
                'rawWholeFramePoses':raw_poses,'rawCropPoses':crop_proposals})
    checked = [region for sample in report['samples'] for region in sample['reviewedProtection']]
    report['reviewedMaskProtectionPassed'] = bool(checked) and all(region['excluded'] for region in checked)
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'counts':[len(s['bodies']) for s in report['samples']]}))


if __name__ == '__main__':
    main()
