import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudColors } from '../../cloud-colors.mjs';

const encode = value => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

test('all sRGB byte values survive the linear vertex/display round trip', () => {
  const rgb = Uint8Array.from({ length: 256 * 3 }, (_, i) => Math.floor(i / 3));
  const converted = cloudColors(rgb);
  assert.ok(converted instanceof Float32Array);
  assert.equal(converted.length, rgb.length);
  for (let i = 0; i < rgb.length; i++) assert.equal(Math.round(encode(converted[i]) * 255), rgb[i]);
});

test('black, white and middle grey use linear working values', () => {
  const values = cloudColors(new Uint8Array([0, 128, 255]));
  assert.equal(values[0], 0);
  assert.ok(Math.abs(values[1] - 0.2158605) < 1e-6);
  assert.equal(values[2], 1);
});

test('conversion preserves source bytes, channel ordering and repeated-call independence', () => {
  const input = new Uint8Array([32, 84, 190, 142, 74, 21]);
  const copy = input.slice();
  const first = cloudColors(input), second = cloudColors(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(first, second);
  assert.notEqual(first.buffer, second.buffer);
  assert.ok(first[0] < first[1] && first[1] < first[2]);
  first[0] = 99;
  assert.notEqual(second[0], 99);
});

test('empty RGB is valid; incomplete or non-byte inputs fail clearly', () => {
  assert.equal(cloudColors(new Uint8Array()).length, 0);
  for (const value of [new Uint8Array([1]), new Uint8Array([1, 2]), new Float32Array([1, 2, 3]), [1, 2, 3], null]) {
    assert.throws(() => cloudColors(value), /complete RGB bytes/);
  }
});
