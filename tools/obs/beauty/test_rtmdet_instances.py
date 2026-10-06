import unittest

import numpy as np

from rtmdet_instances import suppress_duplicate_masks


class InstanceDeduplicationTest(unittest.TestCase):
    def test_nested_duplicate_keeps_confidence_order(self):
        first=np.zeros((100,100),dtype=np.float32);first[:80]=1
        second=np.ones_like(first)
        kept=suppress_duplicate_masks([first,second])
        self.assertEqual(len(kept),1)
        self.assertIs(kept[0],first)
        np.testing.assert_array_equal(second,np.ones_like(first))

    def test_two_overlapping_people_are_not_merged(self):
        first=np.zeros((100,100),dtype=np.float32);first[:,:90]=1
        second=np.zeros_like(first);second[:,10:]=1
        kept=suppress_duplicate_masks([first,second])
        self.assertEqual(len(kept),2)

    def test_small_person_inside_large_box_is_not_suppressed(self):
        first=np.ones((100,100),dtype=np.float32)
        second=np.zeros_like(first);second[30:60,30:60]=1
        self.assertEqual(len(suppress_duplicate_masks([first,second])),2)


if __name__=='__main__': unittest.main()
