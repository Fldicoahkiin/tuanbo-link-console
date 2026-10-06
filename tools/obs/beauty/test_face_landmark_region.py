import math
import unittest
from types import SimpleNamespace

import mediapipe as mp
import numpy as np
from mediapipe.framework.formats import landmark_pb2
from mediapipe.python import packet_creator, packet_getter
from face_landmark_region import FaceLandmarkRegion


class FaceLandmarkRegionTest(unittest.TestCase):
    def detector(self, count):
        captured = []
        landmarks = landmark_pb2.NormalizedLandmarkList()
        for _ in range(count):
            landmarks.landmark.add(x=.5, y=.5, z=0)
        result = packet_creator.create_proto(landmarks)
        detector = FaceLandmarkRegion.__new__(FaceLandmarkRegion)
        def process(packets):
            captured.append(packet_getter.get_proto(packets['rect']))
            return {'landmarks': result}
        detector.runner = SimpleNamespace(process=process)
        return detector, captured

    def test_roi_is_pixel_square_in_landscape_and_portrait(self):
        box = np.array([20, 30, 40, 60, 30, 45, 50, 45, 40, 60, 32, 70, 48, 70, .9])
        for width, height in [(200, 100), (100, 200)]:
            detector, rects = self.detector(478)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((height, width, 3), dtype=np.uint8))
            self.assertEqual(len(detector.detect(image, box)), 478)
            rect = rects[0]
            self.assertAlmostEqual(rect.x_center*width, 40, places=4)
            self.assertAlmostEqual(rect.y_center*height, 60, places=4)
            self.assertAlmostEqual(rect.width*width, 72, places=4)
            self.assertAlmostEqual(rect.height*height, 72, places=4)
            self.assertAlmostEqual(rect.rotation, 0)

    def test_eye_axis_sets_roi_rotation(self):
        detector, rects = self.detector(478)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((100, 100, 3), dtype=np.uint8))
        detector.detect(image, np.array([20, 20, 50, 60, 30, 30, 50, 50, 40, 50, 30, 65, 50, 65, .9]))
        self.assertAlmostEqual(rects[0].rotation, math.pi/4, places=6)

    def test_invalid_output_count_is_not_accepted(self):
        detector, _ = self.detector(468)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((100, 100, 3), dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, 'landmark count'):
            detector.detect(image, np.array([20, 20, 50, 60, 30, 30, 50, 30, 40, 50, 30, 65, 50, 65, .9]))


if __name__ == '__main__':
    unittest.main()
