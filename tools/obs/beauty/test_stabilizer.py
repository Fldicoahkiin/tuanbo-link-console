import unittest
from stabilizer import GeometryStabilizer
from landmarks import POINT_IDS


def face(x=.3, y=.4):
    return dict(cx=x, cy=y, rx=.12, ry=.2, lx=x-.04, ly=y-.04,
                ex=x+.04, ey=y-.04, smooth=.5, white=.25, slim=.4, eye=.3,
                **{f"p{point}{axis}": x if axis == "x" else y for point in POINT_IDS for axis in "xy"})


class StabilizerTest(unittest.TestCase):
    def test_jitter_is_reduced_without_changing_strength(self):
        subject = GeometryStabilizer()
        measured, filtered = [], []
        for index in range(80):
            sample = face(.3 + (.001 if index % 2 else -.001))
            result = subject.update([sample], index * 67, (1, 640, 360))[0]
            measured.append(abs(sample['cx'] - .3))
            filtered.append(abs(result['cx'] - .3))
            self.assertEqual(result['smooth'], sample['smooth'])
        self.assertLess(sum(filtered[10:]), sum(measured[10:]) * .65)

    def test_detection_order_is_not_a_member_binding(self):
        subject = GeometryStabilizer()
        subject.update([face(.25), face(.75)], 100, 1)
        result = subject.update([face(.751), face(.251)], 167, 1)
        self.assertGreater(result[0]['cx'], .7)
        self.assertLess(result[1]['cx'], .3)

    def test_missing_faces_disappear_immediately(self):
        subject = GeometryStabilizer()
        subject.update([face()], 100, 1)
        self.assertEqual(subject.update([], 167, 1), [])
        incoming = face(.301)
        self.assertEqual(subject.update([incoming], 234, 1), [incoming])

    def test_cut_pause_and_epoch_reset_do_not_blend(self):
        for stamp, context, incoming in [(167, 2, face(.301)), (500, 1, face(.301)),
                                         (90, 1, face(.301)), (167, 1, face(.8))]:
            subject = GeometryStabilizer()
            subject.update([face()], 100, 1)
            self.assertEqual(subject.update([incoming], stamp, context), [incoming])

    def test_overlap_ambiguity_does_not_mix_people(self):
        subject = GeometryStabilizer()
        subject.update([face(.29), face(.31)], 100, 1)
        incoming = [face(.299), face(.301)]
        self.assertEqual(subject.update(incoming, 167, 1), incoming)

    def test_motion_lag_is_bounded(self):
        subject = GeometryStabilizer()
        for index in range(30):
            incoming = face(.15 + index * .02)
            result = subject.update([incoming], index * 67, 1)[0]
            self.assertLessEqual(abs(result['cx'] - incoming['cx']), incoming['rx'] * .03)


if __name__ == '__main__':
    unittest.main()
