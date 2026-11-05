"""Actual production leftovers function; synthetic pixels and a stub subprocess only."""
import ast
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image

SOURCE = Path(__file__).resolve().parents[2] / 'backend/tools/world_env.py'
TREE = ast.parse(SOURCE.read_text())
FUNCTIONS = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and
             n.name in {'plate_fingerprint', 'plate_evidence_path', 'leftovers'}]


class PlateCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='construct-plate-unit-')
        self.work = SimpleNamespace(dir=Path(self.tmp.name), w=4, h=4, tracks={'concept': 'cat'})
        self.plate = np.full((4, 4, 3), 100, np.uint8)
        self.fills = []
        def fill(image, hole):
            self.fills.append(hole.copy())
            return image.copy()
        env = {'__file__': str(SOURCE), 'Path': Path, 'Image': Image, 'cv2': cv2,
               'np': np, 'math': math, 'hashlib': hashlib, 'json': json, 'fill': fill}
        exec(compile(ast.Module(body=FUNCTIONS, type_ignores=[]), str(SOURCE), 'exec'), env)
        self.leftovers = env['leftovers']

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, evidence, code=0, **kwargs):
        stdout = evidence if isinstance(evidence, str) else json.dumps(evidence)
        result = SimpleNamespace(returncode=code, stdout=stdout, stderr='fixture diagnostic')
        with patch.object(subprocess, 'run', return_value=result) as run:
            out = self.leftovers(self.work, self.plate, 1.0, **kwargs)
        return out, run

    def test_transport_failure_is_not_zero_leftovers(self):
        with self.assertRaises(RuntimeError):
            self.call({'checked': True, 'found': False, 'share': 0}, code=1)
        self.assertEqual(self.fills, [])

    def test_timeout_stays_unverified_without_raw_child_output(self):
        with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('fixture', 60)):
            with self.assertRaisesRegex(RuntimeError, 'cleanliness is unverified'):
                self.leftovers(self.work, self.plate, 1.0)
        self.assertEqual(self.fills, [])

    def test_malformed_or_incomplete_evidence_is_unknown(self):
        for evidence in ['garbage', '', {}, {'found': False, 'share': 0},
                         {'checked': False, 'found': False, 'share': 0},
                         {'checked': True, 'found': 'false', 'share': 0},
                         {'checked': True, 'found': False, 'share': None},
                         {'checked': True, 'found': False, 'share': True},
                         {'checked': True, 'found': False, 'share': -1},
                         {'checked': True, 'found': True, 'share': 1.1},
                         {'checked': True, 'found': True, 'share': float('nan')},
                         {'checked': True, 'found': True, 'share': float('inf')},
                         {'checked': True, 'found': False, 'share': .5},
                         {'checked': True, 'found': True, 'share': 0}]:
            with self.subTest(evidence=evidence), self.assertRaises(RuntimeError):
                self.call(evidence)
        self.assertEqual(self.fills, [])

    def test_valid_empty_result_preserves_pixels_without_fill(self):
        (plate, share), run = self.call({'checked': True, 'found': False, 'share': 0})
        np.testing.assert_array_equal(plate, self.plate)
        self.assertEqual(share, 0)
        self.assertEqual(self.fills, [])
        self.assertEqual(run.call_args.kwargs['timeout'], 60)

    def test_nonempty_result_requires_matching_source_raster_and_count(self):
        for shape, count in [((2, 2), 1), ((4, 4), 2)]:
            mask = np.zeros(shape, np.uint8)
            mask.flat[:count] = 255
            Image.fromarray(mask).save(self.work.dir / 'plate_leftover.png')
            with self.subTest(shape=shape, count=count), self.assertRaises(RuntimeError):
                self.call({'checked': True, 'found': True, 'share': 1 / 16})
        self.assertEqual(self.fills, [])

    def test_missing_nonempty_mask_is_not_zero(self):
        with self.assertRaises(RuntimeError):
            self.call({'checked': True, 'found': True, 'share': 1 / 16})
        self.assertEqual(self.fills, [])

    def test_uncached_zero_request_budget_refuses_before_subprocess(self):
        with patch.object(subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'uncached'):
                self.leftovers(self.work, self.plate, 1.0, allow_request=False)
            run.assert_not_called()

    def test_clean_evidence_reuses_without_new_call(self):
        self.call({'checked': True, 'found': False, 'share': 0})
        with patch.object(subprocess, 'run') as run:
            plate, share = self.leftovers(self.work, self.plate, 1.0, allow_request=False)
            run.assert_not_called()
        self.assertEqual(share, 0)
        np.testing.assert_array_equal(plate, self.plate)

    def test_repaired_plate_retains_original_share_without_new_sam_call(self):
        mask = np.zeros((4, 4), np.uint8)
        mask[1, 1] = 255
        Image.fromarray(mask).save(self.work.dir / 'plate_leftover.png')
        self.leftovers.__globals__['fill'] = lambda plate, hole: np.zeros_like(plate)
        (filled, original_share), _ = self.call({'checked': True, 'found': True, 'share': 1 / 16})
        self.assertFalse(np.array_equal(filled, self.plate))
        with patch.object(subprocess, 'run') as run:
            again, share = self.leftovers(self.work, filled, 1.0, allow_request=False)
            run.assert_not_called()
        self.assertEqual(share, original_share)
        self.assertEqual(share, 1 / 16)
        np.testing.assert_array_equal(again, filled)
        record = json.loads(next((self.work.dir / 'plate-checks').glob('*.json')).read_text())
        self.assertNotEqual(record['in_sha'], record['out_sha'])

    def test_repeating_original_input_accepts_identical_existing_output_evidence(self):
        mask = np.zeros((4, 4), np.uint8)
        mask[1, 1] = 255
        Image.fromarray(mask).save(self.work.dir / 'plate_leftover.png')
        self.leftovers.__globals__['fill'] = lambda plate, hole: np.zeros_like(plate)
        (first, share), _ = self.call({'checked': True, 'found': True, 'share': 1 / 16})
        (second, again), run = self.call({'checked': True, 'found': True, 'share': 1 / 16})
        run.assert_called_once()
        self.assertEqual(share, again)
        np.testing.assert_array_equal(first, second)
        self.assertEqual(len(list((self.work.dir / 'plate-checks').glob('*.json'))), 1)

    def test_conflicting_output_evidence_refuses_without_overwrite(self):
        mask = np.zeros((4, 4), np.uint8)
        mask[1, 1] = 255
        Image.fromarray(mask).save(self.work.dir / 'plate_leftover.png')
        self.leftovers.__globals__['fill'] = lambda plate, hole: np.zeros_like(plate)
        self.call({'checked': True, 'found': True, 'share': 1 / 16})
        mask[1, 2] = 255
        Image.fromarray(mask).save(self.work.dir / 'plate_leftover.png')
        with self.assertRaisesRegex(RuntimeError, 'conflicting plate evidence'):
            self.call({'checked': True, 'found': True, 'share': 2 / 16})
        record = json.loads(next((self.work.dir / 'plate-checks').glob('*.json')).read_text())
        self.assertEqual(record['share'], 1 / 16)
        self.assertEqual(record['checked_stage'], 'input')
        self.assertIs(record['output_rechecked'], False)
        self.assertEqual(record['version'], 2)
        self.assertIn('lib/sam-image-result.mjs', record['source_sha256'])

    def test_changed_pixels_prompt_or_overlay_cannot_reuse_clean_evidence(self):
        self.call({'checked': True, 'found': False, 'share': 0})
        for changed, concept, overlay in [(self.plate + 1, 'cat', 1.0),
                                          (self.plate, 'dog', 1.0),
                                          (self.plate, 'cat', 0.5)]:
            self.work.tracks['concept'] = concept
            with self.subTest(concept=concept, overlay=overlay), patch.object(subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'uncached'):
                    self.leftovers(self.work, changed, overlay, allow_request=False)
                run.assert_not_called()

    def test_corrupt_evidence_refuses_instead_of_rebuying_or_passing(self):
        self.call({'checked': True, 'found': False, 'share': 0})
        p = next((self.work.dir / 'plate-checks').glob('*.json'))
        for bad in ['bad json', '[]', '{}', '{"checked":true,"share":null}']:
            p.write_text(bad)
            with self.subTest(bad=bad), patch.object(subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'cached plate evidence is invalid'):
                    self.leftovers(self.work, self.plate, 1.0, allow_request=False)
                run.assert_not_called()

    def test_valid_found_result_uses_existing_fill_and_share(self):
        mask = np.zeros((4, 4), np.uint8)
        mask[1, 1] = 255
        Image.fromarray(mask).save(self.work.dir / 'plate_leftover.png')
        (plate, share), _ = self.call({'checked': True, 'found': True, 'share': 1 / 16})
        self.assertEqual(share, 1 / 16)
        self.assertEqual(len(self.fills), 1)
        self.assertTrue(self.fills[0][1, 1])
        np.testing.assert_array_equal(plate, self.plate)


class SkippedPlateEvidenceTests(unittest.TestCase):
    def values_for(self, skipped, share=0.0):
        source = SOURCE.with_name('make-world.py')
        main = next(n for n in ast.parse(source.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        init = next(n for n in main.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'left' for t in n.targets))
        conditional = next(n for n in main.body if isinstance(n, ast.If) and 'SKIP_PLATE_CHECK' in ast.unparse(n.test))
        values = next(n for n in main.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'values' for t in n.targets))
        add_evidence = next(n for n in main.body if isinstance(n, ast.If) and ast.unparse(n.test) == 'left is not None')
        plate = np.zeros((4, 4, 3), np.uint8)
        calls = []
        def checked(work, pixels, overlay):
            calls.append(True)
            return pixels, share
        env = {'np': np, 'json': json, 'hashlib': hashlib, 'os': SimpleNamespace(environ={'SKIP_PLATE_CHECK': '1'} if skipped else {}),
               'work': SimpleNamespace(), 'plate': plate, 'overlay': 1.0, 'leftovers': checked, 'stop_after_cloud': False,
               'live_page': SimpleNamespace(detail=lambda *a, **k: None),
               'ident': {'switches': 0, 'unexplained': 0, 'longest': 0}, 'by_track': {1: []},
               'raw_gaps': [0], 'hits': [0], 'capped': [0], 'raw_jitter': [0],
               'final_jitter': [0], 'unseen': 0, 'residue': 0, 'liveness': 1}
        fingerprint = next(n for n in FUNCTIONS if n.name == 'plate_fingerprint')
        exec(compile(ast.Module(body=[fingerprint, init, conditional, values, add_evidence], type_ignores=[]), str(source), 'exec'), env)
        return env['values'], calls

    def test_skip_omits_measurement_instead_of_recording_zero(self):
        values, calls = self.values_for(True)
        self.assertNotIn('animal left in the plate (filled)', values)
        self.assertEqual(calls, [])

    def test_unchanged_pixels_keep_positive_share_without_touching_depth(self):
        # The work stub has no dir: any unintended plate/depth write would fail.
        values, calls = self.values_for(False, share=0.25)
        self.assertEqual(values['animal left in the plate (filled)'][0], 25)
        self.assertEqual(calls, [True])

    def test_measured_clean_zero_is_retained(self):
        values, calls = self.values_for(False)
        self.assertEqual(values['animal left in the plate (filled)'][0], 0)
        self.assertEqual(calls, [True])


if __name__ == '__main__':
    unittest.main()
