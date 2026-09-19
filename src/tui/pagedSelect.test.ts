import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagedSelectComponent } from './pagedSelect.js';
import { visibleWidth } from './exercise.js';

interface Harness {
  component: ReturnType<typeof createPagedSelectComponent<string>>;
  render: (width?: number) => string[];
  press: (data: string) => void;
  settled: () => boolean;
  value: () => string | undefined;
}

function harness(items: string[], pageSize?: number): Harness {
  let renderCount = 0;
  let done = false;
  let result: string | undefined;
  const component = createPagedSelectComponent<string>(
    { requestRender: () => renderCount++ },
    undefined,
    { title: '选择章节', items, format: (s) => s, pageSize },
    (v) => {
      done = true;
      result = v;
    }
  );
  return {
    component,
    render: (width = 80) => component.render(width),
    press: (data) => component.handleInput?.(data),
    settled: () => done,
    value: () => result,
  };
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
const cursorIndex = (lines: string[]) =>
  lines.findIndex((line) => plain(line).startsWith('→ '));

const items40 = Array.from({ length: 40 }, (_, i) => `章节${i + 1}`);

test('pagedSelect - 默认 15 条一页并显示页码提示', () => {
  const h = harness(items40);
  const lines = h.render().map(plain);
  assert.ok(lines[0].includes('选择章节'));
  assert.ok(lines[0].includes('(第 1/3 页)'));
  assert.ok(lines.some((l) => l.includes('1. 章节1')));
  assert.ok(lines.some((l) => l.includes('15. 章节15')));
  assert.ok(!lines.some((l) => l.includes('16. 章节16')), '第 1 页不应出现第 16 条');
  assert.ok(lines.some((l) => l.includes('←→ 翻页')));
});

test('pagedSelect - 左右键翻页并保持页内偏移', () => {
  const h = harness(items40);
  h.press('\x1b[C'); // → 下一页：光标到 16
  let lines = h.render().map(plain);
  assert.ok(lines[0].includes('(第 2/3 页)'));
  assert.ok(plain(lines[cursorIndex(lines)]).includes('16. 章节16'));

  // 页内先下移 2 格（光标 18），再左右翻页应保留偏移
  h.press('\x1b[B');
  h.press('\x1b[B');
  h.press('\x1b[D'); // ← 上一页：偏移 2 → 第 1 页第 3 条（章节3）
  lines = h.render().map(plain);
  assert.ok(lines[0].includes('(第 1/3 页)'));
  assert.ok(plain(lines[cursorIndex(lines)]).includes('3. 章节3'));

  h.press('\x1b[C');
  lines = h.render().map(plain);
  assert.ok(plain(lines[cursorIndex(lines)]).includes('18. 章节18'));

  h.press('\x1b[C'); // → 最后一页（31-40），偏移 2 → 章节33
  lines = h.render().map(plain);
  assert.ok(lines[0].includes('(第 3/3 页)'));
  assert.ok(plain(lines[cursorIndex(lines)]).includes('33. 章节33'));

  h.press('\x1b[C'); // 末页再按右不越界
  lines = h.render().map(plain);
  assert.ok(lines[0].includes('(第 3/3 页)'));
  h.press('\x1b[D');
  h.press('\x1b[D'); // 回到首页再按左不越界
  lines = h.render().map(plain);
  assert.ok(lines[0].includes('(第 1/3 页)'));
});

test('pagedSelect - 上下键跨页连续移动光标', () => {
  const h = harness(items40);
  for (let i = 0; i < 15; i++) h.press('\x1b[B'); // 15 次下移 → 光标到第 16 条（页 2）
  const lines = h.render().map(plain);
  assert.ok(lines[0].includes('(第 2/3 页)'));
  assert.ok(plain(lines[cursorIndex(lines)]).includes('16. 章节16'));
  for (let i = 0; i < 15; i++) h.press('\x1b[A'); // 移回第 1 条
  assert.ok(plain(h.render().map(plain)[cursorIndex(h.render().map(plain))]).includes('1. 章节1'));
});

test('pagedSelect - Enter 返回光标项，Esc / Ctrl+C 取消', () => {
  const h = harness(items40);
  h.press('\x1b[C');
  h.press('\r');
  assert.ok(h.settled());
  assert.equal(h.value(), '章节16');

  const h2 = harness(items40);
  h2.press('\x1b');
  assert.ok(h2.settled());
  assert.equal(h2.value(), undefined);

  const h3 = harness(items40);
  h3.press('\x03');
  assert.ok(h3.settled());
  assert.equal(h3.value(), undefined);
  // settled 后重复按键不应再次回调
  h3.press('\r');
  assert.equal(h3.value(), undefined);
});

test('pagedSelect - h/l/j/k 与 PgUp/PgDn 备用键位', () => {
  const h = harness(items40);
  h.press('j');
  h.press('j');
  assert.ok(plain(h.render().map(plain)[cursorIndex(h.render().map(plain))]).includes('3. 章节3'));
  h.press('l'); // → 页 2，偏移 2
  assert.ok(h.render().map(plain)[0].includes('(第 2/3 页)'));
  h.press('\x1b[5~'); // PgUp → 页 1
  assert.ok(h.render().map(plain)[0].includes('(第 1/3 页)'));
  h.press('\x1b[6~'); // PgDn → 页 2
  assert.ok(h.render().map(plain)[0].includes('(第 2/3 页)'));
});

test('pagedSelect - 任意终端宽度不越界', () => {
  const h = harness(items40);
  for (const width of [120, 80, 40, 20, 10, 4, 1]) {
    for (const line of h.component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width=${width} 行越界: ${JSON.stringify(line)}`);
    }
  }
});

test('pagedSelect - 单页列表不显示页码提示', () => {
  const h = harness(['章节A', '章节B']);
  const lines = h.render().map(plain);
  assert.ok(!lines[0].includes('页)'));
  assert.ok(plain(lines[cursorIndex(lines)]).includes('1. 章节A'));
});
