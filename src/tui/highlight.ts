/**
 * 规则高亮引擎（第一阶段）：本地词典 + 正则，零延迟、离线、可单测。
 * 输出的是纯文本上的偏移区间（Mark），由渲染层在截断/换行之后分段上色，
 * 保证 ANSI 序列不参与宽度计算。
 */

export type HighlightKind = 'key' | 'warn' | 'concl';

export interface Mark {
  start: number;
  end: number;
  kind: HighlightKind;
}

/** 题眼定位词：考研政治题干里指向考点的高频模式词。 */
const KEY_WORDS = [
  '根本保证', '根本途径', '根本政治前提', '根本', '本质', '实质', '核心', '关键',
  '基石', '基础', '前提', '首要', '中心环节', '主线', '主题', '灵魂', '旗帜',
  '标志', '标识', '指南', '纲领', '行动指南', '必由之路', '内在要求', '必然要求',
  '决定性', '出发点', '落脚点', '第一要务', '第一生产力',
];

/** 否定设问词：看反题干是丢分重灾区，用警示色单独标出。 */
const WARN_WORDS = ['错误的是', '错误的有', '不正确', '不属于', '不包括', '不符合'];

/** 解析结论词：答案与解析里的落点句。 */
const CONCL_WORDS = ['由此可见', '因此', '所以', '可见', '这表明', '这说明', '启示是', '启示在于'];

/** kind → 主题色名（交给宿主 theme.fg 解析，fallback 走基础 ANSI）。 */
export function markColor(kind: HighlightKind): string {
  if (kind === 'key') return 'yellow';
  if (kind === 'warn') return 'red';
  return 'green';
}

function collect(text: string, words: string[], kind: HighlightKind, out: Mark[]): void {
  for (const word of words) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(word, from);
      if (start < 0) break;
      out.push({ start, end: start + word.length, kind });
      from = start + word.length;
    }
  }
}

/**
 * 在纯文本上找出全部高亮区间：按起点排序、长词优先，重叠时保留先出现者。
 */
export function findMarks(text: string): Mark[] {
  if (!text) return [];
  const raw: Mark[] = [];
  collect(text, KEY_WORDS, 'key', raw);
  collect(text, WARN_WORDS, 'warn', raw);
  collect(text, CONCL_WORDS, 'concl', raw);
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  const merged: Mark[] = [];
  let lastEnd = -1;
  for (const mark of raw) {
    if (mark.start < lastEnd) continue; // 与已保留区间重叠，丢弃
    merged.push(mark);
    lastEnd = mark.end;
  }
  return merged;
}

/**
 * 多条选项文本的最长公共前缀长度（用于把差异部分之外的文字弱化）。
 * 少于 2 条、公共前缀 < 3 字符、或会吞掉某条选项的全部余量时返回 0。
 */
export function commonPrefixLength(texts: string[]): number {
  const list = texts.filter((t) => t.length > 0);
  if (list.length < 2) return 0;
  let lcp = list[0];
  for (const text of list.slice(1)) {
    let i = 0;
    while (i < lcp.length && i < text.length && lcp[i] === text[i]) i++;
    lcp = lcp.slice(0, i);
  }
  if (lcp.length < 3) return 0;
  // 至少给每条选项留 2 个字符的差异空间，避免整行被弱化
  const minRest = Math.min(...list.map((t) => t.length - lcp.length));
  if (minRest < 2) return 0;
  return lcp.length;
}
