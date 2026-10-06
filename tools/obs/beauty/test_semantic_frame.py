import unittest

import numpy as np
from semantic_frame import prepare_frame, analysis_frames


class SemanticFrameTest(unittest.TestCase):
    def test_context_views_keep_source_coordinates_and_overlap(self):
        rgb = np.zeros((17, 19, 3), dtype=np.uint8)
        rgb[2:7, 3:15] = 1
        frames = analysis_frames(rgb)
        self.assertEqual([f.bounds for f in frames], [(2,7,3,15),(2,7,3,11),(2,7,7,15)])
        total = np.zeros(rgb.shape[:2], dtype=np.float32)
        for frame in frames:
            total += frame.restore(np.ones(frame.pixels.shape[:2], dtype=np.float32))
        self.assertEqual(total[3,8], 3)
        self.assertEqual(total[3,4], 2)
        self.assertEqual(total[0,0], 0)

    def test_empty_views_and_duplicate_single_pixel_are_omitted(self):
        self.assertEqual(analysis_frames(np.zeros((9,9,3), dtype=np.uint8)), [])
        rgb = np.zeros((9,9,3), dtype=np.uint8)
        rgb[4,5] = 1
        self.assertEqual(len(analysis_frames(rgb)), 1)

    def test_asymmetric_padding_restores_each_pixel_without_stretch(self):
        for height, width in ((3, 8), (8, 3), (4, 9), (9, 4), (1, 7), (7, 1)):
            rgb = np.zeros((17, 19, 3), dtype=np.uint8)
            pixels = np.arange(1, height*width+1, dtype=np.uint8).reshape(height, width)
            rgb[2:2+height, 5:5+width] = pixels[:, :, None]
            frame = prepare_frame(rgb)
            self.assertEqual(frame.pixels.shape, (max(height, width),)*2+(3,))
            mask = frame.pixels[:, :, 0].astype(np.float32)/255
            expected = rgb[:, :, 0].astype(np.float32)/255
            np.testing.assert_array_equal(frame.restore(mask), expected)
            self.assertEqual(np.count_nonzero(frame.pixels[:, :, 0]), height*width)

    def test_square_has_no_extra_padding_and_output_shape_is_checked(self):
        rgb = np.ones((5, 5, 3), dtype=np.uint8)
        frame = prepare_frame(rgb)
        np.testing.assert_array_equal(frame.pixels, rgb)
        with self.assertRaises(ValueError):
            frame.restore(np.zeros((5, 4), dtype=np.float32))


if __name__ == '__main__':
    unittest.main()
