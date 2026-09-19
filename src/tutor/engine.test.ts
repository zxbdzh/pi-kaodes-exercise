import test from 'node:test';
import assert from 'node:assert/strict';
import { AiTutorEngine } from './engine.js';
import { ExerciseItem } from '../types.js';

test('AiTutorEngine - 点拨防剧透 Prompt 与反问闪卡生成', async () => {
  let receivedPrompt = '';
  const engine = new AiTutorEngine({
    generateResponse: async (p) => {
      receivedPrompt = p;
      return '测试回复';
    }
  });

  const mockExer: ExerciseItem = {
    exerId: 3869419,
    title: '关于创新性发展的定义...',
    keyType: '单选',
    newKeyType: 1,
    a: '创造性发展',
    b: '创造性转化',
    c: '创新性发展',
    d: '创新性转化',
    rightKey: 'C',
    userKey: 'B',
    doResult: -1,
    analyze: '创新性发展，就是要按照时代的新进步新进展对内涵加以补充拓展...'
  };

  // 1. 点拨 Prompt 构建
  const hintPrompt = engine.buildHintPrompt(mockExer);
  assert.ok(hintPrompt.includes('关于创新性发展的定义'));
  assert.ok(hintPrompt.includes('用户选择了: B'));
  assert.ok(hintPrompt.includes('绝对不要直接说出正确选项'));

  // 2. 反问闪卡 Prompt 构建
  const flashcardPrompt = engine.buildFlashcardPrompt(mockExer);
  assert.ok(flashcardPrompt.includes('反问闪卡'));
  assert.ok(flashcardPrompt.includes('苏格拉底式教学'));

  // 3. 离线 Fallback 点拨与闪卡
  const fallbackHint = engine.generateFallbackHint(mockExer);
  assert.ok(fallbackHint.includes('AI 核心思路点拨'));

  const mockExerLocal = mockExer;
  const fallbackCard = engine.fallbackFlashcard(mockExer);
  assert.ok(fallbackCard.question.length > 0);
  assert.equal(fallbackCard.generated, false);
});

test('AiTutorEngine - LLM 注入与降级', async () => {
  const mockExerLocal: ExerciseItem = {
    exerId: 1,
    title: '民生是人民幸福之基',
    keyType: '单选',
    newKeyType: 1,
    a: '发展经济',
    b: '发扬民主',
    doResult: 0,
  } as unknown as ExerciseItem;
  const llmEngine = new AiTutorEngine({
    generateResponse: async () => '【问题】民生与经济的决定关系是什么？\n【要点】经济发展是民生改善的物质基础。',
  });
  const card = await llmEngine.makeFlashcard(mockExerLocal);
  assert.equal(card.generated, true);
  assert.ok(card.question.includes('民生'));
  assert.ok(card.keyPoints.includes('物质基础'));

  // 5. LLM 失败时降级到离线模板
  const badEngine = new AiTutorEngine({
    generateResponse: async () => {
      throw new Error('llm down');
    },
  });
  const degraded = await badEngine.makeFlashcard(mockExerLocal);
  assert.equal(degraded.generated, false);
});
