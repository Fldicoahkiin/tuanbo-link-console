"""Artificial labeled geometry writer for native pixel tests only."""
import argparse
import json
from pathlib import Path
import time
import numpy as np
from body import BodyGeometry
from transport import Transport


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channel',required=True)
    parser.add_argument('--stop-file',type=Path,required=True)
    parser.add_argument('--occlude-file',type=Path,required=True)
    parser.add_argument('--head-occlude-file',type=Path,required=True)
    args=parser.parse_args()
    with Transport(args.channel) as transport:
        previous=0;deadline=time.monotonic()+30;ready=False
        while time.monotonic()<deadline and not args.stop_file.exists():
            frame=transport.read(previous)
            if frame is None:
                time.sleep(.003);continue
            previous=frame['sequence'];bodies=[];masks=[]
            for center in [.25,.75]:
                joints=np.zeros((33,3),dtype=np.float32)
                joints[0]=[center,.13,0 if args.head_occlude_file.exists() else 1]
                for index,x,y in [(11,center-.11,.25),(12,center+.11,.25),(23,center-.08,.6),(24,center+.08,.6),
                    (25,center-.08,.76),(26,center+.08,.76),(27,center-.08,.93),(28,center+.08,.93)]:
                    joints[index]=[x,y,1]
                if args.occlude_file.exists():
                    joints[25:29,2]=0
                y,x=np.mgrid[:frame['height'],:frame['width']]
                mask=((np.abs(x/frame['width']-center)<.14)&(y/frame['height']>.18)&(y/frame['height']<.7)).astype(np.float32)
                for leg in [center-.08,center+.08]:
                    mask=np.maximum(mask,((np.abs(x/frame['width']-leg)<.05)&(y/frame['height']>.6)&(y/frame['height']<.96)).astype(np.float32))
                mask=np.maximum(mask,((np.abs(x/frame['width']-center)<.06)&(y/frame['height']>.06)&(y/frame['height']<.23)).astype(np.float32))
                bodies.append(BodyGeometry(joints,mask));masks.append(mask)
            transport.write(frame,[]);transport.write_body(frame,bodies,masks)
            if not ready:
                print(json.dumps({'ready':True}),flush=True);ready=True


if __name__=='__main__':main()
