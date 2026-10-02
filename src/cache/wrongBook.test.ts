import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MASTER_STREAK,
  WrongBookStore,
  chapterOf,
  queryWrong,
  wrongReason,
  wrongStats,
} from './wrongBook.js';

test('WrongBookStore - 做错抬优先级，做对累计，掌握可恢复', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kaodes-book-')), 'book.json');
  const store = new WrongBookStore(file);
  const seeded = store.ensure('25390', 11, '第一节');
  assert.equal(seeded.wrongCount, 1);
  store.ensure('25390', 11, '第一节');
  assert.equal(store.get('25390', 11)?.wrongCount, 1);

  const missed = store.noteWrong('25390', 11, '未分章', 'B');
  assert.equal(missed.wrongCount, 2);
  assert.equal(missed.streak, 0);
  assert.equal(missed.mastered, false);
  assert.equal(missed.priority, 2);
  assert.equal(missed.chapter, '第一节');
  assert.ok(missed.lastWrongAt > 0);
  assert.ok(missed.reason.includes('误选 B'));
  assert.equal(missed.reason.includes('A'), false);

  assert.equal(store.noteCorrect('25390', 11).streak, 1);
  const ready = store.noteCorrect('25390', 11);
  assert.equal(ready.streak, MASTER_STREAK);
  store.markMastered('25390', 11);
  assert.equal(store.get('25390', 11)?.mastered, true);

  const again = store.noteWrong('25390', 11, '第一节', 'C');
  assert.equal(again.mastered, false);
  assert.equal(again.streak, 0);
  assert.equal(again.wrongCount, 3);
  assert.equal(again.priority, 3);

  store.markMastered('25390', 11);
  store.restore('25390', 11);
  const restored = store.get('25390', 11);
  assert.equal(restored?.mastered, false);
  assert.equal(restored?.streak, 0);

  const reloaded = new WrongBookStore(file);
  assert.equal(reloaded.get('25390', 11)?.wrongCount, 3);
  assert.equal(reloaded.get('25390', 12), undefined);
});

test('queryWrong - 按章节、掌握、时间和次数筛选排序', () => {
  const rows = [
    { title: '甲', chapter: '第一章', wrongCount: 1, mastered: false, removed: false, lastWrongAt: 10, priority: 1 },
    { title: '乙', chapter: '第二章', wrongCount: 4, mastered: true, removed: false, lastWrongAt: 50, priority: 4 },
    { title: '丙', chapter: '第一章', wrongCount: 3, mastered: false, removed: true, lastWrongAt: 30, priority: 3 },
  ];
  assert.deepEqual(wrongStats(rows), { total: 3, pending: 1, mastered: 1 });
  const pending = queryWrong(rows, { filter: 'pending', sort: 'priority', chapter: '' });
  assert.deepEqual(pending.map((row) => row.title), ['甲']);
  const chapter = queryWrong(rows, { filter: 'all', sort: 'count', chapter: '第一章' });
  assert.deepEqual(chapter.map((row) => row.title), ['丙', '甲']);
  const recent = queryWrong(rows, { filter: 'all', sort: 'recent', chapter: '' });
  assert.equal(recent[0].title, '乙');
  assert.equal(chapterOf({ source: '模块A' }, '错题本精练'), '模块A');
  assert.equal(chapterOf({}, '错题本精练'), '未分章');
  assert.equal(wrongReason('B').includes('正确'), false);
});
