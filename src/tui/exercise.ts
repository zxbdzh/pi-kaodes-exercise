import readline from 'node:readline';
import { parseKeyName } from './keys.js';
import { commonPrefixLength, findMarks, marksFromTerms, mergeMarks, markAnsi, marksForAnswer, stripMd, DIM_ANSI, RESET_ANSI, Mark } from './highlight.js';
import { ExerciseItem, PracticeSession, ChatTurn } from '../types.js';
import { KaodesClient } from '../api/client.js';
import { SessionCache } from '../cache/session.js';
import { Flashcard, FlashcardStore } from '../cards/store.js';

export type OnAiTutorCallback = (exer: ExerciseItem, mode: 'hint' | 'flashcard') => Promise<void>;

/**
 * 入卡回调（按 Y 触发）：宿主负责 LLM 组卡与持久化，返回状态消息；null 表示失败。
 * cardCtx 由 TUI 从当前 session 取：相似错题标题（相似题线索）与归属信息。
 */
export type OnAddCardCallback = (
  exer: ExerciseItem,
  cardCtx: { siblingTitles: string[]; courseId: string; chapterName?: string }
) => Promise<string | null>;

/**
 * AI 追问回调：exercise 只管面板与历史，LLM 通道由宿主注入。
 * history 不含本次 question；返回 null 表示 AI 不可用。
 */
export type OnChatAskCallback = (
  exer: ExerciseItem,
  history: ChatTurn[],
  question: string
) => Promise<string | null>;

/** AI 记忆卡：从 AI 回答中提取，按 C 查看 */
export interface MemoryCard {
  question: string;
  keyPoints: string;
}

/** 从 AI 回答文本中提取【记忆卡】区块 */
export function extractMemoryCard(answer: string): { answer: string; card?: MemoryCard } {
  const match = answer.match(/【记忆卡】\s*[\r\n]*【问】\s*([\s\S]*?)\s*[\r\n]*【要点】\s*([\s\S]*?)\s*$/);
  if (!match || !match[1].trim()) {
    // 无【要点】时只取【问】
    const qOnly = answer.match(/【记忆卡】\s*[\r\n]*【问】\s*([\s\S]*?)\s*$/);
    if (!qOnly || !qOnly[1].trim()) return { answer: answer.trim() };
    return {
      answer: answer.slice(0, qOnly.index).trim(),
      card: { question: qOnly[1].trim(), keyPoints: '' },
    };
  }
  const question = match[1].trim();
  const keyPoints = match[2].trim();
  return {
    answer: answer.slice(0, match.index).trim(),
    card: { question, keyPoints },
  };
}

export interface PiExerciseComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface PiExerciseUI {
  custom<T>(
    factory: (
      tui: { requestRender(force?: boolean): void },
      theme: unknown,
      keybindings: unknown,
      done: (value: T) => void
    ) => PiExerciseComponent
  ): Promise<T>;
  input(prompt: string, placeholder?: string): Promise<string | undefined>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
}

/** /kaodes help 与答题页 :help 共用的完整帮助文本。 */
export const KAODES_HELP = [
  'Kaodes 刷题帮助',
  '',
  '模式:',
  '  /kaodes            章节练习（科目 → 课程 → 章节 → 小节）',
  '  /kaodes daily      每日一练',
  '  /kaodes wrong      错题本攻坚',
  '  /kaodes exam       全真模拟考试',
  '  /kaodes challenge  答题闯关',
  '  /kaodes login      更新 Token',
  '  /kaodes version    显示插件版本与加载的构建目录',
  '  /kaodes prefs      查看当前偏好（高亮开关 / 每页条数）',
  '  /kaodes stats      学习统计看板（进度 / 正确率 / 按科目）',
  '  /kaodes help       本帮助',
  '',
  '选择列表（科目 / 课程 / 章节）:',
  '  ↑↓ 或 J / K    移动光标（跨页连续）',
  '  ←→ 或 H / L    上一页 / 下一页',
  '  Enter          确认选择',
  '  ⌫ Backspace    返回上一级选择（科目页再按则退出）',
  '  Esc            取消并退出',
  '',
  '答题页直接按键:',
  '  ↑/↓            移动选项光标',
  '  Enter          确认光标所在选项（主观题则查看解析）',
  '  A-E            直接作答（多选题可反复切换）',
  '  V              显示 / 隐藏解析',
  '  ←/→ 或 N / P   上一题 / 下一题',
  '  S              保存进度（本地 + 云端）',
  '  Q              交卷并退出',
  '  T              AI 点拨（一键分析当前题，结论进入对话历史）',
  '  F              AI 追问面板（多轮对话，esc 返回答题）',
  '  K              闪卡抽卡复习（错得多 / 久未复习优先，enter 翻面）',
  '  Y              答错后按 Y，AI 组卡加入闪卡集',
  '  W              错题回顾（↑↓ 选择，enter 跳到该题）',
  '  Esc            退出对话框（↑↓ 选择 · Enter 确认 · Esc 继续答题）',
  '  Ctrl+C         保存并退出',
  '',
  '答题页底部指令（按 : 或 / 聚焦输入框，Enter 提交，Esc 取消）:',
  '  help | h | ?            查看本帮助',
  '  next | n                下一题',
  '  prev | p                上一题',
  '  goto <n> | g <n> | <n>  跳到第 n 题',
  '  ans <AB…>               作答，如 ans ab',
  '  show | v                显示 / 隐藏解析',
  '  save | s                保存进度',
  '  submit | q              交卷并退出',
  '  hint | t                AI 点拨',
  '  ask | f                 AI 追问面板（多轮对话）',
  '  card | k                闪卡抽卡复习',
  '  wrong | w               错题集中回顾',
  '  hl [on|off]             规则高亮开关',
  '  hll                     手动触发 LLM 考点抽取（额外 token）',
  '  exit [save|discard]     退出（可指定保存 / 不保存）',
  '',
  '规则高亮配色:',
  '  题眼定位词（根本/本质/关键…）= 黄 · 否定设问（错误的是/不属于…）= 红',
  '  解析结论词（因此/由此可见…）= 绿 · 选项公共前缀 = 灰（只留差异）',
  '  按 T 点拨 / F 问 AI 后，AI 会顺带标出本题考点（LLM 高亮，缓存本题、离线可复现）',
  '',
  '底栏说明:',
  '  session 行紧凑展示进度 · 章节 · 科目；执行中 / 成功 / 错误等临时状态',
  '  会短暂占用该行并自动恢复，超长内容以 … 截断。',
].join('\n');

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const RESET = '\x1b[0m';
const REVERSE_ON = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';
const FALLBACK_COLORS: Record<string, string> = {
  dim: '\x1b[2m',
  muted: '\x1b[2m',
  borderMuted: '\x1b[2m',
  accent: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

/** 提问插件同款主题适配：宿主提供 theme.fg 时优先使用，否则退化为基础 ANSI。 */
type ThemePainter = (color: string, text: string) => string;

function makeThemePainter(theme: unknown): ThemePainter {
  const candidate = theme as { fg?: (color: string, text: string) => string } | undefined;
  if (candidate && typeof candidate.fg === 'function') {
    return (color, text) => {
      try {
        return candidate.fg!(color, text);
      } catch {
        return text;
      }
    };
  }
  return (color, text) => (FALLBACK_COLORS[color] ? FALLBACK_COLORS[color] + text + RESET : text);
}

function codePointWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    codePoint === 0x1100 ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(value: string): number {
  return Array.from(value.replace(ANSI_ESCAPE, '')).reduce(
    (width, char) => width + codePointWidth(char.codePointAt(0) || 0),
    0
  );
}

export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return '';
  let used = 0;
  let end = 0;
  for (const char of value) {
    const next = used + codePointWidth(char.codePointAt(0) || 0);
    if (next > width) break;
    used = next;
    end += char.length;
  }
  return value.slice(0, end);
}

/** 超宽时以 … 结尾截断（用于底栏单行信息）。 */
function truncateWithEllipsis(value: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return '…';
  return truncateToWidth(value, width - 1) + '…';
}

/** 纯文本按可见宽度软换行（不处理 ANSI）。 */
function wrapPlain(value: string, width: number): string[] {
  const lines: string[] = [];
  if (width <= 0) return lines;
  let rest = value;
  while (rest) {
    const chunk = truncateToWidth(rest, width);
    if (!chunk) {
      lines.push('');
      rest = rest.slice(1);
      continue;
    }
    lines.push(chunk);
    rest = rest.slice(chunk.length);
  }
  return lines;
}

/** 与 wrapPlain 相同的换行规则，但返回每段在原串中的偏移区间。 */
function wrapPlainWithOffsets(
  value: string,
  width: number
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  if (width <= 0) return out;
  let chunkStart = 0;
  let used = 0;
  let pos = 0;
  const push = (from: number, to: number) => out.push({ text: value.slice(from, to), start: from, end: to });
  for (const ch of value) {
    const w = codePointWidth(ch.codePointAt(0) || 0);
    if (used + w > width) {
      if (pos > chunkStart) {
        push(chunkStart, pos);
        chunkStart = pos;
        used = 0;
      }
      if (w > width) {
        // 单字符已超宽（如 width=1 遇全角字）：与 wrapPlain 一致丢弃，保证不越界
        pos += ch.length;
        chunkStart = pos;
        continue;
      }
    }
    used += w;
    pos += ch.length;
  }
  if (chunkStart < pos) push(chunkStart, pos);
  return out;
}

/** 纯文本右侧补空格到指定可见宽度。 */
function padPlain(value: string, width: number): string {
  const used = visibleWidth(value);
  if (used >= width) return truncateToWidth(value, width);
  return value + ' '.repeat(width - used);
}

type StatusLevel = 'info' | 'success' | 'error' | 'busy';

interface BottomStatus {
  text: string;
  level: StatusLevel;
}

const STATUS_PREFIX: Record<StatusLevel, string> = {
  info: '',
  success: '✓ ',
  error: '✗ ',
  busy: '… ',
};

const STATUS_COLOR: Record<StatusLevel, string> = {
  info: 'dim',
  success: 'green',
  error: 'red',
  busy: 'accent',
};

/**
 * 终端交互式 TUI 刷题组件与状态断点引擎。
 * 主区域仅渲染题目本身；章节 / 会话等上下文收纳到底栏 session 行，
 * 快捷键说明统一移入 /kaodes help 与 :help。
 */
export class ExerciseTUI {
  private session: PracticeSession;
  private client: KaodesClient;
  private cache: SessionCache;
  private onAiTutor?: OnAiTutorCallback;
  /** AI 追问面板：LLM 通道（宿主注入）与面板状态 */
  private onChatAsk?: OnChatAskCallback;
  private chatMode = false;
  private chatBusy = false;
  /** 闪卡集：答错按 Y 入卡（LLM 组卡由宿主注入），K 键抽卡复习 */
  private onAddCard?: OnAddCardCallback;
  private cardMode = false;
  private cardDeck: Flashcard[] = [];
  private cardCursor = 0;
  private cardFlipped = false;
  private cards?: FlashcardStore;
  /** 错题回顾模式：w 键 / :wrong 进入，主区域列出本 session 全部错题 */
  private wrongMode = false;
  private wrongCursor = 0;
  private isRunning = false;
  /** 选项列表光标（上下键移动，Enter 确认），提问插件同款交互。 */
  private optionCursor = 0;
  /** 规则高亮开关（:hl on|off），第一阶段仅本地词典。 */
  private highlightEnabled = true;
  /** 高亮开关变化时的持久化回调（由宿主注入，写入用户偏好）。 */
  private onHighlightChange?: (on: boolean) => void;

  constructor(
    session: PracticeSession,
    client: KaodesClient,
    cache: SessionCache,
    onAiTutor?: OnAiTutorCallback,
    options?: {
      highlightEnabled?: boolean;
      onHighlightChange?: (on: boolean) => void;
      /** 闪卡集存储（K 抽卡复习数据源）；缺省时 K 键提示不可用 */
      cards?: FlashcardStore;
    }
  ) {
    this.session = session;
    this.client = client;
    this.cache = cache;
    this.onAiTutor = onAiTutor;
    this.cards = options?.cards;
    if (options?.highlightEnabled !== undefined) this.highlightEnabled = options.highlightEnabled;
    this.onHighlightChange = options?.onHighlightChange;
  }

  /**
   * 渲染答题卡状态指示
   */
  public renderSheet(): string {
    const list = this.session.exercises;
    const cards = list.map((item, idx) => {
      const isCur = idx === this.session.currentIndex;
      let statusChar = '○'; // 未做
      if (item.doResult === 1) statusChar = '✔';
      else if (item.doResult === -1) statusChar = '✘';
      else if (item.userKey) statusChar = '●'; // 已做客观/主观题

      if (isCur) {
        return `[${idx + 1}:${statusChar}]`;
      }
      return `${idx + 1}:${statusChar}`;
    });
    return cards.join(' ');
  }

  /**
   * 底栏 session 行：紧凑展示科目 · 章节 · 进度 · 已做。
   */
  public sessionLineText(): string {
    const doneCount = this.session.exercises.filter((item) => item.userKey || item.doResult !== 0).length;
    // 进度信息永远排在行首，超长的章节/科目名靠后并承受 … 截断，
    // 保证窄终端下 1/2、已做 N 等核心状态始终可见。
    return [
      'session:',
      `${this.session.currentIndex + 1}/${this.session.exercises.length}`,
      `已做 ${doneCount}`,
      this.session.chapterName || '练习',
      this.session.courseName,
    ].join(' · ');
  }

  /**
   * 题目主体行（带颜色语义）：Pi 原生 select 同款分层 ——
   * 光标行 accent（青色）、普通内容 text、辅助信息 muted，供主区域着色渲染。
   */
  private bodyLinesStyled(): Array<{
    text: string;
    color: string;
    marks?: Mark[];
    dim?: { start: number; end: number };
  }> {
    const cur = this.session.exercises[this.session.currentIndex];
    if (!cur) return [{ text: '暂无题目', color: 'muted' }];
    // 规则高亮打底，叠加当前题缓存的 LLM 高亮词（AI 回答时产出），重叠处以 LLM 为准。
    const marksOf = (text: string): Mark[] | undefined => {
      if (!this.highlightEnabled || !text) return undefined;
      const merged = mergeMarks(findMarks(text), marksFromTerms(text, cur.llmMarks));
      return merged.length ? merged : undefined;
    };

    const stemText = `${cur.keyType || '选择题'}  ${cur.title}`;
    const lines: Array<{ text: string; color: string; marks?: Mark[]; dim?: { start: number; end: number } }> = [
      { text: stemText, color: 'text', marks: marksOf(stemText) },
      { text: '', color: 'text' },
    ];

    const opts = [
      { key: 'A', text: cur.a },
      { key: 'B', text: cur.b },
      { key: 'C', text: cur.c },
      { key: 'D', text: cur.d },
      { key: 'E', text: cur.e },
      { key: 'F', text: cur.f },
    ].filter((option) => !!option.text);

    if (opts.length > 0) {
      const cursor = Math.min(this.optionCursor, opts.length - 1);
      // 选项公共前缀弱化：只突出真正有区分度的差异部分（规则层，无 LLM）
      const lcp = this.highlightEnabled ? commonPrefixLength(opts.map((o) => o.text!)) : 0;
      // 未作答前选项不上考点词：哪个词被标色本身就是答案线索（剧透）；作答/看解析后恢复为复习标注
      const answered = !!cur.userKey || !!cur.viewAnswer;
      for (const [index, option] of opts.entries()) {
        // Pi 官方 select 同款：→ 指示光标行，其余行两空格缩进，Enter 确认
        const pointer = index === cursor ? '→' : ' ';
        const text = `${pointer} ${option.key}. ${option.text}`;
        const textStart = text.length - option.text!.length;
        lines.push({
          text,
          color: index === cursor ? 'accent' : 'text',
          marks: answered ? marksOf(text) : undefined,
          dim: lcp ? { start: textStart, end: textStart + lcp } : undefined,
        });
      }
    } else {
      lines.push({ text: '（主观题，无选项）', color: 'muted' });
    }

    if (cur.viewAnswer) {
      lines.push({ text: '', color: 'text' });
      const rightKeyLine = `答案  ${cur.rightKey || (cur.rightKeyList ? cur.rightKeyList.join('') : '详见解析')}`;
      lines.push({ text: rightKeyLine, color: 'accent', marks: marksOf(rightKeyLine) });
      if (cur.analyze) {
        const analyzeText = `解析  ${cur.analyze}`;
        // 解析部分强制用 fixed ANSI 配色，不受主题灰色影响
        lines.push({ text: analyzeText, color: 'fixed', marks: marksOf(analyzeText) });
      }
    }

    return lines;
  }

  /**
   * AI 追问面板行（chatMode 时作为 renderLayout 主区域数据源）。
   * AI 回复行与题目区共用同一套考点高亮（规则词典 + 本题 llmMarks）。
   */
  private chatLinesStyled(): Array<{
    text: string;
    color: string;
    marks?: Mark[];
    dim?: { start: number; end: number };
  }> {
    const cur = this.session.exercises[this.session.currentIndex];
    const history = cur?.chatHistory ?? [];
    const head: Array<{ text: string; color: string; marks?: Mark[] }> = [
      { text: `AI 对话 · 第 ${this.session.currentIndex + 1} 题`, color: 'accent' },
      { text: '', color: 'text' },
    ];
    if (!history.length) {
      head.push({
        text: '输入问题，enter 发送 · esc 返回答题 · 回答自动标注考点，可继续追问',
        color: 'muted',
      });
      return head;
    }
    for (const turn of history) {
      // 保留 AI 回复原有的换行结构：首行带前缀，后续行缩进对齐；显示层去掉 markdown 星号
      const rows = stripMd(turn.content).split(/\r?\n/).filter((row) => row.trim().length > 0);
      const prefix = turn.role === 'user' ? '你' : 'AI';
      rows.forEach((row, rowIndex) => {
        const text = rowIndex === 0 ? `${prefix}  ${row}` : `   ${row}`;
        head.push({
          text,
          color: turn.role === 'user' ? 'accent' : 'text',
          marks: turn.role === 'assistant' ? marksForAnswer(text, cur?.llmMarks) : undefined,
        });
      });
      head.push({ text: '', color: 'text' });
    }
    if (this.chatBusy) head.push({ text: '… 思考中', color: 'muted' });
    else if (!this.chatBusy && history[history.length - 1]?.role === 'assistant') {
      head.push({ text: '继续输入可追问 · esc 返回答题', color: 'muted' });
    }
    // 只保留尾部，长对话不撑爆主区域
    return head.slice(-300);
  }

  /**
   * 闪卡复习行（cardMode 时作为 renderLayout 主区域数据源）。
   * 与题目/对话视图共用同一套框与换行渲染，不再维护独立框渲染副本。
   */
  private cardLinesStyled(): Array<{ text: string; color: string; marks?: Mark[]; dim?: { start: number; end: number } }> {
    const card = this.cardDeck[this.cardCursor];
    if (!card) return [{ text: '闪卡集为空', color: 'muted' }];
    const total = this.cardDeck.length;
    const lines: Array<{ text: string; color: string; marks?: Mark[]; dim?: { start: number; end: number } }> = [
      { text: `闪卡复习 · ${this.cardCursor + 1}/${total} 张 · 累计错 ${card.wrongCount} 次`, color: 'accent' },
      { text: '', color: 'text' },
    ];
    // question/keyPoints 缺内容时给占位，避免渲染空块
    const question = card.question || '（无问题内容）';
    const keyPoints = card.keyPoints || '（无补充要点）';
    if (this.cardFlipped) {
      lines.push({ text: `问  ${question}`, color: 'muted' });
      lines.push({ text: '', color: 'text' });
      lines.push({ text: '要点', color: 'accent' });
      lines.push({ text: keyPoints, color: 'text' });
      lines.push({ text: '', color: 'text' });
      lines.push({ text: 'enter 下一张 · esc 退出复习', color: 'muted' });
    } else {
      lines.push({ text: question, color: 'text' });
      lines.push({ text: '', color: 'text' });
      lines.push({ text: 'enter 翻面看要点 · esc 退出复习', color: 'muted' });
    }
    return lines;
  }

  /** 本 session 全部答错的题（保持题序）。 */
  private wrongItems(): Array<{ exer: ExerciseItem; index: number }> {
    return this.session.exercises
      .map((exer, index) => ({ exer, index }))
      .filter((item) => item.exer.doResult === -1);
  }

  /**
   * 错题回顾行（wrongMode 时作为 renderLayout 主区域数据源）。
   */
  private wrongLinesStyled(): Array<{ text: string; color: string; marks?: Mark[]; dim?: { start: number; end: number } }> {
    const items = this.wrongItems();
    const lines: Array<{ text: string; color: string }> = [
      { text: `错题回顾 · ${items.length} 道（enter 跳到该题）`, color: 'accent' },
      { text: '', color: 'text' },
    ];
    if (!items.length) {
      lines.push({ text: '本题集暂无错题，继续保持！', color: 'muted' });
      return lines;
    }
    this.wrongCursor = Math.min(this.wrongCursor, items.length - 1);
    items.forEach((item, cursor) => {
      const pointer = cursor === this.wrongCursor ? '→' : ' ';
      const mine = item.exer.userKey || '未答';
      const right = item.exer.rightKey || (item.exer.rightKeyList || []).join('') || '?';
      const title = item.exer.title.length > 24 ? `${item.exer.title.slice(0, 24)}…` : item.exer.title;
      lines.push({
        text: `${pointer} ${item.index + 1}. ${title}（你答 ${mine} · 正确 ${right}）`,
        color: cursor === this.wrongCursor ? 'accent' : 'text',
      });
    });
    lines.push({ text: '', color: 'text' });
    lines.push({ text: '↑↓ 选择 · enter 跳到该题 · esc 返回答题', color: 'muted' });
    return lines;
  }

  /**
   * 题目主体行（无任何快捷键提示，供主区域与独立模式共用）。
   */
  public bodyLines(): string[] {
    return this.bodyLinesStyled().map((line) => line.text);
  }

  /**
   * 格式化当前题目与选项（保持旧测试兼容：纯文本、无快捷键说明）。
   */
  public renderQuestion(): string {
    return this.bodyLines().join('\n');
  }

  /**
   * 刷新界面（独立终端模式）
   */
  public refresh(): void {
    console.clear();
    console.log(this.renderQuestion());
    console.log('');
    console.log(this.sessionLineText());
    console.log('❯');
  }

  /**
   * 选择作答逻辑
   */
  public selectAnswer(ansKey: string): void {
    const cur = this.session.exercises[this.session.currentIndex];
    if (!cur) return;

    if (cur.newKeyType === 2) {
      // 多选题：可累加/反选
      const keys = new Set(cur.userKey ? cur.userKey.split('') : []);
      if (keys.has(ansKey)) keys.delete(ansKey);
      else keys.add(ansKey);
      cur.userKey = Array.from(keys).sort().join('');
    } else {
      // 单选题
      cur.userKey = ansKey;
      if (cur.rightKey) {
        cur.doResult = cur.userKey === cur.rightKey ? 1 : -1;
        // 答错自动展开答案与解析，无需手动按 V
        if (cur.doResult === -1) cur.viewAnswer = 1;
      }
    }
    this.cache.saveSession(this.session);
  }

  public setOnAiTutor(callback: OnAiTutorCallback): void {
    this.onAiTutor = callback;
  }

  public setOnChatAsk(callback: OnChatAskCallback): void {
    this.onChatAsk = callback;
  }

  public setOnAddCard(callback: OnAddCardCallback): void {
    this.onAddCard = callback;
  }

  /** K 键 / :card 入口：按优先级抽 10 张进入复习模式；空集返回 false。 */
  public openCardReview(): boolean {
    if (!this.cards || !this.cards.size()) return false;
    this.cardDeck = this.cards.draw(10);
    this.cardCursor = 0;
    this.cardFlipped = false;
    this.cardMode = true;
    return true;
  }

  /** 规则高亮开关：on 开启 / off 关闭，返回当前状态。 */
  public setHighlightEnabled(on: boolean): boolean {
    const changed = this.highlightEnabled !== on;
    this.highlightEnabled = on;
    if (changed) this.onHighlightChange?.(on);
    return this.highlightEnabled;
  }

  public getHighlightEnabled(): boolean {
    return this.highlightEnabled;
  }

  public toggleAnswer(): void {
    const current = this.session.exercises[this.session.currentIndex];
    if (current) current.viewAnswer = current.viewAnswer ? 0 : 1;
  }

  public move(delta: number): void {
    const next = this.session.currentIndex + delta;
    if (next >= 0 && next < this.session.exercises.length) {
      this.session.currentIndex = next;
      this.optionCursor = 0;
      this.cache.saveSession(this.session);
    }
  }

  /** 上下键移动选项光标（带边界回绕），不改变作答。 */
  public moveOptionCursor(delta: number): void {
    const count = this.currentOptionCount();
    if (!count) return;
    this.optionCursor = (this.optionCursor + delta + count) % count;
  }

  /** 确认当前光标所在选项（主观题无选项时忽略）。 */
  public confirmOptionCursor(): void {
    const cur = this.session.exercises[this.session.currentIndex];
    if (!cur) return;
    const count = this.currentOptionCount();
    if (!count) return;
    const cursor = Math.min(this.optionCursor, count - 1);
    const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
    this.selectAnswer(keys[cursor]);
  }

  private currentOptionCount(): number {
    const cur = this.session.exercises[this.session.currentIndex];
    if (!cur) return 0;
    return [cur.a, cur.b, cur.c, cur.d, cur.e, cur.f].filter((text) => !!text).length;
  }

  public jumpTo(index1based: number): boolean {
    if (!Number.isInteger(index1based) || index1based < 1 || index1based > this.session.exercises.length) {
      return false;
    }
    this.session.currentIndex = index1based - 1;
    this.cache.saveSession(this.session);
    return true;
  }

  private practicePayload() {
    return {
      prId: this.session.prId,
      lastPosition: this.session.currentIndex + 1,
      scoringMethod: this.session.scoringMethod,
      time: Math.floor((Date.now() - this.session.startTime) / 1000),
      exercises: this.session.exercises.map((e) => ({
        exerId: e.exerId || e.exerID || 0,
        score: 0,
        starCount: e.starCount || 0,
        userKey: e.userKey,
      })),
    };
  }

  public async saveProgress(): Promise<void> {
    this.cache.saveSession(this.session);
    await this.client.savePractice(this.practicePayload());
  }

  public async submitProgress(): Promise<ReturnType<KaodesClient['submitPractice']> extends Promise<infer T> ? T : never> {
    const response = await this.client.submitPractice(this.practicePayload());
    await Promise.allSettled(
      this.session.exercises
        .filter((exercise) => exercise.doResult === -1)
        .map((exercise) =>
          this.client.addWrong({
            exerID: exercise.exerId || exercise.exerID || 0,
            prid: this.session.prId,
            catID: this.session.catId || 0,
            courseId: this.session.courseId,
            cstId: this.session.cstId,
            source: 1,
            result: 0,
          })
        )
    );
    this.cache.clearSession(this.session.courseId, this.session.catId || 'default');
    return response;
  }

  /**
   * 行内分段着色：在已换行的纯文本片段上按 marks / dim 区间切 run 后逐段上色。
   * 关键约束：先定宽截断、后包 ANSI，宽度计算永远只看纯文本。
   */
  private paintChunkWithMarks(
    chunk: string,
    chunkStart: number,
    marks: Mark[] | undefined,
    dim: { start: number; end: number } | undefined,
    baseColor: string,
    paint: ThemePainter
  ): string {
    if (!marks?.length && !dim) return paint(baseColor, chunk);
    const end = chunkStart + chunk.length;
    // 每个字符归入一个 run 标签：mark kind / dim / base。相邻同标签合并成一段。
    const tagAt = (index: number): string => {
      const mark = marks?.find((m) => index >= m.start && index < m.end);
      if (mark) return `mark:${mark.kind}`;
      if (dim && index >= dim.start && index < dim.end) return 'dim';
      return 'base';
    };
    const paintRun = (tag: string, text: string): string => {
      if (tag === 'base') {
        // 解析部分（color='fixed'）用固定灰色，其他用主题色
        return baseColor === 'fixed' ? `\x1b[90m${text}\x1b[0m` : paint(baseColor, text);
      }
      if (tag === 'dim') return `${DIM_ANSI}${text}${RESET_ANSI}`;
      const kind = tag.slice(5) as Mark['kind'];
      return `${markAnsi(kind)}${text}${RESET_ANSI}`;
    };
    let out = '';
    let pos = chunkStart;
    while (pos < end) {
      const tag = tagAt(pos);
      let next = pos;
      while (next < end && tagAt(next) === tag) next++;
      out += paintRun(tag, chunk.slice(pos - chunkStart, next - chunkStart));
      pos = next;
    }
    return out;
  }

  /**
   * 完整布局：边框题目区（提问插件同款视觉）+ 底栏 session/状态行 + 指令输入行。
   */
  private renderLayout(
    width: number,
    state: { buffer: string; focused: boolean; status?: BottomStatus },
    paint: ThemePainter
  ): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];

    if (safeWidth >= 6) {
      const innerW = safeWidth - 2;
      const contentW = Math.max(1, innerW - 2);
      // Pi 原生编辑器同款：边框 borderMuted，内容按语义分层着色
      lines.push(paint('borderMuted', `╭${'─'.repeat(innerW)}╮`));
      for (const raw of this.cardMode ? this.cardLinesStyled() : this.wrongMode ? this.wrongLinesStyled() : this.chatMode ? this.chatLinesStyled() : this.bodyLinesStyled()) {
        const wrapped = wrapPlainWithOffsets(raw.text, contentW);
        if (wrapped.length === 0) {
          lines.push(paint('borderMuted', `│`) + ' ' + ' '.repeat(contentW) + ' ' + paint('borderMuted', `│`));
          continue;
        }
        for (const seg of wrapped) {
          const styled = this.paintChunkWithMarks(seg.text, seg.start, raw.marks, raw.dim, raw.color, paint);
          const pad = ' '.repeat(Math.max(0, contentW - visibleWidth(seg.text)));
          lines.push(
            paint('borderMuted', `│`) + ' ' + styled + pad + ' ' + paint('borderMuted', `│`)
          );
        }
      }
      lines.push(paint('borderMuted', `╰${'─'.repeat(innerW)}╯`));
    } else {
      // 极窄终端退化：无边框纯文本，保证不重叠、不越界。
      for (const raw of this.cardMode ? this.cardLinesStyled() : this.wrongMode ? this.wrongLinesStyled() : this.chatMode ? this.chatLinesStyled() : this.bodyLinesStyled()) {
        const wrapped = wrapPlainWithOffsets(raw.text, safeWidth);
        if (wrapped.length === 0) lines.push('');
        for (const seg of wrapped) {
          lines.push(this.paintChunkWithMarks(seg.text, seg.start, raw.marks, raw.dim, raw.color, paint));
        }
      }
    }

    // 底栏第一行：临时状态优先，否则 session 上下文（单行、… 截断）。
    const bottomPlain = state.status
      ? `${STATUS_PREFIX[state.status.level]}${state.status.text}`
      : this.sessionLineText();
    const bottomColor = state.status ? STATUS_COLOR[state.status.level] : 'dim';
    lines.push(paint(bottomColor, truncateWithEllipsis(bottomPlain, safeWidth)));

    // 底栏第二行：低干扰指令输入入口（提问插件同款 ❯ 前缀 + 反显光标）。
    if (safeWidth < 4) {
      lines.push(paint('dim', truncateToWidth('❯', safeWidth)));
      return lines;
    }
    const prefix = '❯ ';
    const maxBufferW = safeWidth - visibleWidth(prefix) - 1; // 预留光标一格
    let buffer = state.buffer;
    while (visibleWidth(buffer) > maxBufferW && buffer.length > 0) {
      buffer = Array.from(buffer).slice(1).join(''); // 超长时保留尾部
    }
    if (state.focused) {
      lines.push(paint('accent', `${prefix}${buffer}`) + REVERSE_ON + ' ' + REVERSE_OFF);
    } else {
      lines.push(paint('dim', prefix));
    }
    return lines;
  }

  /**
   * 在 Pi 官方 TUI 中运行，避免直接接管宿主进程 stdin。
   */
  public async startInPi(ui: PiExerciseUI): Promise<void> {
    this.isRunning = true;
    await ui.custom<void>((tui, theme, _keybindings, done) => {
      const paint = makeThemePainter(theme);
      let busy = false;
      let inputFocused = false;
      let buffer = '';
      let status: BottomStatus | undefined;
      let statusTimer: ReturnType<typeof setTimeout> | undefined;

      const setStatus = (text: string, level: StatusLevel, ttlMs = 4000): void => {
        if (statusTimer) clearTimeout(statusTimer);
        status = { text, level };
        if (ttlMs > 0) {
          statusTimer = setTimeout(() => {
            status = undefined;
            statusTimer = undefined;
            tui.requestRender();
          }, ttlMs);
          statusTimer.unref?.();
        }
        tui.requestRender();
      };

      const finish = () => {
        if (statusTimer) clearTimeout(statusTimer);
        this.isRunning = false;
        done(undefined);
      };

      // 模态视图（闪卡/对话/错题/退出框）行数与答题视图不同，
      // 普通 requestRender 走宿主行级 diff，切换瞬间会残留旧帧行（错位）；
      // 强制全量重绘根除该问题。
      const redraw = (): void => tui.requestRender(true);

      const run = async (action: () => Promise<void>) => {
        if (busy) return;
        busy = true;
        setStatus('正在处理', 'busy', 0);
        try {
          await action();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(message, 'error', 6000);
          ui.notify(`操作失败: ${message}`, 'error');
        } finally {
          busy = false;
          if (status?.level === 'busy') status = undefined;
          tui.requestRender();
        }
      };

      const answerFeedback = (): void => {
        const cur = this.session.exercises[this.session.currentIndex];
        if (!cur) return;
        if (cur.newKeyType === 2) {
          setStatus(cur.userKey ? `已选 ${cur.userKey}` : '已清空选择', 'info');
        } else if (cur.doResult === 1) {
          setStatus('回答正确', 'success');
        } else if (cur.doResult === -1) {
          setStatus(this.onAddCard ? '回答错误 · 按 Y 加入闪卡集' : '回答错误', 'error');
        }
      };

      // 退出对话框在组件内自绘：Pi 的 ui.select 无法叠加在 custom 组件之上，
      // 嵌套调用会因 Promise 永不 resolve 导致 busy 卡死（按键全部失效）。
      const EXIT_OPTIONS = ['保存断点并退出', '不保存退出', '继续答题'];
      let exitOpen = false;
      let exitCursor = 0;

      const renderExitDialog = (width: number): string[] => {
        const lines: string[] = [];
        lines.push(paint('accent', truncateWithEllipsis('退出练习', width)));
        lines.push('');
        EXIT_OPTIONS.forEach((option, index) => {
          lines.push(
            index === exitCursor
              ? paint('accent', truncateWithEllipsis(`→ ${option}`, width))
              : truncateWithEllipsis(`  ${option}`, width)
          );
        });
        lines.push('');
        lines.push(paint('dim', truncateWithEllipsis('↑↓ 选择 · Enter 确认 · Esc 继续答题', width)));
        return lines;
      };

      const openExitDialog = (): void => {
        exitOpen = true;
        exitCursor = 0;
        redraw();
      };

      const submitAndFinish = (): void => {
        void run(async () => {
          const response = await this.submitProgress();
          const result = response.data;
          ui.notify(
            `提交完成：${result.correctNum}/${result.exerNum}，正确率 ${result.correctRate}`,
            'success'
          );
          finish();
        });
      };

      const executeCommand = (raw: string): void => {
        const parts = raw.trim().toLowerCase().split(/\s+/);
        const cmd = parts[0];
        const arg = parts.slice(1).filter((token) => token.length > 0).join(' ');

        if (/^\d+$/.test(cmd)) {
          const target = parseInt(cmd, 10);
          if (this.jumpTo(target)) tui.requestRender();
          else setStatus(`题目序号超出范围 1-${this.session.exercises.length}`, 'error');
          return;
        }

        switch (cmd) {
          case 'help':
          case 'h':
          case '?':
            ui.notify(KAODES_HELP, 'info');
            return;
          case 'next':
          case 'n':
            this.move(1);
            tui.requestRender();
            return;
          case 'prev':
          case 'p':
            this.move(-1);
            tui.requestRender();
            return;
          case 'goto':
          case 'g': {
            if (!/^\d+$/.test(arg)) {
              setStatus('用法: goto <n>', 'error');
              return;
            }
            const target = parseInt(arg, 10);
            if (this.jumpTo(target)) tui.requestRender();
            else setStatus(`题目序号超出范围 1-${this.session.exercises.length}`, 'error');
            return;
          }
          case 'show':
          case 'v':
            this.toggleAnswer();
            tui.requestRender();
            return;
          case 'ans':
          case 'answer':
          case 'a': {
            const letters = arg.toUpperCase().replace(/[^A-F]/g, '').split('');
            if (!letters.length) {
              setStatus('用法: ans <AB…>', 'error');
              return;
            }
            for (const letter of letters) this.selectAnswer(letter);
            answerFeedback();
            return;
          }
          case 'save':
          case 's':
            void run(async () => {
              await this.saveProgress();
              setStatus('进度已同步', 'success');
            });
            return;
          case 'submit':
          case 'q':
            submitAndFinish();
            return;
          case 'hint':
          case 't': {
            const cur = this.session.exercises[this.session.currentIndex];
            if (cur && this.onAiTutor) void run(() => this.onAiTutor!(cur, 'hint'));
            return;
          }
          case 'ask':
          case 'f': {
            // AI 追问面板（与 F 键同路径）：多轮对话，esc 返回答题
            if (this.onChatAsk) openChat();
            else setStatus('AI 通道未就绪', 'error');
            return;
          }
          case 'hl':
          case 'highlight': {
            // 规则高亮开关：题眼=黄 · 否定设问=红 · 解析结论=绿 · 选项公共前缀=灰
            const next = !this.getHighlightEnabled();
            const on = arg === 'on' ? true : arg === 'off' ? false : next;
            if (arg && arg !== 'on' && arg !== 'off') {
              setStatus('用法: hl [on|off]', 'error');
              return;
            }
            this.setHighlightEnabled(on);
            setStatus(`规则高亮已${on ? '开启' : '关闭'}`, 'success');
            return;
          }
          case 'hll': {
            // 手动触发 LLM 考点抽取（额外 token）
            const cur = this.session.exercises[this.session.currentIndex];
            if (!cur) {
              setStatus('当前无题目', 'error');
              return;
            }
            setStatus('正在调用 AI 提取考点...', 'busy');
            run(async () => {
              try {
                const onAiTutor = this.onAiTutor;
                if (onAiTutor) {
                  // 复用 AI 点拨路径，但只用于抽取高亮词
                  await onAiTutor(cur, 'hint');
                  // 如果主回答没带【高亮】，兜底会尝试轻量抽取
                  setStatus(cur.llmMarks?.length ? 'LLM 考点已标注' : '未找到考点（仅规则词典生效）', 'info');
                } else {
                  setStatus('AI 暂不可用', 'error');
                }
              } catch (e) {
                setStatus('AI 调用失败：' + (e instanceof Error ? e.message : String(e)), 'error');
              }
            });
            return;
          }
          case 'wrong':
          case 'w': {
            // 错题集中回顾：列出本 session 全部答错的题
            const wrongCount = this.wrongItems().length;
            if (!wrongCount) {
              setStatus('暂无错题', 'info');
              return;
            }
            this.wrongMode = true;
            this.wrongCursor = 0;
            redraw();
            return;
          }
          case 'card':
          case 'k': {
            // 闪卡复习：按优先级抽卡（错得多 / 久未复习优先）
            if (!this.openCardReview()) setStatus('闪卡集为空：答错题目后按 Y 加入闪卡', 'info');
            redraw();
            return;
          }
          case 'exit':
          case 'quit':
          case 'esc': {
            if (arg === 'save') {
              this.cache.saveSession(this.session);
              finish();
            } else if (arg === 'discard') {
              this.cache.clearSession(this.session.courseId, this.session.catId || 'default');
              finish();
            } else if (!arg) {
              openExitDialog();
            } else {
              setStatus('用法: exit [save|discard]', 'error');
            }
            return;
          }
          default:
            setStatus(`未知命令: ${cmd}（help 查看）`, 'error', 6000);
            return;
        }
      };

      const submitInput = (): void => {
        const raw = buffer;
        buffer = '';
        inputFocused = false;
        tui.requestRender();
        if (raw.trim()) executeCommand(raw);
      };

      // 面板内发送追问：先落 user 轮再调 LLM，失败撤回避免历史残留无回应问句
      const submitChat = (): void => {
        const cur = this.session.exercises[this.session.currentIndex];
        const question = buffer.trim();
        if (!question || !cur || !this.onChatAsk || this.chatBusy) return;
        buffer = '';
        const history = cur.chatHistory ?? (cur.chatHistory = []);
        history.push({ role: 'user', content: question });
        this.chatBusy = true;
        tui.requestRender();
        void (async () => {
          try {
            const answer = await this.onChatAsk!(cur, history.slice(0, -1), question);
            if (answer) {
              history.push({ role: 'assistant', content: answer });
              this.cache.saveSession(this.session);
            } else {
              history.pop();
              setStatus('当前会话无可用模型', 'error', 6000);
            }
          } catch (error) {
            history.pop();
            setStatus('AI 调用失败：' + (error instanceof Error ? error.message : String(error)), 'error', 6000);
          } finally {
            this.chatBusy = false;
            redraw();
          }
        })();
      };

      const openChat = (): void => {
        this.chatMode = true;
        inputFocused = true;
        buffer = '';
        redraw();
      };

      const cancelInput = (): void => {
        buffer = '';
        inputFocused = false;
        tui.requestRender();
      };

      return {
        render: (width: number) =>
          exitOpen
            ? renderExitDialog(width)
            : this.renderLayout(width, { buffer, focused: inputFocused, status }, paint),
        handleInput: (data: string) => {
          if (busy || !this.isRunning) return;
          const key = parseKeyName(data);

          // 退出对话框模态：优先于答题 / 记忆卡 / 输入框处理
          if (exitOpen) {
            if (key === 'up' || key === 'k') exitCursor = Math.max(0, exitCursor - 1);
            else if (key === 'down' || key === 'j') exitCursor = Math.min(EXIT_OPTIONS.length - 1, exitCursor + 1);
            else if (key === 'enter') {
              if (exitCursor === 0) {
                this.cache.saveSession(this.session);
                finish();
                return;
              }
              if (exitCursor === 1) {
                this.cache.clearSession(this.session.courseId, this.session.catId || 'default');
                finish();
                return;
              }
              exitOpen = false;
              redraw();
            } else if (key === 'escape') {
              exitOpen = false;
              redraw();
            } else if (key === 'ctrl+c') {
              this.cache.saveSession(this.session);
              finish();
              return;
            } else return;
            tui.requestRender();
            return;
          }

          const current = this.session.exercises[this.session.currentIndex];

          // 错题回顾模态：↑↓ 选择，enter 跳到该题，esc 返回答题
          if (this.wrongMode) {
            const items = this.wrongItems();
            if (key === 'escape') {
              this.wrongMode = false;
              redraw();
              return;
            }
            if (key === 'up') this.wrongCursor = Math.max(0, this.wrongCursor - 1);
            else if (key === 'down') this.wrongCursor = Math.min(items.length - 1, this.wrongCursor + 1);
            else if (data === '\r' || data === '\n') {
              if (items[this.wrongCursor]) {
                this.jumpTo(items[this.wrongCursor].index + 1);
                this.wrongMode = false;
              }
            } else return;
            redraw();
            return;
          }

          // 闪卡复习模态：enter 翻面 / 翻面后 enter 记一次复习并下一张 / esc 退出
          if (this.cardMode) {
            if (key === 'escape') {
              this.cardMode = false;
              redraw();
              return;
            }
            if (data === '\r' || data === '\n') {
              if (!this.cardFlipped) {
                this.cardFlipped = true;
              } else {
                const card = this.cardDeck[this.cardCursor];
                if (card) this.cards?.markReviewed(card.exerId);
                this.cardCursor += 1;
                this.cardFlipped = false;
                if (this.cardCursor >= this.cardDeck.length) {
                  this.cardMode = false;
                  setStatus('本轮闪卡复习完成', 'success');
                }
              }
              redraw();
              return;
            }
            return;
          }

          // AI 追问面板模态：直接打字，enter 发送，esc 返回答题（优先于退出对话框）
          if (this.chatMode) {
            if (key === 'escape') {
              this.chatMode = false;
              inputFocused = false;
              buffer = '';
              redraw();
              return;
            }
            if (this.chatBusy) return; // 思考中不接受输入，避免乱序
            if (data === '\r' || data === '\n') {
              submitChat();
            } else if (key === 'c') {
              // 面板内按 C：无卡时提示（有卡时已被上方记忆卡模态接管）
              setStatus('暂无记忆卡：AI 回答含【记忆卡】时自动生成', 'info');
            } else if (data === '\x7f' || data === '\b') {
              const chars = Array.from(buffer);
              buffer = chars.slice(0, -1).join('');
              tui.requestRender();
            } else if (data === '\x15') {
              buffer = '';
              tui.requestRender();
            } else if (data === '\x03') {
              this.cache.saveSession(this.session);
              finish();
            } else if (data.startsWith('\x1b')) {
              return; // 方向键等序列忽略
            } else if (data >= ' ') {
              buffer += data;
              tui.requestRender();
            }
            return;
          }

          if (inputFocused) {
            if (data === '\r' || data === '\n') {
              submitInput();
            } else if (data === '\x7f' || data === '\b') {
              const chars = Array.from(buffer);
              buffer = chars.slice(0, -1).join('');
              tui.requestRender();
            } else if (data === '\x15') {
              buffer = '';
              tui.requestRender();
            } else if (data === '\x03' || (data === '\x1b' && !data.startsWith('\x1b['))) {
              cancelInput();
            } else if (data.startsWith('\x1b')) {
              // 方向键等序列在输入态下忽略，避免误触翻题。
              return;
            } else if (data >= ' ') {
              buffer += data;
              tui.requestRender();
            }
            return;
          }

          if (data === ':' || data === '/') {
            inputFocused = true;
            buffer = '';
            tui.requestRender();
          } else if (key === 'ctrl+c') {
            this.cache.saveSession(this.session);
            finish();
          } else if (key === 'escape') {
            openExitDialog();
          } else if (key === 't' && current && this.onAiTutor) {
            void run(() => this.onAiTutor!(current, 'hint'));
          } else if (key === 'f' && current && this.onChatAsk) {
            // F：进入 AI 追问面板（多轮对话）
            openChat();
          } else if (key === 'w' && this.wrongItems().length) {
            // W：错题集中回顾
            this.wrongMode = true;
            this.wrongCursor = 0;
            redraw();
          } else if (key === 'k') {
            // K：闪卡抽卡复习
            if (!this.openCardReview()) setStatus('闪卡集为空：答错题目后按 Y 加入闪卡', 'info');
            redraw();
          } else if (key === 'y' && current && current.doResult === -1 && this.onAddCard) {
            // Y：答错后确认，AI 组卡入集（相似错题 = 本 session 其他错题）
            const cardCtx = {
              siblingTitles: this.session.exercises
                .filter((e) => e.doResult === -1 && e !== current && e.title)
                .map((e) => e.title),
              courseId: this.session.courseId,
              chapterName: this.session.chapterName,
            };
            void run(async () => {
              setStatus('正在生成闪卡...', 'busy', 0);
              const message = await this.onAddCard!(current, cardCtx);
              if (message) setStatus(message, 'success');
              else setStatus('闪卡生成失败（AI 未返回有效内容）', 'error', 6000);
            });
          } else if (['a', 'b', 'c', 'd', 'e'].includes(key)) {
            this.selectAnswer(key.toUpperCase());
            answerFeedback();
          } else if (key === 'v') {
            this.toggleAnswer();
            tui.requestRender();
          } else if (key === 'up') {
            this.moveOptionCursor(-1);
            tui.requestRender();
          } else if (key === 'down') {
            this.moveOptionCursor(1);
            tui.requestRender();
          } else if (key === 'enter') {
            if (this.currentOptionCount()) {
              this.confirmOptionCursor();
              answerFeedback();
            } else {
              this.toggleAnswer(); // 主观题无选项，Enter 退回查看解析
            }
            tui.requestRender();
          } else if (key === 'n' || key === 'right') {
            this.move(1);
            tui.requestRender();
          } else if (key === 'p' || key === 'left') {
            this.move(-1);
            tui.requestRender();
          } else if (key === 's') {
            void run(async () => {
              await this.saveProgress();
              setStatus('进度已同步', 'success');
            });
          } else if (key === 'q') {
            submitAndFinish();
          }
        },
        invalidate: () => undefined,
      };
    });
  }



  /**
   * 启动 TUI 交互监听
   */
  public async start(): Promise<void> {
    this.isRunning = true;
    this.refresh();

    if (!process.stdin.isTTY) {
      // 非交互环境时直接返回
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    return new Promise((resolve) => {
      const keyHandler = async (_str: string, key: readline.Key) => {
        if (!this.isRunning) return;

        // Ctrl+C 强制退出
        if (key.ctrl && key.name === 'c') {
          this.cleanup();
          resolve();
          return;
        }

        const name = (key.name || '').toLowerCase();
        const curExer = this.session.exercises[this.session.currentIndex];

        if (['a', 'b', 'c', 'd', 'e'].includes(name)) {
          this.selectAnswer(name.toUpperCase());
          this.refresh();
        } else if (name === 'v' || name === 'return') {
          // 查看解析
          if (curExer) {
            curExer.viewAnswer = curExer.viewAnswer ? 0 : 1;
            this.refresh();
          }
        } else if (name === 'n' || name === 'right') {
          // 下一题
          if (this.session.currentIndex < this.session.exercises.length - 1) {
            this.session.currentIndex++;
            this.refresh();
          }
        } else if (name === 'p' || name === 'left') {
          // 上一题
          if (this.session.currentIndex > 0) {
            this.session.currentIndex--;
            this.refresh();
          }
        } else if (name === 's') {
          // 暂存云端
          this.cache.saveSession(this.session);
          console.log('\n正在保存学习进度至云端...');
          await this.client
            .savePractice({
              prId: this.session.prId,
              lastPosition: this.session.currentIndex + 1,
              scoringMethod: this.session.scoringMethod,
              time: Math.floor((Date.now() - this.session.startTime) / 1000),
              exercises: this.session.exercises.map((e) => ({
                exerId: e.exerId || e.exerID || 0,
                score: 0,
                starCount: e.starCount || 0,
                userKey: e.userKey,
              })),
            })
            .then(() => console.log('✓ 进度已成功同步至考得尚云端！'))
            .catch((err) => console.error('保存失败:', err.message));
          setTimeout(() => this.refresh(), 1200);
        } else if (name === 'q') {
          // 提交答题并退出
          this.cleanup();
          console.log('\n正在提交答题结果结算...');
          try {
            const res = await this.client.submitPractice({
              prId: this.session.prId,
              lastPosition: this.session.currentIndex + 1,
              scoringMethod: this.session.scoringMethod,
              time: Math.floor((Date.now() - this.session.startTime) / 1000),
              exercises: this.session.exercises.map((e) => ({
                exerId: e.exerId || e.exerID || 0,
                score: 0,
                starCount: e.starCount || 0,
                userKey: e.userKey,
              })),
            });
            console.log(`总题数: ${res.data.exerNum} | 正确: ${res.data.correctNum} | 正确率: ${res.data.correctRate}`);
            this.cache.clearSession(this.session.courseId, this.session.catId || 'default');
          } catch (e: any) {
            console.error('提交失败:', e.message);
          }
          resolve();
        } else if (name === 't') {
          // 触发 AI 思路点拨
          if (this.onAiTutor && curExer) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('keypress', keyHandler);
            await this.onAiTutor(curExer, 'hint');
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('keypress', keyHandler);
            this.refresh();
          }
        } else if (name === 'f') {
          // 触发 AI 反问闪卡模式
          if (this.onAiTutor && curExer) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('keypress', keyHandler);
            await this.onAiTutor(curExer, 'flashcard');
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('keypress', keyHandler);
            this.refresh();
          }
        }
      };

      process.stdin.on('keypress', keyHandler);
    });
  }

  private cleanup(): void {
    this.isRunning = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}
