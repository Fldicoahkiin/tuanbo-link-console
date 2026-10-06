import unittest
from types import SimpleNamespace
import numpy as np
from body import BodyGeometry, exclusive_masks, geometry


def landmarks():
    points = [SimpleNamespace(x=.5, y=.5, visibility=1., presence=1.) for _ in range(33)]
    for index, x, y in [(11,.4,.3),(12,.6,.3),(23,.43,.6),(24,.57,.6)]:
        points[index].x, points[index].y = x, y
    return points


class BodyTests(unittest.TestCase):
    def test_occluded_leg_is_unavailable_without_disabling_torso(self):
        points = landmarks(); points[25].visibility = .2
        body = geometry(points, np.ones((100,100)), 100, 100)
        self.assertTrue(body.usable((11,12,23,24)))
        self.assertFalse(body.usable((23,25,27)))

    def test_missing_torso_is_not_guessed(self):
        points = landmarks(); points[11].visibility = .1
        self.assertIsNone(geometry(points, np.ones((100,100)), 100, 100))

    def test_invalid_joint_is_disabled(self):
        points = landmarks(); points[25].x = float('nan'); points[27].y = 1.2
        body = geometry(points, np.ones((100,100)), 100, 100)
        self.assertEqual(body.joints[25,2], 0)
        self.assertEqual(body.joints[27,2], 0)

    def test_invalid_masks_rejected(self):
        for mask in [np.ones((10,10)),np.full((100,100),float('nan')),np.full((100,100),1.1)]:
            with self.assertRaises(ValueError): geometry(landmarks(),mask,100,100)

    def test_overlap_does_not_assign_foreground_arbitrarily(self):
        a=BodyGeometry(np.zeros((33,3)),np.array([[1.,1.,0.,.5]]))
        b=BodyGeometry(np.zeros((33,3)),np.array([[0.,1.,1.,.5]]))
        masks=exclusive_masks([a,b])
        np.testing.assert_equal(masks[0],[[1,0,0,0]])
        np.testing.assert_equal(masks[1],[[0,0,1,0]])
        self.assertEqual(exclusive_masks([]),[])

    def test_shared_exclusion_matches_per_person_competition(self):
        rng=np.random.default_rng(72)
        for count in range(1,7):
            stack=rng.random((count,80,120),dtype=np.float32)
            # Exact threshold values, ties, and fully overlapping foreground.
            stack[:,:,0]=.4;stack[:,:,1]=.6;stack[:,:,2]=1;stack[:,:,3]=0
            stack[0,:,4]=np.nextafter(np.float32(.6),np.float32(1))
            bodies=[BodyGeometry(np.zeros((33,3)),mask) for mask in stack]
            unchanged=stack.copy()
            actual=exclusive_masks(bodies)
            np.testing.assert_array_equal(stack,unchanged)
            for index in range(count):
                other=np.max(np.delete(stack,index,axis=0),axis=0) if count>1 else np.zeros_like(stack[0])
                expected=np.clip((stack[index]-.6)/.3,0,1)*np.clip((.4-other)/.2,0,1)
                np.testing.assert_array_equal(actual[index],expected)


if __name__ == '__main__': unittest.main()
