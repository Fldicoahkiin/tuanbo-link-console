"""Diagnostic native-mask producer. Performs no inference."""
import argparse
import json
import queue
import sys
import threading
import time
import numpy as np
from transport import Transport


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--channel', required=True)
    parser.add_argument('--regions', required=True)
    args = parser.parse_args()
    with open(args.regions, encoding='utf-8') as source:
        faces = json.load(source)['faces']
    commands = queue.Queue()

    def read_commands():
        for line in sys.stdin:
            commands.put(line.strip())
        commands.put('stop')

    threading.Thread(target=read_commands, daemon=True).start()
    mode, acknowledged, previous, submitted = None, False, 0, None
    deadline = time.monotonic() + 45
    with Transport(args.channel) as transport:
        while time.monotonic() < deadline:
            try:
                command = commands.get_nowait()
            except queue.Empty:
                command = None
            if command == 'stop':
                return
            if command is not None:
                if command not in ('absent', 'zero', 'half', 'full', 'profile-full', 'profile-half', 'profile-zero', 'profile-none'):
                    raise ValueError('Invalid diagnostic mask mode')
                mode, acknowledged, submitted = command, False, None
            if submitted is not None and not acknowledged:
                status = transport.read_status()
                if status['status'] in (1,2) and status['accepted_sequence'] >= submitted:
                    print(json.dumps({'mode': mode, 'accepted': status['accepted_sequence']}), flush=True)
                    acknowledged = True
            frame = transport.read(previous)
            if frame is None or mode is None:
                time.sleep(.002)
                continue
            previous = frame['sequence']
            mask = None
            if mode != 'absent':
                mask = np.full((frame['height'], frame['width']), float(mode == 'full'), dtype=np.float32)
                if mode == 'half':
                    mask[:, frame['width']//2:] = 1
            if mode.startswith('profile-'):
                mask = np.ones((frame['height'],frame['width']),dtype=np.float32)
                guard = np.full_like(mask,float(mode == 'profile-full'))
                if mode == 'profile-half': guard[:,frame['width']//2:] = 1
                transport.write(frame, [], semantic_mask=mask, profile_mask=None if mode=='profile-none' else guard, profile_count=0 if mode=='profile-none' else 1)
            else:
                transport.write(frame, faces, semantic_mask=mask)
            if submitted is None:
                submitted = frame['sequence']
    raise TimeoutError('Diagnostic producer reached its bounded lifetime')


if __name__ == '__main__':
    main()
