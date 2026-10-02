import { parseKeyName } from './keys.js';
import { ExerciseItem } from '../types.js';
import { WrongFilter, WrongSort, queryWrong, wrongStats } from '../cache/wrongBook.js';
import { visibleWidth, truncateToWidth } from './exercise.js';

export interface WrongBookRow {
  item: ExerciseItem;
  title: string;
  chapter: string;
  wrongCount: number;
  streak: number;
  mastered: boolean;
  removed: boolean;
  lastWrongAt: number;
  priority: number;
  reason: string;
}

export interface WrongBookListConfig {
  courseName: string;
  banner?: string;
  pageSize?: number;
  entries: WrongBookRow[];
  onMaster: (exerId: number) => void;
  onRestore: (exerId: number) => void;
  onRemove: (exerId: number) => void;
}

/** undefined = 关闭。again 为真时只重练当前题，并已清空作答。 */
export type WrongBookResult = { items: ExerciseItem[]; index: number; again: boolean } | undefined;

export interface WrongBookUI {
  custom<T>(
    factory: (
      tui: { requestRender(): void },
      theme: unknown,
      keybindings: unknown,
      done: (value: T) => void
    ) => { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void }
  ): Promise<T>;
}

const FILTERS: WrongFilter[] = ['pending', 'mastered', 'removed', 'all'];
const SORTS: WrongSort[] = ['priority', 'recent', 'count', 'chapter'];
const FILTER_LABEL: Record<WrongFilter, string> = {
  pending: '待复习',
  mastered: '已掌握',
  removed: '移出',
  all: '全部',
};
const SORT_LABEL: Record<WrongSort, string> = {
  priority: '优先级',
  recent: '最近出错',
  count: '错误次数',
  chapter: '章节',
};

const RESET = '\x1b[0m';
const FALLBACK: Record<string, string> = { dim: '\x1b[2m', muted: '\x1b[2m', accent: '\x1b[36m' };

function paintOf(theme: unknown): (color: string, text: string) => string {
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
  return (color, text) => (FALLBACK[color] ? FALLBACK[color] + text + RESET : text);
}

function ellipsis(value: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return '…';
  return truncateToWidth(value, width - 1) + '…';
}

function exerIdOf(row: WrongBookRow): number {
  return Number(row.item.exerId || row.item.exerID || 0);
}

function freshCopy(item: ExerciseItem): ExerciseItem {
  return { ...item, userKey: null, doResult: 0, viewAnswer: 0 };
}

export function createWrongBookComponent(
  tui: { requestRender(): void },
  theme: unknown,
  config: WrongBookListConfig,
  done: (value: WrongBookResult) => void
): { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void } {
  const paint = paintOf(theme);
  const pageSize = Math.max(1, config.pageSize ?? 15);
  let filter: WrongFilter = 'pending';
  let sort: WrongSort = 'priority';
  let chapter = '';
  let cursor = 0;
  let showReason = false;
  let status = '';
  let settled = false;

  const chapters = (): string[] => {
    const set = new Set<string>();
    for (const row of config.entries) {
      if (row.chapter && row.chapter !== '未分章') set.add(row.chapter);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  };

  const visible = (): WrongBookRow[] => queryWrong(config.entries, { filter, sort, chapter });

  const finish = (value: WrongBookResult): void => {
    if (settled) return;
    settled = true;
    done(value);
  };

  const rowLine = (row: WrongBookRow): string => {
    const when = sort === 'recent' && row.lastWrongAt
      ? ` · ${new Date(row.lastWrongAt).getMonth() + 1}/${new Date(row.lastWrongAt).getDate()}`
      : '';
    const flags = [
      row.mastered ? '掌握' : '',
      row.removed ? '移出' : '',
      row.streak ? `连续${row.streak}` : '',
    ].filter(Boolean).join(' · ');
    return `${row.title} · ${row.chapter} · 错${row.wrongCount} · 优先${row.priority}${when}${flags ? ` · ${flags}` : ''}`;
  };

  return {
    render: (width: number) => {
      const rows = visible();
      const stats = wrongStats(config.entries);
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
      if (cursor > rows.length - 1) cursor = Math.max(0, rows.length - 1);
      const page = rows.length ? Math.floor(cursor / pageSize) : 0;
      const start = page * pageSize;
      const lines: string[] = [];
      const chapterLabel = chapter || '全部';
      lines.push(paint('accent', ellipsis(`${config.courseName} · ${FILTER_LABEL[filter]} · ${SORT_LABEL[sort]} · ${chapterLabel}`, width)));
      lines.push(ellipsis(`题量 ${stats.total} · 待复习 ${stats.pending} · 已掌握 ${stats.mastered}`, width));
      if (config.banner) lines.push(paint('muted', ellipsis(config.banner, width)));
      lines.push('');
      if (!rows.length) {
        lines.push(paint('muted', ellipsis('这个筛选下没有题', width)));
      } else {
        for (let i = start; i < Math.min(rows.length, start + pageSize); i++) {
          const label = `${i + 1}. ${rowLine(rows[i])}`;
          lines.push(i === cursor ? paint('accent', ellipsis(`→ ${label}`, width)) : ellipsis(`  ${label}`, width));
        }
        if (showReason && rows[cursor]) {
          lines.push('');
          lines.push(paint('muted', ellipsis(`错因  ${rows[cursor].reason}`, width)));
        }
      }
      lines.push('');
      if (status) lines.push(paint('muted', ellipsis(status, width)));
      const pageHint = pageCount > 1 ? ` · 第 ${page + 1}/${pageCount} 页` : '';
      lines.push(paint('dim', ellipsis(`↑↓ 选择 · F 筛选 · S 排序 · C 章节 · V 错因 · Enter 练习 · G 重练 · M 掌握 · R 恢复 · X 移出 · Esc 关闭${pageHint}`, width)));
      return lines;
    },
    handleInput: (data: string) => {
      if (settled) return;
      const key = parseKeyName(data);
      const rows = visible();
      const current = rows[cursor];
      if (key === 'up' || key === 'k') cursor = Math.max(0, cursor - 1);
      else if (key === 'down' || key === 'j') cursor = rows.length ? Math.min(rows.length - 1, cursor + 1) : 0;
      else if (key === 'left' || key === 'h') cursor = Math.max(0, cursor - pageSize);
      else if (key === 'right' || key === 'l') cursor = rows.length ? Math.min(rows.length - 1, cursor + pageSize) : 0;
      else if (key === 'f') {
        filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length];
        cursor = 0;
        showReason = false;
      } else if (key === 's') {
        sort = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
      } else if (key === 'c') {
        const list = chapters();
        if (!list.length) status = '没有章节可筛';
        else {
          const index = list.indexOf(chapter);
          chapter = index < 0 || index === list.length - 1 ? (index < 0 ? list[0] : '') : list[index + 1];
          cursor = 0;
        }
      } else if (key === 'v') {
        showReason = !showReason;
      } else if (key === 'escape' || key === 'ctrl+c') {
        finish(undefined);
        return;
      } else if (!current) {
        status = '这个筛选下没有题';
      } else if (key === 'm') {
        try {
          config.onMaster(exerIdOf(current));
          current.mastered = true;
          status = '已标为掌握';
        } catch {
          status = '标掌握失败';
        }
      } else if (key === 'r') {
        if (!current.removed && !current.mastered) status = '这题还在待复习';
        else {
          try {
            config.onRestore(exerIdOf(current));
            current.removed = false;
            current.mastered = false;
            current.streak = 0;
            status = '已恢复到待复习';
          } catch {
            status = '恢复失败';
          }
        }
      } else if (key === 'x') {
        if (current.removed) status = '已经移出';
        else {
          try {
            config.onRemove(exerIdOf(current));
            current.removed = true;
            status = '已移出待攻克';
          } catch {
            status = '移出失败';
          }
        }
      } else if (key === 'enter' || key === 'g') {
        if (current.removed) {
          status = '先按 R 恢复';
        } else if (key === 'g') {
          finish({ items: [freshCopy(current.item)], index: 0, again: true });
          return;
        } else {
          const items = rows.filter((row) => !row.removed).map((row) => row.item);
          const index = items.indexOf(current.item);
          finish({ items, index: Math.max(0, index), again: false });
          return;
        }
      } else return;
      tui.requestRender();
    },
    invalidate: () => undefined,
  };
}

export function openWrongBook(ui: WrongBookUI, config: WrongBookListConfig): Promise<WrongBookResult> {
  return ui.custom<WrongBookResult>((tui, theme, _keybindings, done) =>
    createWrongBookComponent(tui, theme, config, done)
  );
}
