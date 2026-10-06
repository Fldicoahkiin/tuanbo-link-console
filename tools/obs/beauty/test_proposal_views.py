import unittest
from types import SimpleNamespace
import numpy as np
from proposal_views import tiled_proposals


class ProposalViewTests(unittest.TestCase):
    def test_batch_keeps_coordinate_mapping_and_view_order(self):
        image=np.zeros((120,140,3),dtype=np.uint8);image[30:90,20:100]=1
        box=np.array([[32,32,32,32,*([48,48]*5),.9]],dtype=np.float32)
        seen=[]
        def locate_many(images):
            seen.extend(images)
            return [box,None,None]
        result=tiled_proposals(SimpleNamespace(locate_many=locate_many),image,256,batched=True)
        self.assertEqual(len(seen),3)
        np.testing.assert_allclose(result[0,:4],[30,40,10,10],atol=1e-5)
        np.testing.assert_allclose(result[0,4:14],[35,45]*5,atol=1e-5)

    def test_batch_one_pixel_content_does_not_duplicate_logical_views(self):
        image=np.zeros((4,4,3),dtype=np.uint8);image[2,2]=1
        def locate_many(images):
            self.assertEqual(len(images),1)
            return [None]
        self.assertIsNone(tiled_proposals(SimpleNamespace(locate_many=locate_many),image,256,batched=True))

    def test_batch_missing_output_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'view count'):
            tiled_proposals(SimpleNamespace(locate_many=lambda _:[]),np.ones((10,10,3),dtype=np.uint8),256,batched=True)

    def test_crop_boxes_and_five_points_map_back_to_original_coordinates(self):
        rgb=np.zeros((120,140,3),dtype=np.uint8)
        rgb[30:90,20:100]=1
        box=np.array([[32,32,32,32,*([48,48]*5),.9]],dtype=np.float32)
        outputs=iter((box,None,None))
        result=tiled_proposals(SimpleNamespace(locate=lambda _: next(outputs)),rgb,256)
        np.testing.assert_allclose(result[0,:4],[30,40,10,10],atol=1e-5)
        np.testing.assert_allclose(result[0,4:14],[35,45]*5,atol=1e-5)
        np.testing.assert_array_equal(box[0,:4],[32,32,32,32])

    def test_one_pixel_content_does_not_create_empty_crops(self):
        shapes=[]
        def locate(rgb):
            shapes.append(rgb.shape)
            return None
        image=np.zeros((4,4,3),dtype=np.uint8);image[2,2]=1
        self.assertIsNone(tiled_proposals(SimpleNamespace(locate=locate),image,256))
        self.assertEqual(shapes,[(256,256,3)])

    def test_empty_canvas_does_not_trigger_supplemental_views(self):
        shapes=[]
        def locate(rgb):
            shapes.append(rgb.shape)
            return None
        self.assertIsNone(tiled_proposals(SimpleNamespace(locate=locate),np.zeros((4,4,3),dtype=np.uint8),256))
        self.assertEqual(len(shapes),0)

    def test_portrait_canvas_runs_only_three_active_content_views(self):
        shapes=[]
        def locate(rgb):
            shapes.append(rgb.shape)
            return None
        image=np.zeros((640,360,3),dtype=np.uint8)
        image[217:420]=1
        tiled_proposals(SimpleNamespace(locate=locate),image,640)
        self.assertEqual(shapes,[(361,640,3),(577,640,3),(577,640,3)])
