import unittest

import cv2
import numpy as np
from profile_skin import profile_guard, pack_guard


class ProfileSkinTest(unittest.TestCase):
    def setUp(self):
        self.box = np.array([20,10,60,80,38,35,62,35,50,48,40,66,60,66,.9],dtype=np.float32)
        self.confidence = np.ones((100,100),dtype=np.float32)

    def test_guard_protects_eyes_lips_and_background_after_transport(self):
        mask,count = profile_guard((100,100),self.box[None],[],self.confidence)
        self.assertEqual(count,1)
        restored = cv2.resize(pack_guard(mask).astype(np.float32)/255,(100,100))
        self.assertEqual(restored[35,38],0)
        self.assertEqual(restored[35,62],0)
        self.assertEqual(restored[66,50],0)
        self.assertEqual(restored[95,50],0)
        self.assertGreater(restored[49,38],.8)

    def test_existing_mesh_is_not_counted_as_profile_and_overlap_does_not_accumulate(self):
        face = dict(cx=.5,cy=.5,lx=.38,ly=.35,ex=.62,ey=.35,p1x=.5,p1y=.48,p61x=.4,p61y=.66,p291x=.6,p291y=.66)
        mask,count = profile_guard((100,100),self.box[None],[face],self.confidence)
        self.assertEqual(count,0)
        self.assertFalse(mask.any())
        one,_ = profile_guard((100,100),self.box[None],[],self.confidence)
        many,_ = profile_guard((100,100),np.stack([self.box]*8),[],self.confidence)
        np.testing.assert_array_equal(one,many)

    def test_invalid_geometry_cannot_enable_photometric_effect(self):
        for index,value in ((0,-1),(4,95),(14,.69)):
            box = self.box.copy();box[index] = value
            mask,count = profile_guard((100,100),box[None],[],self.confidence)
            self.assertEqual(count,0)
            self.assertFalse(mask.any())
        with self.assertRaises(ValueError):
            profile_guard((100,100),np.full((1,15),np.nan),[],self.confidence)
        for mask in (np.full((10,10),1.1,dtype=np.float32),np.full((10,10),np.nan,dtype=np.float32)):
            with self.assertRaises(ValueError):
                pack_guard(mask)

    def test_missing_skin_support_is_not_counted_or_published(self):
        for value in (0, .54):
            mask,count = profile_guard((100,100),self.box[None],[],self.confidence*value)
            self.assertEqual(count,0)
            self.assertFalse(mask.any())
        confidence = np.zeros((100,100),dtype=np.float32)
        confidence[:5,:5] = 1
        mask,count = profile_guard((100,100),self.box[None],[],confidence)
        self.assertEqual(count,0)
        self.assertFalse(mask.any())
        confidence[45:55,35:45] = 1
        mask,count = profile_guard((100,100),self.box[None],[],confidence)
        expected,_ = profile_guard((100,100),self.box[None],[],self.confidence)
        self.assertEqual(count,1)
        np.testing.assert_array_equal(mask,expected)

    def test_invalid_semantic_input_cannot_report_basic_skin(self):
        for confidence in (None, np.ones((2,2),dtype=np.float32), self.confidence.astype(np.float64),
                           self.confidence*float('nan'), self.confidence*1.1):
            with self.assertRaises(ValueError):
                profile_guard((100,100),self.box[None],[],confidence)

    def test_eligibility_uses_transmitted_confidence_not_unquantized_peak(self):
        for value,expected in ((.5501,0),(.552,1)):
            _,count = profile_guard((100,100),self.box[None],[],self.confidence*value)
            self.assertEqual(count,expected)


if __name__ == '__main__':
    unittest.main()
