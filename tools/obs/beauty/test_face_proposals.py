import unittest
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import numpy as np
from face_proposals import FaceProposals, proposal_error, proposal_crop
from landmarks import POINT_KEYS


def fixture():
    box = np.array([20, 20, 60, 70, 35, 40, 65, 40, 50, 55, 38, 70, 62, 70, .9])
    face = dict(cx=.5, cy=.55, lx=.35, ly=.4, ex=.65, ey=.4,
                p1x=.5, p1y=.55, p61x=.38, p61y=.7, p291x=.62, p291y=.7, rx=.3, ry=.35)
    return face, box


class FaceProposalTest(unittest.TestCase):
    def test_unverified_model_is_rejected_before_native_initialization(self):
        with patch('face_proposals.cv2.setNumThreads') as configure:
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                FaceProposals(b'landmarks', b'unverified proposal model')
        configure.assert_not_called()

    def test_alignment_is_scale_invariant_and_allows_symmetric_naming(self):
        face, box = fixture()
        self.assertAlmostEqual(proposal_error(face, box, 100, 100), 0)
        scaled = box.copy(); scaled[:14] *= 2
        self.assertAlmostEqual(proposal_error(face, scaled, 200, 200), 0)
        swapped = box.copy(); swapped[4:8] = box[[6, 7, 4, 5]]; swapped[10:14] = box[[12, 13, 10, 11]]
        self.assertAlmostEqual(proposal_error(face, swapped, 100, 100), 0)

    def test_neck_or_displaced_mesh_does_not_agree_with_face_proposal(self):
        face, box = fixture()
        self.assertIsNone(proposal_error({**face, 'cx': .99}, box, 100, 100))
        self.assertGreater(proposal_error({**face, 'p1x': .95, 'p1y': .05}, box, 100, 100), .18)
        self.assertIsNone(proposal_error({**face, 'p1x': float('nan')}, box, 100, 100))

    def test_crop_stays_in_source_and_rejects_outside_box(self):
        _, box = fixture()
        self.assertEqual(proposal_crop(box, 100, 100), (0, 0, 100, 100))
        box[0] = 500
        self.assertIsNone(proposal_crop(box, 100, 100))

    def test_existing_agreed_face_is_retained_without_landmark_rework(self):
        face, box = fixture()
        analyzer = FaceProposals.__new__(FaceProposals)
        analyzer.locator = None
        analyzer.proposals = SimpleNamespace(setInputSize=lambda size: None, detect=lambda rgb: (None, np.array([box])))
        analyzer.detectors = [object(), object(), object()]
        calls = []
        analyzer._analyze = lambda detector, rgb, proposals: calls.extend(proposals) or []
        with ThreadPoolExecutor(max_workers=3) as executor:
            analyzer.executor = executor
            result = analyzer.analyze(np.zeros((100, 100, 3), dtype=np.uint8), [face])
        self.assertEqual(result, [face])
        self.assertEqual(calls, [])

    def test_no_proposals_retains_existing_and_bad_tensor_is_explicit(self):
        face, _ = fixture()
        analyzer = FaceProposals.__new__(FaceProposals)
        analyzer.locator = None
        analyzer.proposals = SimpleNamespace(setInputSize=lambda size: None, detect=lambda rgb: (None, None))
        self.assertEqual(analyzer.analyze(np.zeros((100, 100, 3), dtype=np.uint8), [face]), [face])
        analyzer.proposals.detect = lambda rgb: (None, np.zeros((1, 14)))
        with self.assertRaisesRegex(ValueError, 'Malformed'):
            analyzer.analyze(np.zeros((100, 100, 3), dtype=np.uint8), [face])

    def test_regional_mesh_must_agree_with_its_proposal(self):
        face, box = fixture()
        face = {**{key: .5 for key in POINT_KEYS}, **face}
        detector = SimpleNamespace(detect=lambda image, box: object())
        analyzer = FaceProposals.__new__(FaceProposals)
        analyzer.locator = None
        with patch('face_proposals.face_region', return_value={**face, 'p1x': .99}):
            self.assertEqual(analyzer._analyze(detector, np.zeros((100, 100, 3), dtype=np.uint8), [(7, box, (0, 0, 100, 100))]), [])
        with patch('face_proposals.face_region', return_value=face.copy()):
            result = analyzer._analyze(detector, np.zeros((100, 100, 3), dtype=np.uint8), [(7, box, (0, 0, 100, 100))])
        self.assertEqual(result, [(7, face)])


if __name__ == '__main__':
    unittest.main()
