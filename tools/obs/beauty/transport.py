"""Windows owner-local shared memory ABI. Never creates a missing OBS channel."""
import ctypes
from ctypes import wintypes
import re
import struct
from landmarks import POINT_KEYS

FRAME_OFFSET = 179312
BODY_STATUS_OFFSET = 23304
BODY_RESULT_OFFSET = 23312
SEMANTIC_OFFSET = FRAME_OFFSET + 640 * 640 * 4
PROFILE_OFFSET = SEMANTIC_OFFSET + 4 + 160 * 160
DEMAND_OFFSET = PROFILE_OFFSET + 4 + 160 * 160
CAPACITY = DEMAND_OFFSET + 8
KEYS = ("cx", "cy", "rx", "ry", "lx", "ly", "ex", "ey", "smooth", "white", "slim", "eye") + POINT_KEYS
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.GetTickCount64.restype = ctypes.c_ulonglong
k32.GetTickCount64.argtypes = []
for name, result, arguments in (
    ("OpenFileMappingW", wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]),
    ("MapViewOfFile", ctypes.c_void_p, [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]),
    ("OpenMutexW", wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]),
    ("CreateMutexW", wintypes.HANDLE, [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]),
    ("WaitForSingleObject", wintypes.DWORD, [wintypes.HANDLE, wintypes.DWORD]),
    ("ReleaseMutex", wintypes.BOOL, [wintypes.HANDLE]),
    ("UnmapViewOfFile", wintypes.BOOL, [ctypes.c_void_p]),
    ("CloseHandle", wintypes.BOOL, [wintypes.HANDLE]),
):
    fn = getattr(k32, name)
    fn.restype, fn.argtypes = result, arguments


class Transport:
    def __init__(self, name):
        if not re.fullmatch(r"Local\\tblink-beauty-\d+-\d+", name):
            raise ValueError("Invalid OBS beauty channel name")
        self.mapping = self.mutex = self.pointer = self.lease = None
        self.lease_owned = False
        try:
            self.mapping = k32.OpenFileMappingW(0xF001F, False, name)
            self.mutex = k32.OpenMutexW(0x100001, False, name + "-lock")
            if not self.mapping or not self.mutex:
                raise ctypes.WinError(ctypes.get_last_error())
            self.pointer = k32.MapViewOfFile(self.mapping, 0xF001F, 0, 0, CAPACITY)
            if not self.pointer:
                raise ctypes.WinError(ctypes.get_last_error())
            self.lease = k32.CreateMutexW(None, False, name + "-worker")
            if not self.lease:
                raise ctypes.WinError(ctypes.get_last_error())
            result = k32.WaitForSingleObject(self.lease, 0)
            if result not in (0, 0x80):
                raise RuntimeError("An analysis worker already owns this filter")
            self.lease_owned = True
        except BaseException:
            self.close()
            raise

    def lock(self):
        result = k32.WaitForSingleObject(self.mutex, 2000)
        if result == 0x80:
            k32.ReleaseMutex(self.mutex)
            raise RuntimeError("OBS channel lock abandoned")
        if result != 0:
            raise RuntimeError(f"OBS channel lock failed: {result}")

    def read(self, previous_sequence=0):
        self.lock()
        try:
            # Fixed header offsets also appear in live.h's static assertion.
            head = struct.unpack("<8IQ", ctypes.string_at(self.pointer, 40))
            magic, version, alive, epoch, width, height, stride, sequence, stamp = head
            if magic != 0x31464254 or version != 7:
                raise RuntimeError("OBS transport version mismatch")
            if alive != 1:
                raise EOFError("OBS filter has been destroyed")
            # Poll the small header before copying pixels. Face and body readers
            # have independent cursors; neither may consume the other's frame.
            if sequence == 0 or sequence == previous_sequence:
                return None
            if not (0 < width <= 640 and 0 < height <= 640 and stride == width * 4):
                raise RuntimeError("Invalid OBS frame dimensions")
            rgba = ctypes.string_at(self.pointer + FRAME_OFFSET, stride * height)
            status = struct.unpack("<II", ctypes.string_at(self.pointer + 40, 8))
            body_status = struct.unpack("<II", ctypes.string_at(self.pointer + BODY_STATUS_OFFSET, 8))
            flags, = struct.unpack('<Q', ctypes.string_at(self.pointer + DEMAND_OFFSET, 8))
            if flags & ~1:
                raise RuntimeError('Invalid OBS analysis demand flags')
            return dict(epoch=epoch, sequence=sequence, timestamp=stamp, width=width, height=height,
                        accepted_sequence=status[0], status=status[1], body_accepted_sequence=body_status[0],
                        body_status=body_status[1], body_requested=bool(flags & 1), rgba=rgba)
        finally:
            k32.ReleaseMutex(self.mutex)

    def write(self, frame, faces, error=0, semantic_mask=None, profile_mask=None, profile_count=0):
        if len(faces) > 6:
            raise ValueError("Too many faces")
        numbers = [float(face[key]) for face in faces for key in KEYS]
        numbers += [0.0] * (5808 - len(numbers))
        packet = struct.pack("<4IQ5808f", frame["epoch"], frame["sequence"], len(faces), error,
                             frame["timestamp"], *numbers)
        semantic = struct.pack('<I', 0) + bytes(160*160)
        if semantic_mask is not None:
            import numpy as np
            import cv2
            if error or semantic_mask.shape != (frame['height'], frame['width']) or \
                    not np.isfinite(semantic_mask).all() or np.any(semantic_mask < 0) or np.any(semantic_mask > 1):
                raise ValueError('Invalid semantic face mask')
            pixels = np.round(cv2.resize(semantic_mask, (160,160), interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
            semantic = struct.pack('<I', 1) + pixels.tobytes()
        profile = struct.pack('<I', 0) + bytes(160*160)
        if profile_count or profile_mask is not None:
            from profile_skin import pack_guard
            if error or semantic_mask is None or not isinstance(profile_count,int) or not 1 <= profile_count <= 6-len(faces) or profile_mask is None or profile_mask.shape != (frame['height'],frame['width']):
                raise ValueError('Invalid profile skin result')
            profile = struct.pack('<I',profile_count) + pack_guard(profile_mask).tobytes()
        self.lock()
        try:
            ctypes.memmove(self.pointer + 48, packet, len(packet))
            ctypes.memmove(self.pointer + SEMANTIC_OFFSET, semantic, len(semantic))
            ctypes.memmove(self.pointer + PROFILE_OFFSET, profile, len(profile))
        finally:
            k32.ReleaseMutex(self.mutex)

    def read_status(self):
        """Read current OBS acknowledgements without acquiring/copying a frame."""
        self.lock()
        try:
            magic, version, alive, epoch, _, _, _, sequence, stamp = struct.unpack('<8IQ', ctypes.string_at(self.pointer, 40))
            if magic != 0x31464254 or version != 7:
                raise RuntimeError('OBS transport version mismatch')
            if alive != 1:
                raise EOFError('OBS filter has been destroyed')
            accepted, status = struct.unpack('<II', ctypes.string_at(self.pointer+40, 8))
            body_accepted, body_status = struct.unpack('<II', ctypes.string_at(self.pointer+BODY_STATUS_OFFSET, 8))
            return dict(epoch=epoch, sequence=sequence, timestamp=stamp, accepted_sequence=accepted, status=status,
                        body_accepted_sequence=body_accepted, body_status=body_status)
        finally:
            k32.ReleaseMutex(self.mutex)

    def write_body(self, frame, bodies, masks, error=0):
        if len(bodies) > 6 or len(bodies) != len(masks):
            raise ValueError('Invalid body count')
        import numpy as np
        import cv2
        joints = np.zeros((6,33,3), dtype='<f4')
        pixels = np.zeros((6,160,160), dtype=np.uint8)
        for index, (body, mask) in enumerate(zip(bodies, masks)):
            if body.joints.shape != (33,3) or not np.isfinite(body.joints).all():
                raise ValueError('Invalid body joints')
            if np.any(body.joints < 0) or np.any(body.joints > 1):
                raise ValueError('Body joints out of range')
            if mask.shape != (frame['height'],frame['width']) or not np.isfinite(mask).all():
                raise ValueError('Invalid body mask shape or values')
            if np.any(mask < 0) or np.any(mask > 1):
                raise ValueError('Body mask out of range')
            joints[index] = body.joints
            pixels[index] = np.round(cv2.resize(mask,(160,160),interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
        packet = struct.pack('<4IQ',frame['epoch'],frame['sequence'],len(bodies),error,frame['timestamp'])
        packet += joints.tobytes() + pixels.tobytes()
        if BODY_RESULT_OFFSET + len(packet) != FRAME_OFFSET:
            raise RuntimeError('Body transport size mismatch')
        self.lock()
        try:
            ctypes.memmove(self.pointer + BODY_RESULT_OFFSET, packet, len(packet))
        finally:
            k32.ReleaseMutex(self.mutex)

    def close(self):
        if self.lease_owned:
            k32.ReleaseMutex(self.lease)
        if self.pointer:
            k32.UnmapViewOfFile(self.pointer)
        for handle in (self.mapping, self.mutex, self.lease):
            if handle:
                k32.CloseHandle(handle)
        self.mapping = self.mutex = self.pointer = self.lease = None
        self.lease_owned = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
