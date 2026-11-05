"""Geometry for a multi-view DA3 scene in the live builder.

DA3 extrinsics map world coordinates to camera coordinates. Inverting each
pose before lifting pixels removes camera motion from the resulting positions.
"""
import cv2
import numpy as np


class MovingCameras:
    def __init__(self, intrinsics, extrinsics, scale):
        self.intrinsics = np.asarray(intrinsics, dtype=np.float64)
        extrinsics = np.asarray(extrinsics, dtype=np.float64)
        if extrinsics.shape[1:] == (3, 4):
            bottom = np.broadcast_to([0, 0, 0, 1], (len(extrinsics), 1, 4))
            extrinsics = np.concatenate((extrinsics, bottom), axis=1)
        # Express the shared DA3 world in the first camera's coordinate frame.
        # DA3 may choose a different reference view internally.
        extrinsics = extrinsics @ np.linalg.inv(extrinsics[0])
        self.camera_to_world = np.linalg.inv(extrinsics)
        if not np.isfinite(scale) or scale <= 0:
            raise ValueError("Median scene depth must be positive and finite")
        self.scale = float(scale)

    def lift(self, i, x, y, depth):
        """Lift pixels at DA3 resolution into normalized Three.js coordinates."""
        x, y, depth = np.broadcast_arrays(x, y, depth)
        pixels = np.stack((x.ravel(), y.ravel(), np.ones(x.size)))
        camera = (np.linalg.inv(self.intrinsics[i]) @ pixels) * depth.ravel()
        pose = self.camera_to_world[i]
        world = pose[:3, :3] @ camera + pose[:3, 3:4]
        return (world.T * np.array([1, -1, -1]) / self.scale).astype(np.float32).reshape(x.shape + (3,))


def background_mask(labels, confidence, sky, overlay=1.0, confidence_floor=0):
    """Exclude all tracked subjects, including unselected ones, from a keyframe."""
    h, w = confidence.shape
    labels = cv2.resize(labels, (w, h), interpolation=cv2.INTER_NEAREST)
    subject = cv2.dilate((labels != 0).astype(np.uint8), np.ones((11, 11), np.uint8)) != 0
    return (~subject & ~np.asarray(sky, dtype=bool) & np.isfinite(confidence)
            & (confidence >= confidence_floor) & (np.arange(h)[:, None] < h * overlay))
