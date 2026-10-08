"""Read-only diagnostics of an existing OBS beauty channel; never claims the worker lease."""
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import re
import struct
import time
import zlib


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--channel', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'Local\\tblink-beauty-\d+-\d+', args.channel):
        raise ValueError('Invalid OBS channel')
    args.output.mkdir(parents=True, exist_ok=False)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    for name, result, parameters in (
        ('OpenFileMappingW', wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]),
        ('MapViewOfFile', ctypes.c_void_p, [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]),
        ('OpenMutexW', wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]),
        ('WaitForSingleObject', wintypes.DWORD, [wintypes.HANDLE, wintypes.DWORD]),
        ('ReleaseMutex', wintypes.BOOL, [wintypes.HANDLE]),
        ('UnmapViewOfFile', wintypes.BOOL, [ctypes.c_void_p]),
        ('CloseHandle', wintypes.BOOL, [wintypes.HANDLE]),
        ('GetTickCount64', ctypes.c_ulonglong, []),
    ):
        operation = getattr(kernel, name)
        operation.restype, operation.argtypes = result, parameters
    mapping = kernel.OpenFileMappingW(4, False, args.channel)
    mutex = kernel.OpenMutexW(0x100001, False, args.channel + '-lock')
    pointer = kernel.MapViewOfFile(mapping, 4, 0, 0, 0) if mapping else None
    samples = []
    try:
        if not mapping or not pointer or not mutex:
            raise ctypes.WinError(ctypes.get_last_error())
        for index in range(30):
            locked = kernel.WaitForSingleObject(mutex, 500)
            if locked not in (0, 0x80):
                raise RuntimeError(f'Lock failed: {locked}')
            try:
                magic, version, alive, epoch, width, height, stride, sequence, stamp = struct.unpack('<8IQ', ctypes.string_at(pointer, 40))
                if magic != 0x31464254 or version != 7 or alive != 1:
                    raise RuntimeError('Channel no longer matches live ABI 7')
                if not (0 < width <= 640 and 0 < height <= 640 and stride == width * 4):
                    raise RuntimeError('Invalid frame dimensions')
                accepted, status = struct.unpack('<II', ctypes.string_at(pointer + 40, 8))
                result_epoch, result_sequence, faces, error, result_ms = struct.unpack('<4IQ', ctypes.string_at(pointer + 48, 24))
                now = kernel.GetTickCount64()
                samples.append(dict(sequence=sequence, age_ms=now-stamp, epoch=epoch, width=width, height=height,
                    accepted=accepted, status=status, result_epoch=result_epoch, result_sequence=result_sequence,
                    faces=faces, result_error=error, result_age_ms=now-result_ms))
                frame = ctypes.string_at(pointer + 179312, stride * height) if index == 0 else None
            finally:
                kernel.ReleaseMutex(mutex)
            if frame is not None:
                def chunk(kind, data):
                    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
                pixels = b''.join(b'\0' + frame[row*stride:(row+1)*stride] for row in range(height))
                png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', width, height, 8, 6, 0, 0, 0))
                png += chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
                (args.output / 'obs-analysis-input.png').write_bytes(png)
            time.sleep(.1)
    finally:
        (args.output / 'observations.json').write_text(json.dumps(samples, indent=2), encoding='utf-8')
        if pointer:
            kernel.UnmapViewOfFile(pointer)
        for handle in (mutex, mapping):
            if handle:
                kernel.CloseHandle(handle)
    print(json.dumps(samples[::5]))


if __name__ == '__main__':
    main()
