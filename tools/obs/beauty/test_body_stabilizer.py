import unittest
import numpy as np
from body import BodyGeometry
from body_stabilizer import BodyStabilizer


def body(x=.5):
    joints=np.zeros((33,3),dtype=np.float32)
    for index,dx,y in [(11,-.07,.3),(12,.07,.3),(23,-.05,.6),(24,.05,.6),(25,-.05,.75),(27,-.05,.9)]:
        joints[index]=(x+dx,y,1)
    return BodyGeometry(joints,np.ones((360,640),dtype=np.float32))


class BodyStabilizerTests(unittest.TestCase):
    def test_stationary_jitter_reduced_without_changing_mask_or_confidence(self):
        stabilizer=BodyStabilizer();raw=[];filtered=[]
        for index in range(80):
            incoming=body(.5+(.001 if index%2 else -.001))
            original=incoming.joints.copy()
            result=stabilizer.update([incoming],index*67,(1,640,360))[0]
            raw.append(abs(incoming.joints[11,0]-.43));filtered.append(abs(result.joints[11,0]-.43))
            np.testing.assert_array_equal(incoming.joints,original)
            np.testing.assert_array_equal(result.joints[:,2],original[:,2])
            self.assertIs(result.mask,incoming.mask)
        self.assertLess(sum(filtered[10:]),sum(raw[10:])*.75)

    def test_reordering_preserves_spatial_match_without_member_ids(self):
        stabilizer=BodyStabilizer()
        stabilizer.update([body(.25),body(.75)],100,(1,640,360))
        result=stabilizer.update([body(.751),body(.251)],167,(1,640,360))
        self.assertGreater(result[0].joints[11,0],.6)
        self.assertLess(result[1].joints[11,0],.3)

    def test_ambiguous_crossing_does_not_blend(self):
        stabilizer=BodyStabilizer()
        stabilizer.update([body(.49),body(.51)],100,(1,640,360))
        incoming=[body(.499),body(.501)]
        results=stabilizer.update(incoming,167,(1,640,360))
        for result,source in zip(results,incoming):np.testing.assert_array_equal(result.joints,source.joints)

    def test_occluded_joint_and_reappearance_use_current_detection(self):
        stabilizer=BodyStabilizer();stabilizer.update([body()],100,(1,640,360))
        incoming=body(.501);incoming.joints[27]=(.6,.8,.2)
        result=stabilizer.update([incoming],167,(1,640,360))[0]
        np.testing.assert_array_equal(result.joints[27],incoming.joints[27])
        incoming=body(.502);result=stabilizer.update([incoming],234,(1,640,360))[0]
        np.testing.assert_array_equal(result.joints[27],incoming.joints[27])

    def test_cut_pause_epoch_and_missing_people_clear_history(self):
        for stamp,context,incoming in [(500,(1,640,360),body(.501)),(90,(1,640,360),body(.501)),
                                       (167,(2,640,360),body(.501)),(167,(1,360,640),body(.501)),(167,(1,640,360),body(.8))]:
            stabilizer=BodyStabilizer();stabilizer.update([body()],100,(1,640,360))
            np.testing.assert_array_equal(stabilizer.update([incoming],stamp,context)[0].joints,incoming.joints)
        stabilizer=BodyStabilizer();stabilizer.update([body()],100,(1,640,360))
        self.assertEqual(stabilizer.update([],167,(1,640,360)),[])
        incoming=body(.501)
        np.testing.assert_array_equal(stabilizer.update([incoming],234,(1,640,360))[0].joints,incoming.joints)

    def test_motion_lag_is_bounded_in_pixels_for_both_orientations(self):
        for width,height in [(640,360),(360,640)]:
            stabilizer=BodyStabilizer()
            for index in range(40):
                incoming=body(.2+index*.012)
                result=stabilizer.update([incoming],index*67,(1,width,height))[0]
                lag=np.linalg.norm((result.joints[:,:2]-incoming.joints[:,:2])*[width,height],axis=1)
                self.assertLessEqual(float(np.max(lag)),min(2.,height*.3*.02)+1e-4)


if __name__=='__main__':unittest.main()
