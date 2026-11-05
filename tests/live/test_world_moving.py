"""Geometry checks for the moving-camera reconstruction."""
import sys
import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend' / 'tools'))
from world_moving import MovingCameras, background_mask


class MovingCameraGeometryTests(unittest.TestCase):
    def test_camera_translation_is_subtracted_from_a_stationary_subject(self):
        intrinsics = np.repeat(np.eye(3)[None], 2, axis=0)
        extrinsics = np.repeat(np.eye(4)[None], 2, axis=0)
        extrinsics[1, 0, 3] = -1
        cameras = MovingCameras(intrinsics, extrinsics, 2)
        first = cameras.lift(0, 1, 0, 2)
        second = cameras.lift(1, 0.5, 0, 2)
        np.testing.assert_allclose(first, second)
        np.testing.assert_allclose(first, [1, 0, -1])

    def test_rotation_and_three_by_four_extrinsics(self):
        extrinsics = np.array([np.eye(4)[:3], [[0, 0, -1, 0], [0, 1, 0, 0], [1, 0, 0, 0]]])
        cameras = MovingCameras(np.repeat(np.eye(3)[None], 2, axis=0), extrinsics, 1)
        np.testing.assert_allclose(cameras.lift(1, 0, 0, 1), [1, 0, 0])

    def test_first_camera_is_the_reference_even_if_da3_uses_another(self):
        extrinsics = np.repeat(np.eye(4)[None], 2, axis=0)
        extrinsics[:, 0, 3] = 3
        cameras = MovingCameras(np.repeat(np.eye(3)[None], 2, axis=0), extrinsics, 1)
        np.testing.assert_allclose(cameras.lift(0, 0, 0, 1), [0, 0, -1])

    def test_background_removes_every_subject_and_invalid_regions(self):
        labels = np.zeros((40, 40), np.uint8)
        labels[10, 10], labels[10, 30] = 1, 2
        confidence = np.ones((40, 40))
        confidence[0, 0] = np.nan
        sky = np.zeros((40, 40), bool)
        sky[0, 1] = True
        mask = background_mask(labels, confidence, sky, overlay=0.75, confidence_floor=0.5)
        self.assertFalse(mask[10, 10])
        self.assertFalse(mask[10, 30])
        self.assertFalse(mask[10, 15])  # dilated mask edge
        self.assertFalse(mask[0, 0])
        self.assertFalse(mask[0, 1])
        self.assertFalse(mask[35, 20])
        self.assertTrue(mask[20, 20])

    def test_moving_publisher_writes_world_path_and_cloud_schema(self):
        import world_preview
        class Work:
            fps, w, h = 2, 20, 10
        rows = [dict(i=0, t=0, fx=10, fy=8, ground=1, width=4, body_width=0.2),
                dict(i=1, t=0.5, fx=9, fy=8, ground=1, width=4, body_width=0.2)]
        positions = {1: [np.array([0, 0, -1]), np.array([1, 0, -1])]}
        with tempfile.TemporaryDirectory() as folder, patch.object(world_preview, 'LIVE', Path(folder)):
            world_preview.publish_moving_cloud(Work(), np.zeros((10, 20, 3), np.uint8), {1: rows}, positions,
                np.ones((2, 3), np.float32), np.ones((2, 3), np.uint8),
                np.ones((1, 3), np.float32), np.ones((1, 3), np.uint8), [], 60, np.zeros((2, 3)))
            motion = json.loads((Path(folder) / 'motion.json').read_text())
            cloud = json.loads((Path(folder) / 'cloud.json').read_text())
            self.assertEqual(motion['tracks'][0]['angle'], 90)
            self.assertEqual(motion['tracks'][0]['path'][-1], [1, 0, -1])
            self.assertEqual(cloud['bg']['n'], 2)
            self.assertEqual((Path(folder) / cloud['trail']['pos']).stat().st_size, 12)

    def test_zero_depth_scale_rejected(self):
        with self.assertRaises(ValueError):
            MovingCameras(np.eye(3)[None], np.eye(4)[None], 0)


if __name__ == '__main__':
    unittest.main()
