"""Read-only transport diagnosis on dedicated TBLINK SOAK ports; no retry/reset."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import subprocess
import sys
import time


class InputCaps(c.Structure):
    _fields_ = [('manufacturer', w.WORD), ('product', w.WORD),
                ('version', w.DWORD), ('name', w.WCHAR * 32), ('support', w.DWORD)]


class OutputCaps(c.Structure):
    _fields_ = [('manufacturer', w.WORD), ('product', w.WORD),
                ('version', w.DWORD), ('name', w.WCHAR * 32),
                ('technology', w.WORD), ('voices', w.WORD), ('notes', w.WORD),
                ('channel_mask', w.WORD), ('support', w.DWORD)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--cycles', type=int, default=2)
    parser.add_argument('--peer', action='store_true', help='Open and close a second output handle halfway through')
    parser.add_argument('--peer-process', action='store_true', help='Open and close ports from a separate process halfway through')
    parser.add_argument('--open-only', action='store_true')
    args = parser.parse_args()
    if not all(name.startswith('TBLINK SOAK ') for name in [args.input, args.output]):
        parser.error('Only dedicated TBLINK SOAK ports are allowed')
    if not 2 <= args.cycles <= 120:
        parser.error('cycles must be in 2..120')
    mm = c.WinDLL('winmm', winmode=0x800)
    callback_type = c.WINFUNCTYPE(None, w.HANDLE, w.UINT, c.c_size_t, c.c_size_t, c.c_size_t)
    mm.midiInOpen.argtypes = [c.POINTER(w.HANDLE), w.UINT, callback_type, c.c_size_t, w.DWORD]
    mm.midiOutOpen.argtypes = [c.POINTER(w.HANDLE), w.UINT, c.c_size_t, c.c_size_t, w.DWORD]
    for name in ['midiInStart', 'midiInStop', 'midiInClose', 'midiOutClose']:
        getattr(mm, name).argtypes = [w.HANDLE]
    mm.midiOutShortMsg.argtypes = [w.HANDLE, w.DWORD]
    report = {'input': args.input, 'output': args.output, 'calls': [], 'sent': [], 'received': []}

    def check(operation, result):
        report['calls'].append({'operation': operation, 'result': result})
        if result != 0:
            raise RuntimeError(f'{operation}: MMRESULT={result}')

    def find(direction, name, caps_type):
        matches = []
        for index in range(getattr(mm, f'midi{direction}GetNumDevs')()):
            caps = caps_type()
            check(f'{direction}GetDevCapsW({index})', getattr(mm, f'midi{direction}GetDevCapsW')(index, c.byref(caps), c.sizeof(caps)))
            if caps.name == name:
                matches.append(index)
        if len(matches) != 1:
            raise RuntimeError(f'Port absent or ambiguous: {name}')
        return matches[0]

    @callback_type
    def receive(handle, message, instance, data, timestamp):
        if message in [0x3c3, 0x3c5]:  # MIM_DATA / MIM_ERROR
            report['received'].append({'message': message, 'data': data, 'timestamp': timestamp})

    input_handle, output_handle = w.HANDLE(), w.HANDLE()
    input_open = output_open = False
    peer_process = None
    failed = None
    try:
        input_index = find('In', args.input, InputCaps)
        output_index = find('Out', args.output, OutputCaps)
        check('midiInOpen', mm.midiInOpen(c.byref(input_handle), input_index, receive, 0, 0x30000))
        input_open = True
        check('midiInStart', mm.midiInStart(input_handle))
        check('midiOutOpen', mm.midiOutOpen(c.byref(output_handle), output_index, 0, 0, 0))
        output_open = True
        for piece in range(0 if args.open_only else args.cycles * 8):
            if args.peer_process and piece == args.cycles * 4:
                peer_process = subprocess.Popen([sys.executable, __file__, '--input', args.input, '--output', args.output, '--open-only'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if args.peer and piece == args.cycles * 4:
                peer_handle = w.HANDLE()
                check('peer:midiOutOpen', mm.midiOutOpen(c.byref(peer_handle), output_index, 0, 0, 0))
                check('peer:midiOutClose', mm.midiOutClose(peer_handle))
            data = 0xf1 | (((piece % 8) << 4) | ((piece // 8) % 16)) << 8
            report['sent'].append(data)
            check('midiOutShortMsg', mm.midiOutShortMsg(output_handle, data))
            time.sleep(0.01)
        time.sleep(0.25)
        if not args.open_only and [entry['data'] for entry in report['received']] != report['sent']:
            raise RuntimeError('WinMM byte-for-byte loopback mismatch')
    except RuntimeError as error:
        failed = str(error)
    finally:
        if peer_process:
            stdout, stderr = peer_process.communicate()
            report['peer'] = {'returncode': peer_process.returncode, 'stdout': stdout, 'stderr': stderr}
            if peer_process.returncode:
                failed = f'{failed or ""} Peer process failed'.strip()
        if output_open:
            report['calls'].append({'operation': 'midiOutClose', 'result': mm.midiOutClose(output_handle)})
        if input_open:
            report['calls'].append({'operation': 'midiInStop', 'result': mm.midiInStop(input_handle)})
            report['calls'].append({'operation': 'midiInClose', 'result': mm.midiInClose(input_handle)})
        report['error'] = failed
        print(json.dumps(report, indent=2))
    if failed or any(call['result'] != 0 for call in report['calls']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
