import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from face_segmentation import FaceSegmentation, ThreadedBaseOptions, face_confidence


def result(arrays):
    return SimpleNamespace(confidence_masks=[SimpleNamespace(numpy_view=lambda array=array: array) for array in arrays])


class FaceSegmentationTest(unittest.TestCase):
    def test_letterbox_coordinates_are_restored_without_thresholding_dark_pixels(self):
        detector = FaceSegmentation.__new__(FaceSegmentation)
        seen = []

        def segment(image):
            pixels = image.numpy_view()
            seen.append(pixels.copy())
            arrays = [np.zeros(pixels.shape[:2], dtype=np.float32) for _ in range(6)]
            arrays[3][:] = 1
            return result(arrays)

        detector.segmenter = SimpleNamespace(segment=segment)
        rgb = np.zeros((12, 8, 3), dtype=np.uint8)
        rgb[4:7, 2:6] = 1
        mask = detector.analyze(rgb)
        self.assertEqual(seen[0].shape, (4, 4, 3))
        self.assertTrue(np.all(seen[0][:3] == 1))
        expected = np.zeros((12, 8), dtype=np.float32)
        expected[4:7, 2:6] = 1
        np.testing.assert_array_equal(mask, expected)

    def test_empty_black_frame_never_runs_segmentation(self):
        detector = FaceSegmentation.__new__(FaceSegmentation)
        detector.segmenter = SimpleNamespace(segment=lambda _: self.fail('Empty canvas must not invoke model'))
        np.testing.assert_array_equal(detector.analyze(np.zeros((8, 5, 3), dtype=np.uint8)), np.zeros((8, 5), dtype=np.float32))

    def test_unverified_model_cannot_initialize_native_runtime(self):
        with patch('face_segmentation.mp.tasks.vision.ImageSegmenter.create_from_options') as create:
            with self.assertRaisesRegex(ValueError, 'checksum'):
                FaceSegmentation(b'invalid model')
            create.assert_not_called()

    def test_confidence_is_detached_and_keeps_only_face_class(self):
        arrays = [np.zeros((2, 3), dtype=np.float32) for _ in range(6)]
        arrays[3][:] = .8
        arrays[1][:] = .2
        mask = face_confidence(result(arrays), 3, 2)
        np.testing.assert_array_equal(mask, np.full((2, 3), .8, dtype=np.float32))
        arrays[3][:] = 0
        self.assertTrue(np.all(mask == np.float32(.8)))

    def test_bad_classes_shapes_and_probabilities_are_explicit_errors(self):
        arrays = [np.zeros((2, 3), dtype=np.float32) for _ in range(6)]
        arrays[3][:] = 1
        for invalid in [arrays[:5], [*arrays[:5], np.zeros((3, 2), dtype=np.float32)],
                        [*arrays[:5], np.full((2, 3), np.nan, dtype=np.float32)],
                        [*arrays[:5], np.full((2, 3), -.1, dtype=np.float32)],
                        [np.ones((2, 3), dtype=np.float32) for _ in range(6)]]:
            with self.assertRaises(ValueError):
                face_confidence(result(invalid), 3, 2)

    def test_cpu_delegate_is_explicit_and_bounded(self):
        acceleration = ThreadedBaseOptions(b'model', 4).to_pb2().acceleration
        self.assertEqual(acceleration.xnnpack.num_threads, 4)
        self.assertFalse(acceleration.HasField('tflite'))
        with self.assertRaises(ValueError):
            ThreadedBaseOptions(b'model', 64)


if __name__ == '__main__':
    unittest.main()
