import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';

test('public file-root routines must not be reified as ESM exports', () => {
  assert.throws(() => compileProgramV2('pub routine main(): int {return 42;}'), /routine/i);
});
