import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardPriority, FlashcardStore } from './store.js';

function tempStore(): { store: FlashcardStore; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kaodes-cards-')), 'cards.json');
  return { store: new FlashcardStore(file), file };
}

test('cardPriority - 错得多优先、久未复习优先、从未复习最优先', () => {
  const now = Date.now();
  const never = { wrongCount: 1, lastReviewedAt: undefined };
  const recent = { wrongCount: 1, lastReviewedAt: now - 1000 };
  const old = { wrongCount: 1, lastReviewedAt: now - 10 * 24 * 60 * 60 * 1000 };
  const frequent = { wrongCount: 5, lastReviewedAt: now - 1000 };
  assert.ok(cardPriority(never as never, now) > cardPriority(old as never, now));
  assert.ok(cardPriority(old as never, now) > cardPriority(recent as never, now));
  assert.ok(cardPriority(frequent as never, now) > cardPriority(recent as never, now));
});

test('FlashcardStore - upsert 累加错误次数，draw 按优先级抽卡', () => {
  const { store, file } = tempStore();
  const now = Date.now();
  store.upsert({ exerId: 1, question: 'Q1', keyPoints: 'K1' }, now);
  store.upsert({ exerId: 1, question: 'Q1v2', keyPoints: 'K1v2' }, now + 1);
  store.upsert({ exerId: 2, question: 'Q2', keyPoints: 'K2' }, now);
  assert.equal(store.size(), 2);
  const card1 = store.findByExerId(1)!;
  assert.equal(card1.wrongCount, 2);
  assert.equal(card1.wrongTimes.length, 2);
  assert.equal(card1.question, 'Q1v2');
  // 卡 2 从未复习 → 优先级高于刚复习过的卡 1
  store.markReviewed(1, now + 2);
  const top = store.draw(1, now + 3);
  assert.equal(top[0].exerId, 2);
  // 持久化：重新加载仍在
  const reloaded = new FlashcardStore(file);
  assert.equal(reloaded.size(), 2);
  assert.equal(reloaded.findByExerId(1)?.reviewCount, 1);
  // 空 store 抽卡
  assert.deepEqual(new FlashcardStore(path.join(os.tmpdir(), `none-${Math.random()}.json`)).draw(5), []);
});
