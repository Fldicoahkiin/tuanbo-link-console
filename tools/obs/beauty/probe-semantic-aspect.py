"""Compare aspect-preserving semantic input with stretched input; no quality claim."""
import hashlib
import json
from pathlib import Path
import tempfile

import cv2
import numpy as np
from directml_segmentation import DirectMLFaceSegmentation, input_tensor, probabilities
from directml_execution import run
from semantic_frame import prepare_frame

MODES = ('stretch', 'letterbox', 'mirror', 'mirrorMean', 'mirrorMax', 'tiles')


def stretch(model, rgb):
    output = np.zeros(rgb.shape[:2], dtype=np.float32)
    occupied = np.any(rgb != 0, axis=2)
    rows, columns = np.flatnonzero(np.any(occupied, axis=1)), np.flatnonzero(np.any(occupied, axis=0))
    if not rows.size:
        return output
    top, bottom, left, right = int(rows[0]), int(rows[-1])+1, int(columns[0]), int(columns[-1])+1
    logits = run(model.session, ['Identity'], {'input_29': input_tensor(rgb[top:bottom,left:right])})[0]
    output[top:bottom,left:right] = cv2.resize(probabilities(logits)[:,:,3], (right-left,bottom-top), interpolation=cv2.INTER_LINEAR)
    return output


def single_view(model, rgb):
    frame = prepare_frame(rgb)
    if frame is None:
        return np.zeros(rgb.shape[:2], dtype=np.float32)
    edge = frame.pixels.shape[0]
    logits = run(model.session,['Identity'],{'input_29':input_tensor(frame.pixels)})[0]
    return frame.restore(cv2.resize(probabilities(logits)[:,:,3],(edge,edge),interpolation=cv2.INTER_LINEAR))


def variants(model, rgb):
    normal = single_view(model,rgb)
    mirrored = np.fliplr(single_view(model,np.ascontiguousarray(np.fliplr(rgb))))
    return {'stretch':stretch(model,rgb),'letterbox':normal,'mirror':mirrored,'mirrorMean':(normal+mirrored)/2,'mirrorMax':np.maximum(normal,mirrored),'tiles':model.analyze(rgb)}


def strength(mask):
    packed = np.round(cv2.resize(mask,(160,160),interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
    restored = cv2.resize(packed.astype(np.float32)/255,(mask.shape[1],mask.shape[0]),interpolation=cv2.INTER_LINEAR)
    value = np.clip((restored-.55)/.25,0,1)
    return value*value*(3-2*value)


def main():
    work = Path('artifacts/beauty-prototype')
    directory = Path(tempfile.mkdtemp(prefix='semantic-aspect-',dir=work))
    annotations = json.loads(Path(__file__).with_name('semantic-regions.json').read_text(encoding='utf-8'))
    report = {'scope':__doc__,'qualityAccepted':False,'regions':[],'paired':[]}
    with DirectMLFaceSegmentation((work/'selfie_multiclass_256x256.onnx').read_bytes()) as model:
        for sample in annotations['samples']:
            bgr = cv2.imdecode(np.frombuffer((work/'face-segmentation-clc958q0'/f"{sample['timestampMs']}-source.png").read_bytes(),dtype=np.uint8),1)
            original = cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
            if hashlib.sha256(original.tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Reviewed frame changed')
            for portrait in (False,True):
                rgb = original
                scale,offset = 1,0
                if portrait:
                    scale = 360/original.shape[1]
                    h = round(original.shape[0]*scale)
                    offset = (640-h)//2
                    rgb = np.zeros((640,360,3),dtype=np.uint8)
                    rgb[offset:offset+h] = cv2.resize(original,(360,h),interpolation=cv2.INTER_AREA)
                yy,xx = np.ogrid[:rgb.shape[0],:rgb.shape[1]]
                for mode, mask in variants(model,rgb).items():
                    effect = strength(mask)
                    for region in sample['regions']:
                        x,y,radius = region['circle']
                        x,y,radius = round(x*scale),round(y*scale)+offset,max(1,round(radius*scale))
                        values = effect[(xx-x)**2+(yy-y)**2 <= radius**2]
                        report['regions'].append({'timestampMs':sample['timestampMs'],'portrait':portrait,'mode':mode,
                            **region,'meanStrength':float(values.mean()),'maxStrength':float(values.max())})
        bgr = cv2.imdecode(np.frombuffer((work/'paired.png').read_bytes(),dtype=np.uint8),1)
        rgb = cv2.cvtColor(cv2.resize(bgr,(640,220)),cv2.COLOR_BGR2RGB)
        for mode, mask in variants(model,rgb).items():
            report['paired'].append({'mode':mode,'maxConfidence':float(mask.max()),'activePixels':int((strength(mask)>.01).sum())})
            cv2.imencode('.png',np.round(strength(mask)*255).astype(np.uint8))[1].tofile(str(directory/f'paired-{mode}.png'))
    report['summary'] = [{'mode':mode,'portrait':portrait,
        'excludedWithEffect':sum(row['maxStrength']>.01 for row in report['regions'] if row['mode']==mode and row['portrait']==portrait and row['kind']!='face'),
        'weakFaces':sum(row['meanStrength']<.5 for row in report['regions'] if row['mode']==mode and row['portrait']==portrait and row['kind']=='face')}
        for mode in MODES for portrait in (False,True)]
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'paired':report['paired'],'summary':report['summary']}))


if __name__ == '__main__':
    main()
