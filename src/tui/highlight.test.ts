import test from 'node:test';
import assert from 'node:assert/strict';
import { commonPrefixLength, findMarks, markColor } from './highlight.js';

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
