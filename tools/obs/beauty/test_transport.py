import ctypes
import struct
import unittest
import numpy as np
from unittest.mock import patch

from transport import Transport, CAPACITY, FRAME_OFFSET, BODY_STATUS_OFFSET, SEMANTIC_OFFSET, PROFILE_OFFSET, DEMAND_OFFSET, k32


class TransportReadTests(unittest.TestCase):
    def setUp(self):
        self.memory=ctypes.create_string_buffer(CAPACITY)
        self.transport=Transport.__new__(Transport)
        self.transport.pointer=ctypes.addressof(self.memory)
        self.transport.mutex=k32.CreateMutexW(None,False,None)
        if not self.transport.mutex:
            raise ctypes.WinError(ctypes.get_last_error())
        self.publish(1)

    def tearDown(self):
        k32.CloseHandle(self.transport.mutex)

    def publish(self,sequence,alive=1,version=7):
        header=struct.pack('<8IQ',0x31464254,version,alive,1,2,2,8,sequence,1234)
        ctypes.memmove(self.transport.pointer,header,len(header))
        ctypes.memmove(self.transport.pointer+FRAME_OFFSET,bytes(range(16)),16)

    def test_duplicate_cursor_reads_header_only(self):
        with patch('transport.ctypes.string_at',wraps=ctypes.string_at) as read:
            self.assertIsNone(self.transport.read(1))
            read.assert_called_once_with(self.transport.pointer,40)
        self.publish(2)
        self.assertEqual(self.transport.read(1)['rgba'],bytes(range(16)))

    def test_readers_have_independent_cursors(self):
        face=self.transport.read(0)
        self.assertIsNone(self.transport.read(face['sequence']))
        body=self.transport.read(0)
        self.assertEqual(face,body)

    def test_analysis_demand_is_frame_metadata_and_unknown_flags_fail(self):
        self.assertFalse(self.transport.read()['body_requested'])
        ctypes.memmove(self.transport.pointer+DEMAND_OFFSET,struct.pack('<Q',1),8)
        self.assertTrue(self.transport.read()['body_requested'])
        ctypes.memmove(self.transport.pointer+DEMAND_OFFSET,struct.pack('<Q',2),8)
        with self.assertRaisesRegex(RuntimeError,'analysis demand'):
            self.transport.read()

    def test_duplicate_does_not_hide_destroyed_or_invalid_channel(self):
        self.publish(1,alive=0)
        with self.assertRaises(EOFError):self.transport.read(1)
        self.publish(1,version=4)
        with self.assertRaisesRegex(RuntimeError,'version mismatch'):self.transport.read(1)

    def test_status_observes_acknowledgements_after_slow_inference_without_copying_pixels(self):
        original = self.transport.read()
        self.publish(6)
        ctypes.memmove(self.transport.pointer+40, struct.pack('<II', 4, 1), 8)
        ctypes.memmove(self.transport.pointer+BODY_STATUS_OFFSET, struct.pack('<II', 5, 1), 8)
        with patch('transport.ctypes.string_at', wraps=ctypes.string_at) as read:
            status = self.transport.read_status()
        self.assertEqual(original['sequence'], 1)
        self.assertEqual(status['sequence'], 6)
        self.assertEqual(status['accepted_sequence'], 4)
        self.assertEqual(status['body_accepted_sequence'], 5)
        self.assertEqual([call.args[1] for call in read.call_args_list], [40, 8, 8])
        self.assertEqual(self.transport.read(1)['sequence'], 6)

    def test_status_does_not_hide_invalid_or_destroyed_transport(self):
        self.publish(1, alive=0)
        with self.assertRaises(EOFError): self.transport.read_status()
        self.publish(1, version=4)
        with self.assertRaisesRegex(RuntimeError, 'version mismatch'): self.transport.read_status()


    def test_semantic_plane_is_published_with_face_packet_and_cleared_on_error(self):
        frame = self.transport.read()
        mask = np.array([[0, 1], [.5, .75]], dtype=np.float32)
        self.transport.write(frame, [], semantic_mask=mask)
        present = struct.unpack('<I', ctypes.string_at(self.transport.pointer+SEMANTIC_OFFSET, 4))[0]
        pixels = np.frombuffer(ctypes.string_at(self.transport.pointer+SEMANTIC_OFFSET+4, 160*160), dtype=np.uint8).reshape(160,160)
        self.assertEqual(present, 1)
        self.assertEqual([int(pixels[0,0]), int(pixels[0,-1]), int(pixels[-1,0]), int(pixels[-1,-1])], [0,255,128,191])
        self.transport.write(frame, [], error=1)
        self.assertEqual(ctypes.string_at(self.transport.pointer+SEMANTIC_OFFSET, 4+160*160), bytes(4+160*160))

    def test_profile_plane_is_atomic_and_cleared_with_next_result(self):
        frame = self.transport.read()
        mask = np.ones((2,2),dtype=np.float32)
        self.transport.write(frame, [], semantic_mask=mask, profile_mask=mask, profile_count=1)
        self.assertEqual(struct.unpack('<I',ctypes.string_at(self.transport.pointer+PROFILE_OFFSET,4))[0],1)
        self.assertEqual(ctypes.string_at(self.transport.pointer+PROFILE_OFFSET+4,160*160),bytes([255])*(160*160))
        self.transport.write(frame, [])
        self.assertEqual(ctypes.string_at(self.transport.pointer+PROFILE_OFFSET,4+160*160),bytes(4+160*160))
        for count in (-1,7):
            with self.assertRaises(ValueError):
                self.transport.write(frame, [], semantic_mask=mask, profile_mask=mask, profile_count=count)
        with self.assertRaises(ValueError):
            self.transport.write(frame, [], profile_mask=mask, profile_count=1)

    def test_invalid_semantic_plane_cannot_modify_accepted_packet(self):
        frame = self.transport.read()
        for mask in [np.zeros((3,3), dtype=np.float32), np.full((2,2), np.nan), np.full((2,2), 1.1)]:
            with self.assertRaisesRegex(ValueError, 'semantic'):
                self.transport.write(frame, [], semantic_mask=mask)
        self.assertEqual(ctypes.string_at(self.transport.pointer+48, 24), bytes(24))


if __name__=='__main__':unittest.main()
