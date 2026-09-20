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

/** kind → 主题色名（保留给宿主主题解析，作为可选降级）。 */
export function markColor(kind: HighlightKind): string {
  if (kind === 'key') return 'yellow';
  if (kind === 'warn') return 'red';
  return 'green';
}

/**
 * kind → 固定 ANSI 前景序列。高亮直接用这套硬编码序列，不经过宿主 theme.fg，
 * 避免某些终端主题把 yellow/red/green 解析成与底色几乎一致的颜色而“看不见”。
 */
export function markAnsi(kind: HighlightKind): string {
  if (kind === 'key') return '\x1b[33m'; // 黄
  if (kind === 'warn') return '\x1b[31m'; // 红
  return '\x1b[32m'; // 绿
}

/** 选项公共前缀弱化用的固定 ANSI（dim）。 */
export const DIM_ANSI = '\x1b[2m';
/** 固定 ANSI 复位序列。 */
export const RESET_ANSI = '\x1b[0m';

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

/** 【…】标签用固定青色，给 AI 回复的分区（记忆卡/问/要点）提供视觉结构。 */
export const LABEL_ANSI = '\x1b[36m';

/**
 * 在纯文本上按 marks 注入固定 ANSI 高亮，返回可直接交给终端渲染的字符串。
 * 宿主 pi-tui 的 wrapTextWithAnsi / visibleWidth 均兼容内嵌 ANSI，宽度计算不受影响。
 */
export function applyAnsiMarks(text: string, marks: Mark[] | undefined): string {
  if (!text || !marks?.length) return text;
  let out = '';
  let pos = 0;
  for (const mark of marks) {
    if (mark.start < pos || mark.end > text.length) continue;
    out += text.slice(pos, mark.start) + markAnsi(mark.kind) + text.slice(mark.start, mark.end) + RESET_ANSI;
    pos = mark.end;
  }
  return out + text.slice(pos);
}

/**
 * 给 AI 回复整体上色：先按考点词上高亮，再给【…】分区标签上青色。
 * 标签后处理是为了避免标签内的 ANSI 码干扰词面定位；二者重叠时终端可正常嵌套渲染。
 */
export function paintAiAnswer(text: string, marks: Mark[] | undefined): string {
  const painted = applyAnsiMarks(text, marks);
  return painted.replace(/【[^】\x1b]{1,12}】/g, (label) => LABEL_ANSI + label + RESET_ANSI);
}

/** 显示用：剥离 AI 输出里的 markdown 加粗/斜体星号（终端无渲染意义，留着是噪声）。 */
export function stripMd(text: string): string {
  return text.replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1').replace(/`/g, '');
}

/**
 * AI 回复专用高亮：只用 LLM 考点词、每词仅首次出现、总数封顶。
 * 规则词典是为短题干设计的，扫长回答会命中过多把文本刷成彩虹；
 * LLM 词本身 1-3 个，首现 + 封顶后密度自然可控。
 */
export function marksForAnswer(
  text: string,
  terms: HighlightTerm[] | undefined,
  cap = 4
): Mark[] {
  if (!text || !terms?.length) return [];
  const raw: Mark[] = [];
  for (const { term, kind } of terms) {
    if (!term) continue;
    const at = text.indexOf(term);
    if (at >= 0) raw.push({ start: at, end: at + term.length, kind });
  }
  return raw.sort((a, b) => a.start - b.start).slice(0, cap);
}

/** LLM 抽取出的一个高亮词及其语义类型（可序列化，缓存进 session）。 */
export interface HighlightTerm {
  term: string;
  kind: HighlightKind;
}

/**
 * 把 LLM 给出的高亮词映射为纯文本上的偏移区间。
 * 只信任词面本身（用 indexOf 定位），不采用模型返回的数字偏移——后者不可靠。
 */
export function marksFromTerms(text: string, terms: HighlightTerm[] | undefined): Mark[] {
  if (!text || !terms?.length) return [];
  const raw: Mark[] = [];
  for (const { term, kind } of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const start = text.indexOf(term, from);
      if (start < 0) break;
      raw.push({ start, end: start + term.length, kind });
      from = start + term.length;
    }
  }
  return dedupe(raw);
}

/** 按起点排序、长词优先，重叠时保留先出现者。 */
function dedupe(raw: Mark[]): Mark[] {
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const merged: Mark[] = [];
  let lastEnd = -1;
  for (const mark of raw) {
    if (mark.start < lastEnd) continue;
    merged.push(mark);
    lastEnd = mark.end;
  }
  return merged;
}

/**
 * 合并规则高亮与 LLM 高亮：重叠处以 LLM 为准（更懂语义），其余取并集。
 */
export function mergeMarks(ruleMarks: Mark[], llmMarks: Mark[]): Mark[] {
  if (!llmMarks.length) return ruleMarks;
  if (!ruleMarks.length) return llmMarks;
  const keptRule = ruleMarks.filter(
    (r) => !llmMarks.some((l) => r.start < l.end && l.start < r.end)
  );
  return dedupe([...keptRule, ...llmMarks]);
}

const LABEL_KIND: Array<[RegExp, HighlightKind]> = [
  [/题眼|关键|考点|重点/, 'key'],
  [/易错|否定|陷阱|错误|设问/, 'warn'],
  [/结论|落点|答案|因此/, 'concl'],
];

function kindOfLabel(label: string): HighlightKind | undefined {
  for (const [re, kind] of LABEL_KIND) {
    if (re.test(label)) return kind;
  }
  return undefined;
}

/**
 * 从 AI 回答原文里解析【高亮】块。约定格式（单行、分号分段、冒号分隔标签与词）：
 *   【高亮】题眼:根本保证,党的领导;易错:错误的是;结论:由此可见
 * 解析失败或没有该块时返回空数组，不影响主流程。
 */
export function parseHighlightBlock(answer: string): HighlightTerm[] {
  if (!answer) return [];
  const marker = '【高亮】';
  const at = answer.indexOf(marker);
  if (at < 0) return [];
  let rest = answer.slice(at + marker.length);
  // 遇到下一个【…】块（如【记忆卡】）即截断
  const nextBlock = rest.indexOf('【');
  if (nextBlock >= 0) rest = rest.slice(0, nextBlock);

  const out: HighlightTerm[] = [];
  const segments = rest.split(/[;；\n]/);
  for (const seg of segments) {
    const m = seg.split(/[:：]/);
    if (m.length < 2) continue;
    const kind = kindOfLabel(m[0].trim());
    if (!kind) continue;
    const terms = m.slice(1).join(':').split(/[,，、\s]+/);
    for (const raw of terms) {
      const term = raw.trim();
      // 过滤空串、单字噪声与整句（>12 字），只保留可用的考点词
      if (term.length >= 2 && term.length <= 12) out.push({ term, kind });
    }
  }
  return out;
}

/**
 * 宽松抽取：容忍多种输出格式（冒号分隔、JSON、纯文本列表等）。
 * 用于兜底抽取请求的响应解析。
 */
export function parseLooseHighlight(text: string): HighlightTerm[] {
  if (!text) return [];
  const out: HighlightTerm[] = [];

  // 1. 先尝试标准【高亮】块
  const standard = parseHighlightBlock(text);
  if (standard.length) return standard;

  // 2. 尝试 JSON 格式：{"题眼":["xxx","yyy"],"易错":["zzz"],"结论":["aaa"]}
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, string[]>;
      for (const [label, words] of Object.entries(obj)) {
        if (!Array.isArray(words)) continue;
        const kind = kindOfLabel(label);
        if (!kind) continue;
        for (const w of words) {
          if (w.length >= 2 && w.length <= 12) out.push({ term: w, kind });
        }
      }
      if (out.length) return out;
    }
  } catch {
    // 忽略 JSON 解析错误
  }

  // 3. 尝试纯文本列表：题眼：xxx,yyy；易错：zzz；结论：aaa
  const labelPattern = /(题眼 | 关键 | 考点|重点 | 易错 | 陷阱 | 错误 | 设问 | 结论 | 落点 | 答案 | 因此)/gi;
  const matches = text.match(new RegExp(`${labelPattern.source}[^;；\n]*`, 'g'));
  if (matches) {
    for (const m of matches) {
      const kind = kindOfLabel(m.split(/[:：]/)[0]);
      if (!kind) continue;
      const terms = m.split(/[:：]/).slice(1).join('').split(/[,，、\s]+/);
      for (const raw of terms) {
        const term = raw.trim();
        if (term.length >= 2 && term.length <= 12) out.push({ term, kind });
      }
    }
    if (out.length) return out;
  }

  // 4. 最后尝试从整个回答中找常见考点词（回退方案）
  const commonWords = ['根本', '本质', '核心', '关键', '前提', '必然要求', '内在要求', '必由之路'];
  for (const word of commonWords) {
    if (text.includes(word)) out.push({ term: word, kind: 'key' });
  }
  return out;
}
