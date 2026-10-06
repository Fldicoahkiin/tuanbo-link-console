import threading
import unittest
from unittest.mock import Mock
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from body import BodyGeometry
from worker import analyze_body


class BodyWorkerTests(unittest.TestCase):
    def test_refined_instance_mode_removes_duplicate_before_publishing(self):
        stopped=threading.Event();transport=Mock();detector=Mock();instances=Mock()
        points=np.zeros((33,3),dtype=np.float32)
        for index,x,y in [(0,.5,.1),(11,.3,.3),(12,.7,.3),(23,.35,.7),(24,.65,.7)]:
            points[index]=[x,y,1]
        mask=np.ones((100,100),dtype=np.float32)
        detector.analyze.return_value=[BodyGeometry(points,mask)]
        instances.analyze.return_value=[mask,mask.copy()]
        frame={'sequence':9,'epoch':2,'timestamp':0,'width':100,'height':100,'rgba':bytes([10,20,30,255])*10000}
        transport.read.return_value=frame
        transport.write_body.side_effect=lambda *args,**kwargs:stopped.set()
        samples=[]
        with ThreadPoolExecutor(max_workers=1) as pool:
            analyze_body(detector,transport,stopped,[0,0],threading.Lock(),samples,120,
                         instances,pool,refined_instances=True)
        self.assertEqual(samples[0]['instance_assignments'],[0])
        self.assertEqual(len(transport.write_body.call_args.args[1]),1)
        np.testing.assert_array_equal(transport.write_body.call_args.args[2][0],mask)

    def test_demand_skips_unused_models_and_resumes_on_latest_requested_frame(self):
        stopped=threading.Event();transport=Mock();detector=Mock();instances=Mock()
        detector.analyze.return_value=[];instances.analyze.return_value=[]
        frames=[{'sequence':index,'epoch':1,'timestamp':0,'width':2,'height':2,
                 'rgba':bytes([index])*16,'body_requested':index==2} for index in (1,2,3)]
        transport.read.side_effect=frames
        def publish(frame,*_):
            if frame['sequence']==3: stopped.set()
        transport.write_body.side_effect=publish
        snapshot=[3,20,{10:(0,3)},1];samples=[]
        with ThreadPoolExecutor(max_workers=1) as pool:
            analyze_body(detector,transport,stopped,snapshot,threading.Lock(),samples,120,
                         instances,pool,body_on_demand=True)
        detector.analyze.assert_called_once();instances.analyze.assert_called_once()
        self.assertTrue(np.all(detector.analyze.call_args.args[0]==2))
        self.assertEqual([sample['sequence'] for sample in samples],[2])
        self.assertEqual(snapshot,[0,0,{},1])
        self.assertEqual(transport.write_body.call_count,3)

    def test_instance_and_pose_share_frame_and_publish_confirmed_body(self):
        stopped=threading.Event();transport=Mock();detector=Mock();instances=Mock()
        points=np.zeros((33,3),dtype=np.float32)
        for index,x,y in [(0,.5,.1),(11,.3,.3),(12,.7,.3),(23,.35,.7),(24,.65,.7)]:
            points[index]=[x,y,1]
        mask=np.ones((100,100),dtype=np.float32)
        detector.analyze.return_value=[BodyGeometry(points,mask)]
        instances.analyze.return_value=[mask]
        frame={'sequence':9,'epoch':2,'timestamp':0,'width':100,'height':100,'rgba':bytes([10,20,30,255])*10000}
        transport.read.return_value=frame
        transport.write_body.side_effect=lambda *args,**kwargs:stopped.set()
        snapshot=[0,0];samples=[]
        with ThreadPoolExecutor(max_workers=1) as pool:
            analyze_body(detector,transport,stopped,snapshot,threading.Lock(),samples,120,instances,pool)
        np.testing.assert_array_equal(detector.analyze.call_args.args[0],instances.analyze.call_args.args[0])
        self.assertEqual(snapshot[2],{9:(0,1)})
        self.assertEqual(samples[0]['instance_assignments'],[0])
        self.assertEqual(len(transport.write_body.call_args.args[1]),1)

    def test_instance_failure_clears_body_and_propagates(self):
        detector=Mock();detector.analyze.return_value=[]
        instances=Mock();instances.analyze.side_effect=RuntimeError('instance failed')
        transport=Mock()
        frame={'sequence':1,'epoch':1,'timestamp':0,'width':2,'height':2,'rgba':bytes(16)}
        transport.read.return_value=frame
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.assertRaisesRegex(RuntimeError,'instance failed'):
                analyze_body(detector,transport,threading.Event(),[0,0],threading.Lock(),[],120,instances,pool)
        transport.write_body.assert_called_once_with(frame,[],[],error=1)
        instances.analyze.assert_called_once()

    def test_body_loop_publishes_without_waiting_for_face_loop(self):
        stopped=threading.Event();snapshot=[0,0];lock=threading.Lock()
        detector=Mock();detector.analyze.return_value=[]
        transport=Mock()
        frame={'sequence':1,'epoch':1,'timestamp':0,'width':2,'height':2,'rgba':bytes(16)}
        transport.read.return_value=frame
        transport.write_body.side_effect=lambda *args,**kwargs:stopped.set()
        samples=[]
        analyze_body(detector,transport,stopped,snapshot,lock,samples,120)
        detector.analyze.assert_called_once()
        transport.write_body.assert_called_once_with(frame,[],[])
        self.assertEqual(snapshot[0],0)
        self.assertEqual(snapshot[2],{1:(0,0)})
        self.assertEqual(samples[0]['sequence'],1)
        self.assertAlmostEqual(samples[0]['processing_ms'],sum(samples[0][key] for key in ['inference_ms','masks_ms','publish_ms']))
        self.assertGreaterEqual(samples[0]['result_age_ms'],samples[0]['input_age_ms'])

    def test_body_failure_clears_result_and_propagates_without_retry(self):
        detector=Mock();detector.analyze.side_effect=RuntimeError('body failed')
        transport=Mock()
        frame={'sequence':1,'epoch':1,'timestamp':0,'width':2,'height':2,'rgba':bytes(16)}
        transport.read.return_value=frame
        with self.assertRaisesRegex(RuntimeError,'body failed'):
            analyze_body(detector,transport,threading.Event(),[0,0],threading.Lock(),[],120)
        transport.write_body.assert_called_once_with(frame,[],[],error=1)
        detector.analyze.assert_called_once()

    def test_owner_stop_does_not_read_another_frame(self):
        stopped=threading.Event();stopped.set();transport=Mock()
        analyze_body(Mock(),transport,stopped,[0,0],threading.Lock(),[],120)
        transport.read.assert_not_called()

    def test_diagnostic_history_retains_latest_samples_with_fixed_bound(self):
        stopped=threading.Event();transport=Mock();detector=Mock()
        detector.analyze.return_value=[]
        transport.read.side_effect=[{'sequence':index,'epoch':1,'timestamp':0,'width':2,'height':2,'rgba':bytes(16)} for index in range(1,131)]
        def publish(frame,*_):
            if frame['sequence']==130: stopped.set()
        transport.write_body.side_effect=publish
        samples=[];snapshot=[0,0]
        analyze_body(detector,transport,stopped,snapshot,threading.Lock(),samples,120)
        self.assertEqual([sample['sequence'] for sample in samples],list(range(11,131)))
        self.assertEqual(list(snapshot[2]),list(range(99,131)))


if __name__=='__main__':unittest.main()
