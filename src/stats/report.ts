import { PracticeSession } from '../types.js';

export interface StatsTotals {
  chapters: number;
  exercises: number;
  answered: number;
  correct: number;
  wrong: number;
  accuracy: number; // 0-1，answered 为 0 时取 0
}

/** 判断一道题是否已作答（客观题选了答案，或主观题标记过结果）。 */
function isAnswered(ex: { userKey?: string | null; doResult?: number }): boolean {
  return Boolean(ex.userKey) || ex.doResult === 1 || ex.doResult === -1;
}

/** 汇总全部本地断点会话的总体统计。 */
export function computeTotals(sessions: PracticeSession[]): StatsTotals {
  let exercises = 0;
  let answered = 0;
  let correct = 0;
  let wrong = 0;
  for (const s of sessions) {
    for (const ex of s.exercises) {
      exercises++;
      if (ex.doResult === 1) {
        correct++;
        answered++;
      } else if (ex.doResult === -1) {
        wrong++;
        answered++;
      } else if (isAnswered(ex)) {
        answered++;
      }
    }
  }
  return {
    chapters: sessions.length,
    exercises,
    answered,
    correct,
    wrong,
    accuracy: answered > 0 ? correct / answered : 0,
  };
}

export interface CourseStat {
  courseName: string;
  answered: number;
  correct: number;
  total: number;
  accuracy: number;
}

/** 按科目聚合，返回按已作答题数降序的列表。 */
export function computeByCourse(sessions: PracticeSession[]): CourseStat[] {
  const map = new Map<string, CourseStat>();
  for (const s of sessions) {
    const key = s.courseName || '未命名科目';
    let entry = map.get(key);
    if (!entry) {
      entry = { courseName: key, answered: 0, correct: 0, total: 0, accuracy: 0 };
      map.set(key, entry);
    }
    for (const ex of s.exercises) {
      entry.total++;
      if (ex.doResult === 1) {
        entry.correct++;
        entry.answered++;
      } else if (ex.doResult === -1) {
        entry.answered++;
      } else if (isAnswered(ex)) {
        entry.answered++;
      }
    }
  }
  const list = [...map.values()];
  for (const e of list) e.accuracy = e.answered > 0 ? e.correct / e.answered : 0;
  list.sort((a, b) => b.answered - a.answered || a.courseName.localeCompare(b.courseName));
  return list;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** 生成 20 字符宽的文本进度条。 */
function bar(ratio: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * 渲染学习统计看板（纯文本，供 ui.notify 或 console 输出）。
 * 无任何本地断点时返回引导语，避免空面板。
 */
export function buildStatsReport(sessions: PracticeSession[]): string {
  if (!sessions.length) {
    return [
      '📊 学习统计',
      '',
      '还没有本地练习记录。',
      '先执行 /kaodes 开始一次章节练习，做完的题目会自动进入统计。',
    ].join('\n');
  }

  const t = computeTotals(sessions);
  const lines: string[] = [];
  lines.push('📊 学习统计（基于本地断点缓存）');
  lines.push('');
  lines.push(`覆盖章节   ${t.chapters} 个`);
  lines.push(`题目总量   ${t.exercises} 道 · 已作答 ${t.answered} 道`);
  lines.push(`正确 / 错误  ${t.correct} ✔ / ${t.wrong} ✘`);
  lines.push(`正确率     ${pct(t.accuracy)}  ${bar(t.accuracy)}`);

  const byCourse = computeByCourse(sessions).slice(0, 8);
  if (byCourse.length) {
    lines.push('');
    lines.push('按科目：');
    for (const c of byCourse) {
      const name = c.courseName.length > 12 ? `${c.courseName.slice(0, 11)}…` : c.courseName;
      lines.push(`  ${name.padEnd(12, ' ')} ${String(c.answered).padStart(3)}/${String(c.total).padEnd(3)} · ${pct(c.accuracy)}`);
    }
  }

  lines.push('');
  lines.push('提示：统计只汇总本机缓存的断点数据，交卷或清理断点后对应记录会移除。');
  return lines.join('\n');
}
