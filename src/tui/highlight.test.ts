import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commonPrefixLength,
  findMarks,
  markColor,
  marksFromTerms,
  mergeMarks,
  parseHighlightBlock,
} from './highlight.js';

test('findMarks - 题眼定位词标为 key', () => {
  const marks = findMarks('全面建设社会主义现代化国家，根本保证是坚持党的领导');
  assert.ok(marks.some((m) => m.kind === 'key' && m.start === 14 && m.end === 18)); // 根本保证（长词优先于根本）
});

test('findMarks - 否定设问词标为 warn', () => {
  const marks = findMarks('下列关于新发展的说法，错误的是');
  const warn = marks.filter((m) => m.kind === 'warn');
  assert.equal(warn.length, 1);
  assert.equal('错误的是'.slice(0, warn[0].end - warn[0].start), '错误的是');
});

test('findMarks - 解析结论词标为 concl 且不重叠', () => {
  const marks = findMarks('由此可见，根本动力是人民。因此选 A');
  const kinds = marks.map((m) => m.kind);
  assert.deepEqual(kinds, ['concl', 'key', 'concl']);
  // 区间互不重叠
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i].start >= marks[i - 1].end);
});

test('findMarks - 空文本与无关键词文本返回空', () => {
  assert.deepEqual(findMarks(''), []);
  assert.deepEqual(findMarks('今天天气很好'), []);
});

test('markColor - 三类语义色映射', () => {
  assert.equal(markColor('key'), 'yellow');
  assert.equal(markColor('warn'), 'red');
  assert.equal(markColor('concl'), 'green');
});

test('commonPrefixLength - 阈值与余量保护', () => {
  assert.equal(commonPrefixLength(['坚持党的全面领导', '坚持党的中心工作']), 4); // 坚持党的
  assert.equal(commonPrefixLength(['选项A', '选项B']), 0); // 公共前缀 < 3 字符
  assert.equal(commonPrefixLength(['完全相同的两条', '完全相同的两条']), 0); // 无差异余量
  assert.equal(commonPrefixLength(['只有一条有字']), 0);
  assert.equal(commonPrefixLength([]), 0);
});

test('parseHighlightBlock - 解析【高亮】块并映射语义类型', () => {
  const answer =
    '这道题考查党的领导。\n【记忆卡】\n【问】根本保证是什么？\n【要点】党的领导。\n' +
    '【高亮】题眼:根本保证,党的领导;易错:错误的是;结论:由此可见';
  const terms = parseHighlightBlock(answer);
  assert.ok(terms.some((t) => t.term === '根本保证' && t.kind === 'key'));
  assert.ok(terms.some((t) => t.term === '党的领导' && t.kind === 'key'));
  assert.ok(terms.some((t) => t.term === '错误的是' && t.kind === 'warn'));
  assert.ok(terms.some((t) => t.term === '由此可见' && t.kind === 'concl'));
});

test('parseHighlightBlock - 无块/过滤噪声词', () => {
  assert.deepEqual(parseHighlightBlock('普通回答，没有高亮块'), []);
  // 单字与超长句被过滤
  const terms = parseHighlightBlock('【高亮】题眼:党,这是一个非常长的整句超过十二个字符');
  assert.deepEqual(terms, []);
});

test('marksFromTerms - 词面定位偏移，忽略不存在的词', () => {
  const marks = marksFromTerms('坚持党的领导是根本保证', [
    { term: '党的领导', kind: 'key' },
    { term: '不存在词', kind: 'warn' },
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].start, 2);
  assert.equal(marks[0].end, 6);
  assert.equal(marks[0].kind, 'key');
  assert.deepEqual(marksFromTerms('任意', undefined), []);
});

test('mergeMarks - 重叠处以 LLM 为准，其余取并集', () => {
  const rule = findMarks('根本在于坚持党的领导'); // 规则命中「根本」
  const llm = marksFromTerms('根本在于坚持党的领导', [{ term: '根本在于', kind: 'concl' }]);
  const merged = mergeMarks(rule, llm);
  // LLM 的「根本在于」覆盖了规则「根本」，不再单独出现 key 的根本
  assert.ok(merged.some((m) => m.kind === 'concl' && m.start === 0 && m.end === 4));
  assert.ok(!merged.some((m) => m.kind === 'key' && m.start === 0 && m.end === 2));
  // 无 LLM 时原样返回规则结果
  assert.deepEqual(mergeMarks(rule, []), rule);
});

