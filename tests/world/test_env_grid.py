"""grid.bin carries the environment as grids and rebuilds pos.f32 / uv.f32 / idx.u32 (stable-grid.mjs reads it).
This decodes it the way the viewer does and compares with the three buffers make-world also writes."""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_env  # noqa: E402
from world_common import Camera, Mesh  # noqa: E402


def decode(rec_by_part, grid, bin_bytes, tan_x, tan_y):
    """the viewer's decodeGrid, in numpy"""
    out = {}
    for g in grid["parts"]:
        rec, w, h = rec_by_part[g["part"]], g["w"], g["h"]
        us = np.frombuffer(bin_bytes, np.float32, w, g["u"])
        vs = np.frombuffer(bin_bytes, np.float32, h, g["v"])
        z = np.frombuffer(bin_bytes, np.float32, w * h, g["z"]["at"]).astype(np.float64)
        u, v = np.tile(us.astype(np.float64), h), 1 - np.repeat(vs.astype(np.float64), w)
        pos = np.stack([(u - 0.5) * 2 * tan_x * z, -(v - 0.5) * 2 * tan_y * z, -z], 1)
        uv = np.stack([np.tile(us, h), np.repeat(vs, w)], 1)
        keep = np.ones((h - 1) * (w - 1), bool) if g["keep"] is None else \
            np.unpackbits(np.frombuffer(bin_bytes, np.uint8, -(-(w - 1) * (h - 1) // 8), g["keep"]))[:(w - 1) * (h - 1)].astype(bool)
        q = np.nonzero(keep)[0]
        a = (q // (w - 1)) * w + q % (w - 1)
        idx = np.stack([a, a + w, a + 1, a + 1, a + w, a + w + 1], 1).ravel()
        out[g["part"]] = (rec, pos, uv, idx)
    return out


class EnvGrid(unittest.TestCase):
    def build(self):
        cam = Camera(tan_y=0.4, src_w=320, src_h=180, scale=2.0)
        h, w = 36, 64
        ys, xs = np.mgrid[0:h, 0:w]
        depth = 3.0 + 0.04 * ys + 0.5 * np.sin(xs / 7.0)
        depth[10:20, 30:34] = 1.2                               # a near post: its edge quads are dropped
        valid = np.ones((h, w), bool)
        valid[0:3, 0:5] = False
        weight = np.zeros((h, w))
        mesh = Mesh()
        rec, fill = world_env.env_geometry(mesh, cam, depth, weight, valid, pad=0.5)
        return cam, mesh, rec, fill

    def test_grid_rebuilds_the_buffers(self):
        cam, mesh, rec, fill = self.build()
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            grid = mesh.save(d, cam.tan_x, cam.tan_y)
            self.assertIsNotNone(grid)
            pos = np.fromfile(d / "pos.f32", np.float32).reshape(-1, 3)
            uv = np.fromfile(d / "uv.f32", np.float32).reshape(-1, 2)
            idx = np.fromfile(d / "idx.u32", np.uint32)
            raw = (d / "grid.bin").read_bytes()
            self.assertLess(len(raw), 0.2 * sum((d / f).stat().st_size for f in ("pos.f32", "uv.f32", "idx.u32")))
            parts = decode({"env": rec, "fill": fill}, grid, raw, cam.tan_x, cam.tan_y)
            self.assertEqual(sorted(parts), ["env", "fill"])
            self.assertIsNotNone(next(g for g in grid["parts"] if g["part"] == "env")["keep"])   # the post's edges are cut
            for r, p, t, i in parts.values():
                vo, vc, io, ic = r["vertOffset"], r["vertCount"], r["idxOffset"], r["idxCount"]
                np.testing.assert_array_equal(t, uv[vo:vo + vc])
                np.testing.assert_array_equal(i, idx[io:io + ic])
                np.testing.assert_allclose(p, pos[vo:vo + vc], rtol=1e-6, atol=1e-6)

    def test_a_part_that_is_not_a_lens_grid_gets_no_grid(self):
        cam, mesh, rec, fill = self.build()
        mesh.pos[0][:, 0] += np.float32(0.05)                    # x off the lens ray: not a lens grid any more
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(mesh.save(Path(d), cam.tan_x, cam.tan_y))
            self.assertFalse((Path(d) / "grid.bin").exists())
            self.assertTrue((Path(d) / "pos.f32").exists())

    def test_the_grid_ships_alone_unless_the_buffers_are_asked_for(self):
        cam, mesh, rec, fill = self.build()
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNotNone(mesh.save(Path(d), cam.tan_x, cam.tan_y, buffers=False))
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ["grid.bin"])

    def test_without_a_grid_the_buffers_are_written_anyway(self):
        cam, mesh, rec, fill = self.build()
        mesh.pos[0][:, 0] += np.float32(0.05)
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(mesh.save(Path(d), cam.tan_x, cam.tan_y, buffers=False))
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ["idx.u32", "pos.f32", "uv.f32"])

    def test_a_part_outside_the_grid_keeps_the_buffers(self):
        cam, mesh, rec, fill = self.build()
        mesh.emit(np.zeros((3, 3), np.float32), np.zeros((3, 2), np.float32), np.array([0, 1, 2], np.uint32))
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(mesh.save(Path(d), cam.tan_x, cam.tan_y, buffers=False))   # the grid would drop that part
            self.assertTrue((Path(d) / "pos.f32").exists())


if __name__ == "__main__":
    unittest.main()
