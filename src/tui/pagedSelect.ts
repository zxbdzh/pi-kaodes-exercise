import { parseKeyName } from './keys.js';
import { PiExerciseComponent, visibleWidth, truncateToWidth } from './exercise.js';

/** 分页选择器配置：题目 → 课程 → 章节等长列表选择共用。 */
export interface PagedSelectConfig<T> {
  title: string;
  items: T[];
  format: (item: T) => string;
  /** 每页条数，默认 15 */
  pageSize?: number;
  /** 初始光标（绝对索引） */
  initialIndex?: number;
  /** 允许 Backspace 返回上一级选择（done 收到 PAGED_SELECT_BACK） */
  backEnabled?: boolean;
}

/** Backspace 逐级返回的哨兵值（与取消 undefined、选中 T 区分）。 */
export const PAGED_SELECT_BACK = Symbol('kaodes-paged-select-back');
export type PagedSelectPick<T> = T | typeof PAGED_SELECT_BACK | undefined;

/** 仅依赖 Pi 的 ui.custom 通道。 */
export interface PagedSelectUI {
  custom<T>(
    factory: (
      tui: { requestRender(): void },
      theme: unknown,
      keybindings: unknown,
      done: (value: T) => void
    ) => PiExerciseComponent
  ): Promise<T>;
}

const RESET = '\x1b[0m';
const FALLBACK_COLORS: Record<string, string> = {
  dim: '\x1b[2m',
  muted: '\x1b[2m',
  accent: '\x1b[36m',
};

function makePainter(theme: unknown): (color: string, text: string) => string {
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

/** 超宽以 … 截断（与答题页底栏同规则）。 */
function ellipsis(value: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return '…';
  return truncateToWidth(value, width - 1) + '…';
}

/**
 * 分页选择组件工厂（供 ui.custom 使用）：
 * ↑↓ / J K 移动光标（跨页连续），←→ / H L / PgUp PgDn 翻页，
 * Enter 确认，Esc / Ctrl+C 取消（done(undefined)）。
 */
export function createPagedSelectComponent<T>(
  tui: { requestRender(): void },
  theme: unknown,
  config: PagedSelectConfig<T>,
  done: (value: PagedSelectPick<T>) => void
): PiExerciseComponent {
  const paint = makePainter(theme);
  const pageSize = Math.max(1, config.pageSize ?? 15);
  const total = config.items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  let cursor = Math.max(0, Math.min(total - 1, config.initialIndex ?? 0));
  let settled = false;

  const finish = (value: PagedSelectPick<T>): void => {
    if (settled) return;
    settled = true;
    done(value);
  };

  const movePage = (delta: number): void => {
    const page = Math.floor(cursor / pageSize);
    const target = Math.max(0, Math.min(pageCount - 1, page + delta));
    if (target === page) return;
    const start = target * pageSize;
    const len = Math.min(pageSize, total - start);
    cursor = start + Math.min(cursor - page * pageSize, len - 1);
  };

  return {
    render: (width: number) => {
      const page = Math.min(pageCount - 1, Math.floor(cursor / pageSize));
      const start = page * pageSize;
      const end = Math.min(total, start + pageSize);
      const lines: string[] = [];
      const pageHint = pageCount > 1 ? `  (第 ${page + 1}/${pageCount} 页)` : '';
      lines.push(paint('accent', ellipsis(`${config.title}${pageHint}`, width)));
      lines.push('');
      for (let i = start; i < end; i++) {
        const label = `${i + 1}. ${config.format(config.items[i]!)}`;
        lines.push(
          i === cursor ? paint('accent', ellipsis(`→ ${label}`, width)) : ellipsis(`  ${label}`, width)
        );
      }
      lines.push('');
      const hint = config.backEnabled
        ? '↑↓ 移动 · ←→ 翻页 · Enter 选择 · ⌫ 返回上级 · Esc 取消'
        : '↑↓ 移动 · ←→ 翻页 · Enter 选择 · Esc 取消';
      lines.push(paint('dim', ellipsis(hint, width)));
      return lines;
    },
    handleInput: (data: string) => {
      const key = parseKeyName(data);
      if (key === 'up' || key === 'k') cursor = Math.max(0, cursor - 1);
      else if (key === 'down' || key === 'j') cursor = Math.min(total - 1, cursor + 1);
      else if (key === 'left' || key === 'h' || key === 'pageup') movePage(-1);
      else if (key === 'right' || key === 'l' || key === 'pagedown') movePage(1);
      else if (key === 'backspace') {
        if (!config.backEnabled) return;
        finish(PAGED_SELECT_BACK);
        return;
      } else if (key === 'enter') {
        finish(config.items[cursor]);
        return;
      } else if (key === 'escape' || key === 'ctrl+c') {
        finish(undefined);
        return;
      } else return;
      tui.requestRender();
    },
    invalidate: () => undefined,
  };
}

/** 通过 ui.custom 打开分页选择器；取消 resolve undefined，⌫ resolve PAGED_SELECT_BACK。 */
export function pagedSelect<T>(ui: PagedSelectUI, config: PagedSelectConfig<T>): Promise<PagedSelectPick<T>> {
  return ui.custom<PagedSelectPick<T>>((tui, theme, _keybindings, done) =>
    createPagedSelectComponent(tui, theme, config, done)
  );
}
