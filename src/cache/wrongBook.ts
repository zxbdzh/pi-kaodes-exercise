import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 连续做对这么多次就可以标掌握。要更严，改这个数。 */
export const MASTER_STREAK = 2;

export interface WrongMeta {
  exerId: number;
  chapter: string;
  wrongCount: number;
  streak: number;
  mastered: boolean;
  lastWrongAt: number;
  priority: number;
  reason: string;
}

export type WrongFilter = 'all' | 'pending' | 'mastered' | 'removed';
export type WrongSort = 'priority' | 'recent' | 'count' | 'chapter';

export interface WrongSortable {
  title: string;
  chapter: string;
  wrongCount: number;
  mastered: boolean;
  removed: boolean;
  lastWrongAt: number;
  priority: number;
}

const EMPTY_REASON = '还没有本地错因。做一遍后会记下误选，并只提示概念界限。';

function cleanChapter(value?: string | null): string {
  const text = String(value || '').trim();
  if (!text || text.startsWith('错题本')) return '未分章';
  return text;
}

/** 章节优先用题目自带字段，否则用练习章节名。错题本会话名不算章节。 */
export function chapterOf(
  item: { source?: string | null; chapterName?: string; moduleName?: string; catName?: string },
  fallback?: string
): string {
  return cleanChapter(item.chapterName || item.moduleName || item.catName || item.source || fallback);
}

/** 错因只记误选和概念界限，不写正确选项。 */
export function wrongReason(userKey?: string | null): string {
  const picked = String(userKey || '').trim();
  if (!picked) return '还没记下误选。先分清题干限定的是哪一层概念，再比较相邻选项差在范围还是条件。';
  return `上次误选 ${picked}。先分清题干限定的概念范围，再看相邻选项差在哪一层，不要靠字母记答案。`;
}

export function wrongStats(rows: Array<{ mastered: boolean; removed: boolean }>): {
  total: number;
  pending: number;
  mastered: number;
} {
  return {
    total: rows.length,
    pending: rows.filter((row) => !row.mastered && !row.removed).length,
    mastered: rows.filter((row) => row.mastered).length,
  };
}

export function queryWrong<T extends WrongSortable>(
  rows: T[],
  opts: { filter: WrongFilter; sort: WrongSort; chapter: string }
): T[] {
  const chapter = opts.chapter.trim();
  const filtered = rows.filter((row) => {
    if (chapter && row.chapter !== chapter) return false;
    if (opts.filter === 'pending') return !row.mastered && !row.removed;
    if (opts.filter === 'mastered') return row.mastered;
    if (opts.filter === 'removed') return row.removed;
    return true;
  });
  const copy = [...filtered];
  copy.sort((a, b) => {
    if (opts.sort === 'recent') return b.lastWrongAt - a.lastWrongAt || b.wrongCount - a.wrongCount;
    if (opts.sort === 'count') return b.wrongCount - a.wrongCount || b.lastWrongAt - a.lastWrongAt;
    if (opts.sort === 'chapter') return a.chapter.localeCompare(b.chapter, 'zh') || b.priority - a.priority;
    return b.priority - a.priority || b.lastWrongAt - a.lastWrongAt;
  });
  return copy;
}

/**
 * 错题本本地账：次数、连续做对、掌握、错因。
 * 移出名单仍在 WrongRemovedStore，避免和「不再出现」搅在一起。
 */
export class WrongBookStore {
  private filePath: string;
  private byCourse: Map<string, Map<number, WrongMeta>>;

  constructor(customPath?: string) {
    this.filePath = customPath || path.join(os.homedir(), '.pi', 'kaodes-wrong-book.json');
    this.byCourse = this.load();
  }

  private load(): Map<string, Map<number, WrongMeta>> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, Record<string, WrongMeta>>;
      const map = new Map<string, Map<number, WrongMeta>>();
      for (const [courseId, rows] of Object.entries(raw || {})) {
        const bucket = new Map<number, WrongMeta>();
        for (const [id, meta] of Object.entries(rows || {})) {
          const exerId = Number(meta?.exerId || id);
          if (!exerId) continue;
          bucket.set(exerId, {
            exerId,
            chapter: cleanChapter(meta.chapter),
            wrongCount: Math.max(0, Number(meta.wrongCount) || 0),
            streak: Math.max(0, Number(meta.streak) || 0),
            mastered: !!meta.mastered,
            lastWrongAt: Math.max(0, Number(meta.lastWrongAt) || 0),
            priority: Math.max(0, Number(meta.priority) || 0),
            reason: meta.reason || EMPTY_REASON,
          });
        }
        if (bucket.size) map.set(courseId, bucket);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private save(): void {
    const raw: Record<string, Record<string, WrongMeta>> = {};
    for (const [courseId, bucket] of this.byCourse) {
      raw[courseId] = {};
      for (const [exerId, meta] of bucket) raw[courseId][String(exerId)] = meta;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(raw), 'utf8');
  }

  private bucket(courseId: string): Map<number, WrongMeta> {
    const found = this.byCourse.get(courseId);
    if (found) return found;
    const created = new Map<number, WrongMeta>();
    this.byCourse.set(courseId, created);
    return created;
  }

  private must(courseId: string, exerId: number, chapter: string | undefined, seed: boolean): WrongMeta {
    const bucket = this.bucket(courseId);
    let meta = bucket.get(exerId);
    if (!meta) {
      meta = {
        exerId,
        chapter: cleanChapter(chapter),
        wrongCount: seed ? 1 : 0,
        streak: 0,
        mastered: false,
        lastWrongAt: 0,
        priority: seed ? 1 : 0,
        reason: EMPTY_REASON,
      };
      bucket.set(exerId, meta);
    } else {
      const next = cleanChapter(chapter);
      if (next !== '未分章' && meta.chapter === '未分章') meta.chapter = next;
    }
    return meta;
  }

  public get(courseId: string, exerId: number): WrongMeta | undefined {
    const meta = this.byCourse.get(courseId)?.get(exerId);
    return meta ? { ...meta } : undefined;
  }

  /** 云端错题第一次进列表时记账，不把打开次数算成再错一次。 */
  public ensure(courseId: string, exerId: number, chapter?: string): WrongMeta {
    if (!courseId || !exerId) {
      return { exerId, chapter: '未分章', wrongCount: 0, streak: 0, mastered: false, lastWrongAt: 0, priority: 0, reason: EMPTY_REASON };
    }
    const meta = this.must(courseId, exerId, chapter, true);
    this.save();
    return { ...meta };
  }

  /** 做错：连续正确清零，次数和优先级一起升，掌握作废。 ponytail: 优先级=错误次数，要衰减再加时间权重。 */
  public noteWrong(courseId: string, exerId: number, chapter: string | undefined, userKey?: string | null): WrongMeta {
    const meta = this.must(courseId, exerId, chapter, false);
    meta.wrongCount += 1;
    meta.streak = 0;
    meta.mastered = false;
    meta.lastWrongAt = Date.now();
    meta.priority = meta.wrongCount;
    meta.reason = wrongReason(userKey);
    this.save();
    return { ...meta };
  }

  public noteCorrect(courseId: string, exerId: number): WrongMeta {
    const meta = this.must(courseId, exerId, undefined, true);
    meta.streak += 1;
    this.save();
    return { ...meta };
  }

  public markMastered(courseId: string, exerId: number): WrongMeta {
    const meta = this.must(courseId, exerId, undefined, true);
    meta.mastered = true;
    this.save();
    return { ...meta };
  }

  /** 恢复到待复习：取消掌握并清掉连续正确。移出名单由调用方单独恢复。 */
  public restore(courseId: string, exerId: number): void {
    const meta = this.byCourse.get(courseId)?.get(exerId);
    if (!meta) return;
    meta.mastered = false;
    meta.streak = 0;
    this.save();
  }
}
