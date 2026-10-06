import math
import unittest

import cv2
import numpy as np

from rtmdet_postprocess import restoration_extent


class MaskRestorationTest(unittest.TestCase):
    def test_visible_crop_preserves_both_resize_scales_and_mask_boundary(self):
        rng=np.random.default_rng(81)
        logits=rng.normal(size=(80,80)).astype(np.float32)
        for height,width in [(202,360),(360,640),(640,360),(359,639),(101,301),
                             (480,640),(640,480),(99,640),(640,99),(1,640),(640,1)]:
            with self.subTest(height=height,width=width):
                ratio=640/max(height,width)
                scale_x=int(width*ratio+.5)/width
                scale_y=int(height*ratio+.5)/height
                full_width,full_height=math.ceil(640/scale_y),math.ceil(640/scale_x)
                extent_w,target_w=restoration_extent(full_width,width)
                extent_h,target_h=restoration_extent(full_height,height)
                self.assertEqual(extent_w%8,0)
                self.assertEqual(extent_h%8,0)
                self.assertEqual(extent_w*full_width,target_w*640)
                self.assertEqual(extent_h*full_height,target_h*640)
                self.assertGreaterEqual(target_w,width)
                self.assertGreaterEqual(target_h,height)
                reference=cv2.resize(cv2.resize(logits,(640,640)),(full_width,full_height))[:height,:width]
                cropped=cv2.resize(cv2.resize(logits[:extent_h//8,:extent_w//8],
                    (extent_w,extent_h)),(target_w,target_h))[:height,:width]
                np.testing.assert_allclose(cropped,reference,rtol=0,atol=3e-7)
                np.testing.assert_array_equal(cropped>0,reference>0)


if __name__=='__main__': unittest.main()
