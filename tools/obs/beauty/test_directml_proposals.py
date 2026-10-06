import unittest
from unittest.mock import Mock
import numpy as np
from directml_proposals import decode, STRIDES, DirectMLProposals


def tensors():
    return [np.zeros((1,(640//stride)**2,channels),dtype=np.float32) for channels in (1,1,4,10) for stride in STRIDES]


class DirectMLProposalTests(unittest.TestCase):
    def test_batched_one_view_is_zero_padded_and_submitted_once(self):
        detector=DirectMLProposals.__new__(DirectMLProposals)
        detector.batch_size=3;detector.input_name='input'
        detector.session=Mock()
        detector.session.run.return_value=[np.repeat(value,3,axis=0) for value in tensors()]
        rgb=np.full((3,4,3),[10,20,30],dtype=np.uint8)
        self.assertEqual(detector.locate_many([rgb]),[None])
        detector.session.run.assert_called_once()
        data=detector.session.run.call_args.args[1]['input']
        self.assertEqual(data.shape,(3,3,640,640))
        np.testing.assert_array_equal(data[0,:,0,0],[30,20,10])
        self.assertFalse(data[1:].any())
        self.assertFalse(data[0,:,3:].any())

    def test_batch_requires_bounded_nonempty_views(self):
        detector=DirectMLProposals.__new__(DirectMLProposals);detector.batch_size=3
        for images in [[],[np.zeros((1,1,3),dtype=np.uint8)]*4,[np.zeros((641,1,3),dtype=np.uint8)]]:
            with self.assertRaises(ValueError):detector.locate_many(images)

    def test_no_candidates_returns_none(self):
        self.assertIsNone(decode(tensors()))

    def test_grid_box_landmarks_and_score_have_expected_units(self):
        values=tensors()
        index=3*80+2
        values[0][0,index,0]=1
        values[3][0,index,0]=.64
        values[6][0,index]=[.5,.25,np.log(2),np.log(3)]
        values[9][0,index]=np.arange(10,dtype=np.float32)*.1
        rows=decode(values)
        np.testing.assert_allclose(rows[0,:4],[12,14,16,24],atol=1e-5)
        np.testing.assert_allclose(rows[0,4:14],(np.arange(10).reshape(5,2)*.1+[2,3]).reshape(-1)*8,atol=1e-5)
        self.assertAlmostEqual(float(rows[0,14]),.8,places=6)

    def test_nms_suppresses_duplicate_predictions(self):
        values=tensors()
        for index,offset in [(162,0),(163,-1)]:
            values[0][0,index]=1
            values[3][0,index]=.81 if index==162 else .64
            values[6][0,index]=[offset,0,np.log(4),np.log(4)]
        self.assertEqual(decode(values).shape,(1,15))

    def test_malformed_or_nonfinite_tensors_are_rejected(self):
        with self.assertRaises(ValueError): decode(tensors()[:11])
        values=tensors();values[0][0,0,0]=np.nan
        with self.assertRaises(ValueError): decode(values)
        values=tensors();values[0]=values[0].astype(np.float64)
        with self.assertRaises(ValueError): decode(values)

    def test_unbounded_box_is_rejected(self):
        values=tensors();values[0][0,0]=1;values[3][0,0]=1;values[6][0,0,2:]=1000
        with self.assertRaises(ValueError): decode(values)
