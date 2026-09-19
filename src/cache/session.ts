import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PracticeSession } from '../types.js';

const CACHE_DIR = path.join(os.homedir(), '.pi', 'kaodes-cache');

/**
 * 本地题目离线缓存与做题断点引擎
 */
export class SessionCache {
  private cacheDir: string;

  constructor(customCacheDir?: string) {
    this.cacheDir = customCacheDir || CACHE_DIR;
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getSessionPath(courseId: string, catId: string): string {
    return path.join(this.cacheDir, `session_${courseId}_${catId}.json`);
  }

  /**
   * 保存本地断点进度
   */
  public saveSession(session: PracticeSession): void {
    const filePath = this.getSessionPath(session.courseId, session.catId || 'default');
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  }

  /**
   * 读取本地断点进度
   */
  public loadSession(courseId: string, catId: string): PracticeSession | null {
    try {
      const filePath = this.getSessionPath(courseId, catId);
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content) as PracticeSession;
    } catch {
      return null;
    }
  }

  /**
   * 清理已完成的练习缓存
   */
  public clearSession(courseId: string, catId: string): void {
    try {
      const filePath = this.getSessionPath(courseId, catId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}
