import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WrongRemovedStore } from './wrongRemoved.js';

test('WrongRemovedStore - add 后 filter 掉对应题，重载仍在', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kaodes-removed-')), 'removed.json');
  const store = new WrongRemovedStore(file);
  store.add('25390', 11);
  store.add('25390', 11);
  assert.equal(store.has('25390', 11), true);
  const kept = store.filter('25390', [
    { exerID: 11, title: 'gone' },
    { exerId: 12, title: 'stay' },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].exerId, 12);
  const reloaded = new WrongRemovedStore(file);
  assert.equal(reloaded.has('25390', 11), true);
  assert.equal(reloaded.has('25390', 12), false);
  reloaded.restore('25390', 11);
  assert.equal(reloaded.has('25390', 11), false);
  assert.equal(new WrongRemovedStore(file).has('25390', 11), false);
});
