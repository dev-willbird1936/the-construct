"""Production metric functions + synthetic arrays; no FFmpeg, models or network."""
import ast
from contextlib import redirect_stdout
import io
import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CHECKS = ROOT / 'backend/tools/world_checks.py'
TREE = ast.parse(CHECKS.read_text())
MAIN = next(n for n in ast.parse((CHECKS.parent / 'make-world.py').read_text()).body
            if isinstance(n, ast.FunctionDef) and n.name == 'main')
ENV = {'np': np, 'cv2': cv2, 'math': math}
FUNCTIONS = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name in {'jitter', 'live_metrics', 'report'}]
exec(compile(ast.Module(body=FUNCTIONS, type_ignores=[]), str(CHECKS), 'exec'), ENV)


class MeasurementTests(unittest.TestCase):
    def test_sparse_is_unknown_but_measured_static_is_zero(self):
        self.assertIsNone(ENV['jitter']([(i, 5.0) for i in range(11)]))
        self.assertEqual(ENV['jitter']([(i, 5.0) for i in range(12)]), 0)
        self.assertGreater(ENV['jitter']([(i, 5 + i % 2 * .6) for i in range(20)]), 0)

    def test_residue_needs_eligible_pixels(self):
        plate = np.full((96, 96, 3), 100, np.uint8)
        frames = np.repeat(plate[None], 12, axis=0)
        frames[1::2] += 1
        ENV['decode'] = lambda *args, **kwargs: frames.copy()
        for width, expected in [(10, None), (40, 0.0)]:
            label = np.zeros((96, 96), np.uint8)
            label[20:20+width, 20:20+width] = 1
            work = SimpleNamespace(w=96, h=96, n=120, fps=15, start=0, clip='synthetic', label=lambda i: label)
            residue, liveness = ENV['live_metrics'](work, plate, 'synthetic-live', 1.0)
            with self.subTest(width=width):
                self.assertEqual(residue, expected)
                self.assertEqual(liveness, 1.0)

    def test_report_preserves_observed_zero_and_failure(self):
        with redirect_stdout(io.StringIO()):
            out = ENV['report']([('good', 0.0, 6.0, '<'), ('bad', 9.0, 6.0, '<'), ('numpy', np.float32(1), 6.0, '<')])
        self.assertEqual(out['good'], {'value': 0.0, 'limit': 6.0, 'kind': '<', 'pass': True})
        self.assertEqual(out['bad']['value'], 9.0)
        self.assertIs(out['bad']['pass'], False)
        self.assertEqual(out['numpy']['value'], 1.0)

    def test_invalid_report_values_are_unknown_not_coerced_passes(self):
        for value in [None, float('nan'), float('inf'), -1, '0', '', False, np.bool_(False), []]:
            with self.subTest(value=value), redirect_stdout(io.StringIO()):
                out = ENV['report']([('unknown', value, 6.0, '<')])
                self.assertIsNone(out['unknown']['value'])
                self.assertIsNone(out['unknown']['pass'])
                json.dumps(out, allow_nan=False)

    def test_empty_and_partly_unmeasured_tracks_stay_unknown_in_values(self):
        node = next(n for n in MAIN.body if isinstance(n, ast.Assign) and
                    any(isinstance(t, ast.Name) and t.id == 'values' for t in n.targets))
        env = {'np': np, 'ident': {'switches': 0, 'unexplained': 0, 'longest': 0},
               'by_track': {1: []}, 'raw_gaps': [], 'hits': [], 'capped': [],
               'raw_jitter': [0.0, None], 'final_jitter': [0.0, None],
               'unseen': 0, 'residue': None, 'liveness': 1}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(CHECKS), 'exec'), env)
        for key in ['contact gap (before slide)', 'contact slide clamped',
                    'body behind the scene (before cap)', 'jitter (raw depth)',
                    'jitter (final)', 'paint-out residue']:
            self.assertIsNone(env['values'][key][0], key)

    def gate(self, a, b, jitter_pass):
        def assignment(name):
            return next(n for n in MAIN.body if isinstance(n, ast.Assign) and
                        any(isinstance(t, ast.Name) and t.id == name for t in n.targets))
        env = {'checks': {'contact gap (before slide)': a, 'contact slide clamped': b,
                          'jitter (final)': {'pass': jitter_pass}},
               'values': {'contact gap (before slide)': (None, 8, '<', 'feet placement is uncertain'),
                          'contact slide clamped': (None, 15, '<', 'feet placement is uncertain'),
                          'jitter (final)': (None, 2, '<', "an animal's distance wobbles")}}
        start = MAIN.body.index(assignment('feet'))
        end = next(i for i in range(start, len(MAIN.body)) if isinstance(MAIN.body[i], ast.Expr) and
                   isinstance(MAIN.body[i].value, ast.Call) and isinstance(MAIN.body[i].value.func, ast.Name) and
                   MAIN.body[i].value.func.id == 'print')
        env['left'] = None
        exec(compile(ast.Module(body=MAIN.body[start:end], type_ignores=[]), str(CHECKS), 'exec'), env)
        return env

    def test_unknown_does_not_claim_wobble_or_change_camera_tier(self):
        a = {'value': None, 'pass': None, 'limit': 8}
        b = {'value': None, 'pass': None, 'limit': 15}
        out = self.gate(a, b, None)
        self.assertFalse(out['feet_bad'])
        self.assertEqual(out['tier'], 'full')
        self.assertEqual(out['notes'], [])
        self.assertIn('jitter (final)', out['unverified_checks'])
        self.assertIn('animal left in the plate (filled)', out['unverified_checks'])

    def test_known_failure_keeps_existing_feet_and_wobble_gate(self):
        out = self.gate({'value': 20, 'pass': False, 'limit': 8},
                        {'value': 40, 'pass': False, 'limit': 15}, False)
        self.assertTrue(out['feet_bad'])
        self.assertEqual(out['tier'], 'narrow')
        self.assertIn("an animal's distance wobbles", out['notes'])


if __name__ == '__main__':
    unittest.main()
