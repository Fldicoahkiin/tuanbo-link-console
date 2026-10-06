import unittest
from types import SimpleNamespace

import numpy as np
from directml_segmentation import DirectMLFaceSegmentation, input_tensor, probabilities


class DirectMLSegmentationTest(unittest.TestCase):
    def test_original_metadata_normalization_and_byte_warp(self):
        rgb = np.zeros((256,256,3), dtype=np.uint8)
        rgb[:,128:] = 255
        tensor = input_tensor(rgb)
        self.assertEqual(tensor.dtype, np.float32)
        np.testing.assert_array_equal(tensor[0,:,:128], -1)
        np.testing.assert_array_equal(tensor[0,:,128:], 1)

    def test_softmax_stays_finite_with_large_logits(self):
        logits = np.full((1,256,256,6), 10000, dtype=np.float32)
        logits[:,:,:,3] += 1
        actual = probabilities(logits)
        np.testing.assert_allclose(actual.sum(axis=2), 1, atol=1e-6)
        self.assertTrue(np.all(actual[:,:,3] > actual[:,:,0]))
        for bad in (logits[:,:,:,:5], logits.astype(np.float64), np.full_like(logits,np.nan)):
            with self.assertRaises(ValueError):
                probabilities(bad)

    def test_letterbox_is_restored_and_dark_pixels_preserved(self):
        detector = DirectMLFaceSegmentation.__new__(DirectMLFaceSegmentation)
        detector.probability_output=False;detector.output_name='Identity'
        seen = []
        logits = np.full((1,256,256,6), -100, dtype=np.float32)
        logits[:,:,:,3] = 100

        def run(names, inputs):
            seen.append(inputs['input_29'].copy())
            return [logits]

        detector.session = SimpleNamespace(run=run)
        rgb = np.zeros((17,11,3), dtype=np.uint8)
        rgb[5:8,2:9] = 1
        expected = np.zeros((17,11), dtype=np.float32)
        expected[5:8,2:9] = 1
        np.testing.assert_array_equal(detector.analyze(rgb), expected)
        self.assertEqual(float(seen[0].min()), -1)
        self.assertAlmostEqual(float(seen[0].max()), (1-127.5)/127.5, places=6)
        np.testing.assert_array_equal(detector.analyze(rgb*0), expected*0)
        self.assertEqual(len(seen), 3)

    def test_gpu_probability_output_is_validated_and_restored(self):
        detector=DirectMLFaceSegmentation.__new__(DirectMLFaceSegmentation)
        detector.probability_output=True;detector.output_name='skin_probability'
        plane=np.full((1,256,256),.75,dtype=np.float32)
        detector.session=SimpleNamespace(run=lambda names,inputs:[plane])
        rgb=np.zeros((17,11,3),dtype=np.uint8);rgb[5:8,2:9]=1
        expected=np.zeros((17,11),dtype=np.float32);expected[5:8,2:9]=.75
        np.testing.assert_array_equal(detector.analyze(rgb),expected)
        for invalid in [np.full_like(plane,np.nan),plane*2,plane.astype(np.float64),plane[:,:,:128]]:
            detector.session=SimpleNamespace(run=lambda names,inputs:[invalid])
            with self.assertRaisesRegex(ValueError,'skin probability'):
                detector.analyze(rgb)

    def test_invalid_frames_and_model_fail_explicitly(self):
        detector = DirectMLFaceSegmentation.__new__(DirectMLFaceSegmentation)
        for shape, dtype in (((0,3,3),np.uint8),((641,4,3),np.uint8),((3,4,4),np.uint8),((3,4,3),np.float32)):
            with self.assertRaises(ValueError):
                detector.analyze(np.zeros(shape,dtype=dtype))
        with self.assertRaisesRegex(ValueError, 'checksum'):
            DirectMLFaceSegmentation(b'wrong model')


if __name__ == '__main__':
    unittest.main()
