import test from 'node:test';
import assert from 'node:assert/strict';
import { createWrongBookComponent, WrongBookRow } from './wrongBook.js';
import { ExerciseItem } from '../types.js';

function item(exerId: number, title: string, userKey?: string): ExerciseItem {
  return {
    exerId,
    title,
    keyType: '单选',
    newKeyType: 1,
    a: '甲',
    b: '乙',
    rightKey: 'A',
    userKey: userKey || null,
    doResult: userKey ? 1 : 0,
  };
}

function row(partial: Partial<WrongBookRow> & Pick<WrongBookRow, 'title' | 'chapter'>): WrongBookRow {
  const exerId = partial.item?.exerId || (partial.title === '已移出' ? 1 : 2);
  return {
    item: partial.item || item(exerId, partial.title, partial.title === '留下' ? 'A' : undefined),
    title: partial.title,
    chapter: partial.chapter,
    wrongCount: partial.wrongCount ?? 1,
    streak: partial.streak ?? 0,
    mastered: partial.mastered ?? false,
    removed: partial.removed ?? false,
    lastWrongAt: partial.lastWrongAt ?? 0,
    priority: partial.priority ?? 1,
    reason: partial.reason || `错因 ${partial.title}`,
  };
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

test('错题本列表 - 统计、筛选、错因、掌握、恢复、重练', () => {
  const entries = [
    row({ title: '已移出', chapter: '第一章', removed: true, wrongCount: 3, priority: 3 }),
    row({ title: '留下', chapter: '第二章', wrongCount: 2, priority: 2, lastWrongAt: 20 }),
    row({ item: item(3, '掌握题'), title: '掌握题', chapter: '第一章', mastered: true, wrongCount: 4, priority: 4 }),
  ];
  let mastered = 0;
  let restored = 0;
  let removed = 0;
  let result: { items: ExerciseItem[]; again: boolean } | undefined;
  const component = createWrongBookComponent(
    { requestRender() {} },
    undefined,
    {
      courseName: '概论',
      entries,
      onMaster: () => { mastered += 1; },
      onRestore: () => { restored += 1; },
      onRemove: () => { removed += 1; },
    },
    (value) => { result = value; }
  );
  const first = component.render(100).map(plain).join('\n');
  assert.ok(first.includes('题量 3 · 待复习 1 · 已掌握 1'));
  assert.ok(first.includes('留下'));
  assert.ok(!first.includes('已移出'));
  assert.ok(!first.includes('掌握题'));

  component.handleInput?.('v');
  assert.ok(component.render(100).map(plain).join('\n').includes('错因 留下'));

  component.handleInput?.('m');
  assert.equal(mastered, 1);
  assert.equal(entries[1].mastered, true);

  component.handleInput?.('f');
  component.handleInput?.('f');
  const removedView = component.render(100).map(plain).join('\n');
  assert.ok(removedView.includes('已移出'));
  component.handleInput?.('r');
  assert.equal(restored, 1);
  assert.equal(entries[0].removed, false);
  assert.equal(entries[0].mastered, false);

  component.handleInput?.('f');
  component.handleInput?.('x');
  assert.equal(removed, 1);
  assert.equal(entries[2].removed, true);
  assert.equal(result, undefined);
});

test('错题本列表 - G 只重练当前题并清空作答', () => {
  const entries = [row({ title: '留下', chapter: '第二章' })];
  let result: { items: ExerciseItem[]; again: boolean } | undefined;
  const component = createWrongBookComponent(
    { requestRender() {} },
    undefined,
    {
      courseName: '概论',
      entries,
      onMaster: () => undefined,
      onRestore: () => undefined,
      onRemove: () => undefined,
    },
    (value) => { result = value; }
  );
  component.handleInput?.('g');
  assert.equal(result?.again, true);
  assert.equal(result?.items[0].title, '留下');
  assert.equal(result?.items[0].userKey, null);
  assert.equal(result?.items[0].doResult, 0);
});
