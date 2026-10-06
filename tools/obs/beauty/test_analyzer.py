import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from analyzer import FaceAnalyzer, analysis_views, merge_faces, occupied_views
from landmarks import POINT_KEYS


class ViewsTest(unittest.TestCase):
    def test_empty_tiles_are_omitted_without_thresholding_dark_content(self):
        rgb = np.zeros((640,360,3),dtype=np.uint8)
        self.assertEqual(occupied_views(rgb), [])
        rgb[217:420] = 1
        kept = occupied_views(rgb)
        original = list(enumerate(analysis_views(360,640)))
        self.assertLess(len(kept),len(original))
        self.assertEqual([order for order,_ in kept],sorted(order for order,_ in kept))
        coverage = np.zeros(rgb.shape[:2],dtype=np.uint8)
        for order,bounds in kept:
            self.assertEqual(original[order],(order,bounds))
            x0,y0,x1,y1 = bounds
            coverage[y0:y1,x0:x1] += 1
        self.assertTrue(np.all(coverage[217:420] > 0))
        # A single dark byte in an otherwise empty tile keeps every view that
        # contains it. No black-border or skin-color threshold is introduced.
        rgb[:] = 0
        rgb[0,0,1] = 1
        self.assertEqual(occupied_views(rgb), [(order,bounds) for order,bounds in original
            if bounds[0] == 0 and bounds[1] == 0])

    def check_views(self, height, width, expected):
        calls = []
        regions = []
        # Overlapping crops both find the same face; remapping must deduplicate it.
        for center in (0.8, 0.2):
            face = {key: 0.5 for key in POINT_KEYS}
            face.update(cx=0.5, cy=0.5, rx=0.1, ry=0.1, lx=0.45, ex=0.55, ly=0.5, ey=0.5)
            axis = 'y' if height > width else 'x'
            for key in list(face):
                if key.endswith(axis) and key not in ('rx', 'ry'):
                    face[key] = center
            regions.append(face)

        def detect(image):
            calls.append(image.numpy_view().shape[:2])
            return SimpleNamespace(face_landmarks=[] if len(calls) == 1 else [object()])

        analyzer = FaceAnalyzer.__new__(FaceAnalyzer)
        with patch('analyzer.face_region', side_effect=regions):
            candidates = analyzer._analyze_views(SimpleNamespace(detect=detect), np.zeros((height, width, 3), dtype=np.uint8), list(enumerate(analysis_views(width,height)[:3])))
            faces = merge_faces(candidates)
        self.assertEqual(calls, expected)
        self.assertEqual(len(faces), 1)
        self.assertAlmostEqual(faces[0]['cx'], 0.5)
        self.assertAlmostEqual(faces[0]['cy'], 0.5)
        self.assertAlmostEqual(faces[0]['rx'], 0.1 if height > width else 0.0625)
        self.assertAlmostEqual(faces[0]['ry'], 0.0625 if height > width else 0.1)

    def test_portrait_remaps_vertical_crops(self):
        self.check_views(640, 360, [(640, 360), (400, 360), (400, 360)])

    def test_landscape_preserves_horizontal_crops(self):
        self.check_views(360, 640, [(360, 640), (360, 400), (360, 400)])

    def test_small_views_cover_frame_edges_in_both_orientations(self):
        for width,height in [(640,360),(360,640),(640,640),(640,220)]:
            views=analysis_views(width,height)
            self.assertLessEqual(len(views),28)
            coverage=np.zeros((height,width),dtype=np.uint8)
            for x0,y0,x1,y1 in views[3:]:
                self.assertTrue(0<=x0<x1<=width and 0<=y0<y1<=height)
                self.assertLessEqual(max(x1-x0,y1-y0),160)
                coverage[y0:y1,x0:x1]+=1
            self.assertTrue(np.all(coverage>0))

    def test_parallel_completion_order_cannot_duplicate_or_reorder_faces(self):
        first={'cx':.2,'cy':.5,'rx':.05,'ry':.08}
        duplicate={**first,'cx':.201}
        second={**first,'cx':.7}
        self.assertEqual(merge_faces([(8,duplicate),(4,second),(0,first)]),[first,second])

    def test_tile_boundary_partial_face_is_not_promoted(self):
        face={key:.5 for key in POINT_KEYS};face.update(cx=.04,cy=.5,rx=.1,ry=.1,lx=.02,ex=.06,ly=.5,ey=.5)
        detector=SimpleNamespace(detect=lambda _:SimpleNamespace(face_landmarks=[object()]))
        analyzer=FaceAnalyzer.__new__(FaceAnalyzer)
        with patch('analyzer.face_region',return_value=face):
            self.assertEqual(analyzer._analyze_views(detector,np.zeros((360,640,3),dtype=np.uint8),[(3,(0,0,160,160))]),[])

    def test_supplementary_candidates_preserve_baseline_priority_and_limit(self):
        baseline=[{'cx':.1+index*.15,'cy':.4,'rx':.03,'ry':.05} for index in range(5)]
        candidates=[{**baseline[0],'cx':.101},
                    {'cx':.3,'cy':.8,'rx':.03,'ry':.05},
                    {'cx':.6,'cy':.8,'rx':.03,'ry':.05}]
        merged=merge_faces(list(enumerate(baseline+candidates)))
        self.assertEqual(merged,baseline+[candidates[1]])


if __name__ == '__main__':
    unittest.main()
