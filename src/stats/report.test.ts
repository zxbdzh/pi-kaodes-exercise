import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, computeByCourse, buildStatsReport } from './report.js';
import { PracticeSession } from '../types.js';

function session(courseName: string, catId: string, results: Array<{ userKey: string | null; doResult: number }>): PracticeSession {
  return {
    prId: 1,
    scoringMethod: 1,
    courseId: 'c1',
    courseName,
    productId: 1,
    cstId: 1,
    catId,
    chapterName: catId,
    currentIndex: 0,
    startTime: Date.now(),
    runSecond: 0,
    exercises: results.map((r, i) => ({
      exerId: i + 1,
      title: `题${i + 1}`,
      keyType: '单选',
      newKeyType: 1,
      a: 'A',
      b: 'B',
      rightKey: 'A',
      userKey: r.userKey,
      doResult: r.doResult,
    })),
  };
}

test('stats - 总体统计与正确率', () => {
  const sessions = [
    session('政治', 'ch1', [
      { userKey: 'A', doResult: 1 },
      { userKey: 'B', doResult: -1 },
      { userKey: null, doResult: 0 },
    ]),
    session('政治', 'ch2', [
      { userKey: 'A', doResult: 1 },
      { userKey: 'A', doResult: 1 },
    ]),
  ];
  const t = computeTotals(sessions);
  assert.equal(t.chapters, 2);
  assert.equal(t.exercises, 5);
  assert.equal(t.answered, 4);
  assert.equal(t.correct, 3);
  assert.equal(t.wrong, 1);
  assert.equal(t.accuracy, 0.75);

  const byCourse = computeByCourse(sessions);
  assert.equal(byCourse.length, 1);
  assert.equal(byCourse[0].courseName, '政治');
  assert.equal(byCourse[0].answered, 4);
  assert.equal(byCourse[0].accuracy, 0.75);
});

test('stats - 空数据与报告渲染', () => {
  assert.equal(computeTotals([]).exercises, 0);
  const empty = buildStatsReport([]);
  assert.ok(empty.includes('还没有本地练习记录'));

  const report = buildStatsReport([
    session('马原', 'ch1', [
      { userKey: 'A', doResult: 1 },
      { userKey: 'B', doResult: -1 },
    ]),
  ]);
  assert.ok(report.includes('学习统计'));
  assert.ok(report.includes('马原'));
  assert.ok(report.includes('50%')); // 正确率
  assert.ok(report.includes('1 ✔') && report.includes('1 ✘'));
});
