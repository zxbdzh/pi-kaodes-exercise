import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function exerIdOf(item: { exerId?: number; exerID?: number }): number {
  return Number(item.exerId || item.exerID || 0);
}

/** 本机「已移出错题本」名单。不调云端 removeWrong（type=0/2 会清空整本）。 */
export class WrongRemovedStore {
  private filePath: string;
  private byCourse: Map<string, Set<number>>;

  constructor(customPath?: string) {
    this.filePath = customPath || path.join(os.homedir(), '.pi', 'kaodes-wrong-removed.json');
    this.byCourse = this.load();
  }

  private load(): Map<string, Set<number>> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, number[]>;
      const map = new Map<string, Set<number>>();
      for (const [courseId, ids] of Object.entries(raw || {})) {
        map.set(courseId, new Set((ids || []).map(Number).filter((id) => id > 0)));
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private save(): void {
    const raw: Record<string, number[]> = {};
    for (const [courseId, ids] of this.byCourse) raw[courseId] = [...ids];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(raw), 'utf8');
  }

  public has(courseId: string, exerId: number): boolean {
    return this.byCourse.get(courseId)?.has(exerId) ?? false;
  }

  public add(courseId: string, exerId: number): void {
    if (!courseId || !exerId) return;
    const set = this.byCourse.get(courseId) ?? new Set<number>();
    set.add(exerId);
    this.byCourse.set(courseId, set);
    this.save();
  }

  /** 从本机移出名单拿回。不调云端 removeWrong。 */
  public restore(courseId: string, exerId: number): void {
    const set = this.byCourse.get(courseId);
    if (!set?.has(exerId)) return;
    set.delete(exerId);
    if (!set.size) this.byCourse.delete(courseId);
    this.save();
  }

  public filter<T extends { exerId?: number; exerID?: number }>(courseId: string, items: T[]): T[] {
    const ids = this.byCourse.get(courseId);
    if (!ids?.size) return items;
    return items.filter((item) => !ids.has(exerIdOf(item)));
  }
}
