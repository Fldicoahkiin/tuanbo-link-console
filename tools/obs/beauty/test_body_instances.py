import unittest
import numpy as np
from body_instances import protect_body_masks


def pose(x):
    points = np.zeros((33,3),dtype=np.float32)
    for index,y in [(0,.15),(11,.3),(12,.35),(23,.6),(24,.65)]:
        points[index] = [x,y,1]
    return points


class BodyInstanceTest(unittest.TestCase):
    def test_anchor_tolerance_does_not_expand_deformation(self):
        mask=np.zeros((100,100),dtype=np.float32)
        mask[:,:25]=1
        points=pose(25/99)
        unchanged,missing=protect_body_masks([points],[np.ones_like(mask)],[mask])
        self.assertEqual(missing,[None])
        protected,matched=protect_body_masks([points],[np.ones_like(mask)],[mask],anchor_radius=1)
        self.assertEqual(matched,[0])
        np.testing.assert_array_equal(protected[0],mask)
        self.assertFalse(unchanged[0].any())

    def test_tolerant_anchors_still_reject_adjacent_ambiguous_people(self):
        left=np.zeros((100,100),dtype=np.float32);left[:,:25]=1
        right=1-left
        protected,matched=protect_body_masks([pose(25/99)],[np.ones_like(left)],[left,right],anchor_radius=1)
        self.assertEqual(matched,[None])
        self.assertFalse(protected[0].any())

    def test_anchor_tolerance_cannot_reach_two_pixels(self):
        mask=np.zeros((100,100),dtype=np.float32);mask[:,:24]=1
        protected,matched=protect_body_masks([pose(25/99)],[np.ones_like(mask)],[mask],anchor_radius=1)
        self.assertEqual(matched,[None])
        self.assertFalse(protected[0].any())

    def test_foreground_without_pose_still_excludes_rear_mask(self):
        rear = np.zeros((100,100),dtype=np.float32); rear[:,:50]=1
        front = np.zeros_like(rear); front[70:90,20:40]=1
        body = np.ones_like(rear)
        protected,matched = protect_body_masks([pose(.25)],[body],[rear,front])
        self.assertEqual(matched,[0])
        self.assertEqual(protected[0][80,30],0)
        self.assertEqual(protected[0][40,30],1)
        self.assertTrue(np.all(body==1))

    def test_ambiguous_and_duplicate_matches_are_not_assigned(self):
        mask = np.ones((100,100),dtype=np.float32)
        for poses,instances in [([pose(.25)],[mask,mask]),([pose(.25),pose(.75)],[mask])]:
            protected,matched = protect_body_masks(poses,[mask]*len(poses),instances)
            self.assertTrue(all(index is None for index in matched))
            self.assertTrue(all(not m.any() for m in protected))

    def test_reordering_instances_preserves_effect(self):
        left = np.zeros((100,100),dtype=np.float32); left[:,:50]=1
        right = 1-left
        a,matched = protect_body_masks([pose(.25),pose(.75)],[left,right],[left,right])
        b,reordered = protect_body_masks([pose(.25),pose(.75)],[left,right],[right,left])
        self.assertEqual(matched,[0,1]); self.assertEqual(reordered,[1,0])
        for first,second in zip(a,b): np.testing.assert_array_equal(first,second)

    def test_occluded_hip_projections_do_not_transfer_body_ownership(self):
        rear = np.zeros((100,100),dtype=np.float32); rear[:50,:50]=1
        front = np.zeros_like(rear); front[50:,:50]=1
        points = pose(.25)
        protected,matched = protect_body_masks([points],[np.ones_like(rear)],[rear,front])
        self.assertEqual(matched,[0])
        self.assertEqual(protected[0][30,25],1)
        self.assertEqual(protected[0][65,25],0)

    def test_bad_boundaries_are_rejected(self):
        mask = np.ones((100,100),dtype=np.float32)
        for bad in [mask*float('nan'),mask*1.1,np.ones((20,20),dtype=np.float32)]:
            with self.assertRaises(ValueError): protect_body_masks([pose(.25)],[mask],[bad])
        with self.assertRaises(ValueError): protect_body_masks([pose(.25)],[],[mask])

    def test_competitor_exclusion_matches_stack_reference_exactly(self):
        rng=np.random.default_rng(490)
        points=[pose(.25),pose(.75)]
        for count in range(2,11):
            masks=rng.random((count,100,100),dtype=np.float32)
            masks[:,:,0]=.4; masks[:,:,1]=.6; masks[:,:,2]=1
            for index,p in enumerate(points):
                for x,y,_ in p[[0,11,12]]:
                    px,py=round(float(x)*99),round(float(y)*99)
                    masks[:,py,px]=0; masks[index,py,px]=1
            body=[rng.random((100,100),dtype=np.float32) for _ in points]
            actual,assignments=protect_body_masks(points,body,list(masks))
            self.assertEqual(assignments,[0,1])
            for index in range(2):
                other=np.max(np.delete(masks,index,axis=0),axis=0)
                expected=body[index]*np.clip((masks[index]-.6)/.3,0,1)*np.clip((.4-other)/.2,0,1)
                np.testing.assert_array_equal(actual[index],expected)

    def test_missing_instance_and_weak_anchors_do_not_invent_a_match(self):
        mask = np.ones((100,100),dtype=np.float32)
        weak = pose(.25); weak[:,2] *= .5
        for points,instances in [(pose(.25),[]),(weak,[mask])]:
            protected,matched = protect_body_masks([points],[mask],instances)
            self.assertEqual(matched,[None]); self.assertFalse(protected[0].any())


if __name__ == '__main__': unittest.main()
