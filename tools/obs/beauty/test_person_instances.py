import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock
import numpy as np
from person_instances import PersonInstances


class PersonInstanceTest(unittest.TestCase):
    def detector(self, boxes=None, labels=None, masks=None):
        detector=PersonInstances.__new__(PersonInstances)
        output={'boxes':np.array([[0,0,544,320,.9]],dtype=np.float32) if boxes is None else boxes,
            'labels':np.array([0]) if labels is None else labels,
            'masks':np.ones((1,224,224),dtype=np.float32) if masks is None else masks}
        detector.compiled=Mock(return_value=output)
        detector.compiled.output.side_effect=lambda name:name
        return detector

    def test_rgb_is_converted_to_bgr_and_returns_source_sized_probabilities(self):
        detector=self.detector()
        rgb=np.zeros((40,60,3),dtype=np.uint8); rgb[:]=[10,20,30]
        masks=detector.analyze(rgb)
        data=detector.compiled.call_args.args[0][0]
        np.testing.assert_array_equal(data[0,:,100,100],[30,20,10])
        self.assertEqual(masks[0].shape,(40,60))
        self.assertEqual(masks[0].dtype,np.float32)
        self.assertEqual(masks[0][20,30],1)

    def test_malformed_outputs_cannot_become_a_protection_mask(self):
        for values in [dict(labels=np.array([1])),dict(labels=np.array([np.nan])),
            dict(boxes=np.ones((11,5))),dict(masks=np.ones((1,10,10))),
            dict(masks=np.full((1,224,224),np.nan)),dict(masks=np.full((1,224,224),1.1)),
            dict(boxes=np.array([[10,0,5,100,.9]]))]:
            with self.subTest(values=list(values)):
                with self.assertRaises(ValueError):self.detector(**values).analyze(np.ones((40,60,3),dtype=np.uint8))

    def test_bad_model_is_rejected_before_runtime_initialization(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);(path/'model.xml').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'checksum'):
                PersonInstances(path)

    def test_invalid_rgb_does_not_run_inference(self):
        detector=self.detector()
        with self.assertRaises(ValueError):detector.analyze(np.zeros((10,10,4),dtype=np.uint8))
        detector.compiled.assert_not_called()

    def test_black_borders_are_excluded_but_dark_content_keeps_its_coordinates(self):
        detector=self.detector()
        rgb=np.zeros((100,80,3),dtype=np.uint8); rgb[30:60,10:70]=1
        mask=detector.analyze(rgb)[0]
        self.assertEqual(mask.shape,(100,80))
        self.assertEqual(mask[45,40],1)
        self.assertFalse(mask[:30].any());self.assertFalse(mask[60:].any())
        self.assertFalse(mask[:,:10].any());self.assertFalse(mask[:,70:].any())
        self.assertTrue(np.all(detector.compiled.call_args.args[0][0]==1))

    def test_empty_frame_never_produces_instances(self):
        detector=self.detector()
        self.assertEqual(detector.analyze(np.zeros((100,80,3),dtype=np.uint8)),[])
        detector.compiled.assert_not_called()

    def test_invalid_thread_budget_is_rejected_before_loading_model(self):
        for threads in [0,3,16,True]:
            with self.assertRaises(ValueError):PersonInstances(Path('unused'),threads=threads)

    def test_timing_does_not_reuse_previous_frame_after_empty_or_failed_input(self):
        detector=self.detector()
        detector.analyze(np.ones((40,60,3),dtype=np.uint8))
        self.assertEqual(set(detector.timing),{'preprocessMs','inferenceMs','postprocessMs'})
        self.assertTrue(all(value>=0 for value in detector.timing.values()))
        detector.analyze(np.zeros((40,60,3),dtype=np.uint8))
        self.assertEqual(detector.timing['inferenceMs'],0)
        self.assertEqual(detector.timing['postprocessMs'],0)
        with self.assertRaises(ValueError):detector.analyze(np.ones((40,60,4),dtype=np.uint8))
        self.assertEqual(detector.timing,{})


if __name__=='__main__':unittest.main()
