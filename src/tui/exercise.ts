import readline from 'node:readline';
import { parseKeyName } from './keys.js';
import { commonPrefixLength, findMarks, markAnsi, DIM_ANSI, RESET_ANSI, Mark } from './highlight.js';
import { ExerciseItem, PracticeSession } from '../types.js';
import { KaodesClient } from '../api/client.js';
import { SessionCache } from '../cache/session.js';

export type OnAiTutorCallback = (exer: ExerciseItem, mode: 'hint' | 'flashcard') => Promise<void>;

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
      tui: { requestRender(): void },
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
  '  T              AI 点拨（一键分析当前题）',
  '  F              快速问 AI（输入问题，回答可能附记忆卡）',
  '  C              查看记忆卡（AI 回答后生成，enter 翻面）',
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
  '  ask | f                 快速问 AI',
  '  card | c                查看记忆卡',
  '  hl [on|off]             规则高亮开关',
  '  exit [save|discard]     退出（可指定保存 / 不保存）',
  '',
  '规则高亮配色:',
  '  题眼定位词（根本/本质/关键…）= 黄 · 否定设问（错误的是/不属于…）= 红',
  '  解析结论词（因此/由此可见…）= 绿 · 选项公共前缀 = 灰（只留差异）',
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
  private isRunning = false;
  /** 选项列表光标（上下键移动，Enter 确认），提问插件同款交互。 */
  private optionCursor = 0;
  /** 规则高亮开关（:hl on|off），第一阶段仅本地词典。 */
  private highlightEnabled = true;
  /** 高亮开关变化时的持久化回调（由宿主注入，写入用户偏好）。 */
  private onHighlightChange?: (on: boolean) => void;
  /** AI 记忆卡（从最近一次 AI 回答中提取，按 C 查看） */
  private memoryCard: MemoryCard | undefined;
  /** 记忆卡查看状态：正面 / 背面 */
  private memoryCardFlipped = false;

  constructor(
    session: PracticeSession,
    client: KaodesClient,
    cache: SessionCache,
    onAiTutor?: OnAiTutorCallback,
    options?: { highlightEnabled?: boolean; onHighlightChange?: (on: boolean) => void }
  ) {
    this.session = session;
    this.client = client;
    this.cache = cache;
    this.onAiTutor = onAiTutor;
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
    const marksOf = (text: string): Mark[] | undefined =>
      this.highlightEnabled && text ? findMarks(text) : undefined;

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
      for (const [index, option] of opts.entries()) {
        // Pi 官方 select 同款：→ 指示光标行，其余行两空格缩进，Enter 确认
        const pointer = index === cursor ? '→' : ' ';
        const text = `${pointer} ${option.key}. ${option.text}`;
        const textStart = text.length - option.text!.length;
        lines.push({
          text,
          color: index === cursor ? 'accent' : 'text',
          marks: marksOf(text),
          dim: lcp ? { start: textStart, end: textStart + lcp } : undefined,
        });
      }
    } else {
      lines.push({ text: '（主观题，无选项）', color: 'muted' });
    }

    if (cur.viewAnswer) {
      lines.push({ text: '', color: 'text' });
      lines.push({
        text: `答案  ${cur.rightKey || (cur.rightKeyList ? cur.rightKeyList.join('') : '详见解析')}`,
        color: 'accent',
      });
      if (cur.analyze) {
        const analyzeText = `解析  ${cur.analyze}`;
        lines.push({ text: analyzeText, color: 'text', marks: marksOf(analyzeText) });
      }
    }

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
   * 记忆卡查看渲染（C 键触发）：正面问题 / 背面要点，Anki 式翻面。
   */
  private renderMemoryCard(
    width: number,
    state: { buffer: string; focused: boolean; status?: BottomStatus },
    paint: ThemePainter
  ): string[] {
    const card = this.memoryCard!;
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];

    const body: Array<{ text: string; color: string }> = [
      { text: `记忆卡 · ${this.memoryCardFlipped ? '背面' : '正面'}`, color: 'accent' },
      { text: '', color: 'text' },
    ];
    if (this.memoryCardFlipped) {
      body.push({ text: `问  ${card.question}`, color: 'muted' });
      body.push({ text: '', color: 'text' });
      body.push({ text: '要点', color: 'accent' });
      body.push({ text: card.keyPoints || '（无补充要点）', color: 'text' });
      body.push({ text: '', color: 'text' });
      body.push({ text: 'enter/esc 返回答题', color: 'muted' });
    } else {
      body.push({ text: card.question, color: 'text' });
      body.push({ text: '', color: 'text' });
      body.push({ text: 'enter 翻面看要点 · esc 返回答题', color: 'muted' });
    }

    if (safeWidth >= 6) {
      const innerW = safeWidth - 2;
      const contentW = Math.max(1, innerW - 2);
      lines.push(paint('borderMuted', `╭${'─'.repeat(innerW)}╮`));
      for (const raw of body) {
        const wrapped = wrapPlain(raw.text, contentW);
        if (wrapped.length === 0) {
          lines.push(paint('borderMuted', `│`) + ' ' + ' '.repeat(contentW) + ' ' + paint('borderMuted', `│`));
          continue;
        }
        for (const seg of wrapped) {
          lines.push(
            paint('borderMuted', `│`) +
              ' ' +
              paint(raw.color, padPlain(seg, contentW)) +
              ' ' +
              paint('borderMuted', `│`)
          );
        }
      }
      lines.push(paint('borderMuted', `╰${'─'.repeat(innerW)}╯`));
    } else {
      for (const raw of body) {
        const wrapped = wrapPlain(raw.text, safeWidth);
        if (wrapped.length === 0) lines.push('');
        for (const seg of wrapped) lines.push(paint(raw.color, seg));
      }
    }

    // 底栏与主界面共用：状态优先，否则 session 行；记忆卡模式下不显示指令输入行
    const bottomPlain = state.status
      ? `${STATUS_PREFIX[state.status.level]}${state.status.text}`
      : this.sessionLineText();
    const bottomColor = state.status ? STATUS_COLOR[state.status.level] : 'dim';
    lines.push(paint(bottomColor, truncateWithEllipsis(bottomPlain, safeWidth)));
    return lines;
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
      if (tag === 'base') return paint(baseColor, text);
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

    if (this.memoryCard) {
      // 记忆卡查看模式：主区域替换为卡片正面/背面
      return this.renderMemoryCard(width, state, paint);
    }
    if (safeWidth >= 6) {
      const innerW = safeWidth - 2;
      const contentW = Math.max(1, innerW - 2);
      // Pi 原生编辑器同款：边框 borderMuted，内容按语义分层着色
      lines.push(paint('borderMuted', `╭${'─'.repeat(innerW)}╮`));
      for (const raw of this.bodyLinesStyled()) {
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
      for (const raw of this.bodyLinesStyled()) {
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
          setStatus('回答错误', 'error');
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
        tui.requestRender();
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
            // 快速问 AI：与 F 键同路径
            const cur = this.session.exercises[this.session.currentIndex];
            if (cur && this.onAiTutor) void run(() => this.onAiTutor!(cur, 'flashcard'));
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
          case 'card':
          case 'c': {
            // 查看记忆卡（若有）
            if (this.memoryCard) {
              if (!this.memoryCardFlipped) {
                this.memoryCardFlipped = true;
              } else {
                this.memoryCard = undefined;
              }
              tui.requestRender();
            } else {
              setStatus('暂无记忆卡：先按 F 问 AI，回答含记忆卡时自动保存', 'info');
            }
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
            } else if (key === 'escape') {
              exitOpen = false;
            } else if (key === 'ctrl+c') {
              this.cache.saveSession(this.session);
              finish();
              return;
            } else return;
            tui.requestRender();
            return;
          }

          const current = this.session.exercises[this.session.currentIndex];

          // 闪卡模式按键接管：输入简答 / enter 翻面（触发点评）/ esc 返回
          if (this.memoryCard) {
            // 记忆卡查看模式：enter 翻面 / esc 或翻面后 enter 返回
            if (key === 'escape') {
              this.memoryCard = undefined;
              tui.requestRender();
              return;
            }
            if (data === '\r' || data === '\n') {
              if (!this.memoryCardFlipped) {
                this.memoryCardFlipped = true;
              } else {
                this.memoryCard = undefined;
              }
              tui.requestRender();
              return;
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
          } else if (key === 'f' && current && this.onAiTutor) {
            // F：快速问 AI（输入问题 → LLM 回答，可能附带记忆卡）
            void run(() => this.onAiTutor!(current, 'flashcard'));
          } else if (key === 'c' && this.memoryCard) {
            // C：翻看 AI 生成的记忆卡
            if (!this.memoryCardFlipped) {
              this.memoryCardFlipped = true;
            } else {
              this.memoryCard = undefined;
            }
            tui.requestRender();
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

  /** 记录 AI 回答：提取记忆卡供 C 键查看 */
  public setLastAiAnswer(answer: string): void {
    const { card } = extractMemoryCard(answer);
    this.memoryCard = card;
    this.memoryCardFlipped = false;
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
