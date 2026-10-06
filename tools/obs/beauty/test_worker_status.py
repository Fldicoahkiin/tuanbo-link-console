import threading
import unittest
from unittest.mock import Mock, patch

from worker import report_status, status_packet


class WorkerStatusTests(unittest.TestCase):
    def setUp(self):
        self.state = dict(epoch=2, sequence=12, timestamp=990, accepted_sequence=10,
            status=1, body_accepted_sequence=9, body_status=1)
        self.faces = [2, {10: (900, 1, 2), 11: (950, 2, 1)}]
        self.bodies = [3, 70, {9: (850, 3)}, 2]

    def test_counts_come_from_acknowledged_sequence_not_latest_submission(self):
        packet = status_packet(self.state, 1000, self.faces, self.bodies)
        self.assertEqual((packet['faces'], packet['profiles'], packet['bodies']), (1, 2, 3))
        self.assertEqual(packet['accepted_age_ms'], 100)
        self.assertEqual(packet['body_accepted_age_ms'], 150)

    def test_missing_or_other_epoch_cannot_confirm_submitted_results(self):
        for state in ({**self.state, 'epoch': 3},
                      {**self.state, 'accepted_sequence': 0, 'body_accepted_sequence': 0}):
            packet = status_packet(state, 1000, self.faces, self.bodies)
            self.assertEqual((packet['faces'], packet['profiles'], packet['bodies']), (0, 0, 0))
            self.assertIsNone(packet['accepted_age_ms'])
            self.assertIsNone(packet['body_accepted_age_ms'])

    def test_expired_acknowledgement_is_not_refreshed_by_reporting(self):
        packet = status_packet({**self.state, 'status': 3}, 1200, self.faces, self.bodies)
        self.assertEqual(packet['face_status'], 3)
        self.assertEqual(packet['accepted_age_ms'], 300)

    def test_new_native_ack_is_reported_without_another_inference(self):
        stopped = threading.Event()
        transport = Mock()
        transport.read_status.side_effect = [self.state, {**self.state, 'accepted_sequence': 11}]
        packets = []
        def emit(packet):
            packets.append(packet)
            if len(packets) == 2:
                stopped.set()
        with patch('worker.k32.GetTickCount64', return_value=1000):
            report_status(transport, stopped, self.faces, self.bodies, threading.Lock(), emit)
        self.assertEqual([packet['accepted'] for packet in packets], [10, 11])
        self.assertEqual([packet['faces'] for packet in packets], [1, 2])

    def test_status_failure_propagates_without_retry(self):
        transport = Mock()
        transport.read_status.side_effect = RuntimeError('channel closed')
        with self.assertRaisesRegex(RuntimeError, 'channel closed'):
            report_status(transport, threading.Event(), self.faces, self.bodies, threading.Lock(), Mock())
        transport.read_status.assert_called_once()


if __name__ == '__main__':
    unittest.main()
