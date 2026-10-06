import threading
import unittest
from unittest.mock import Mock
import numpy as np
from worker import warmup_models


class ModelWarmupTests(unittest.TestCase):
    def test_initializes_each_model_on_same_frame_without_publishing(self):
        transport = Mock()
        transport.read.return_value = {'sequence':7,'height':2,'width':2,'rgba':bytes([10,20,30,255])*4}
        first,second = Mock(),Mock()
        result = warmup_models(transport,threading.Event(),[('face',first),('body',second)])
        self.assertEqual(result['sequence'],7)
        self.assertFalse(result['cancelled'])
        self.assertEqual([stage['model'] for stage in result['stages']],['face','body'])
        self.assertIs(first.call_args.args[0],second.call_args.args[0])
        np.testing.assert_array_equal(first.call_args.args[0],np.full((2,2,3),[10,20,30],dtype=np.uint8))
        transport.write.assert_not_called()
        transport.write_body.assert_not_called()

    def test_model_failure_propagates_without_retry_or_later_execution(self):
        transport = Mock()
        transport.read.return_value = {'sequence':1,'height':1,'width':1,'rgba':bytes(4)}
        first = Mock(side_effect=RuntimeError('model failed'))
        later = Mock()
        with self.assertRaisesRegex(RuntimeError,'model failed'):
            warmup_models(transport,threading.Event(),[('first',first),('later',later)])
        first.assert_called_once()
        later.assert_not_called()
        transport.write.assert_not_called()

    def test_owner_stop_during_warmup_prevents_remaining_models(self):
        transport = Mock()
        transport.read.return_value = {'sequence':1,'height':1,'width':1,'rgba':bytes(4)}
        stopped = threading.Event()
        first = Mock(side_effect=lambda _:stopped.set())
        later = Mock()
        result = warmup_models(transport,stopped,[('first',first),('later',later)])
        self.assertTrue(result['cancelled'])
        later.assert_not_called()


if __name__ == '__main__':
    unittest.main()
