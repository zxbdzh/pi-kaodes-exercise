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

  /**
   * 列出全部本地断点会话（用于学习统计看板）。
   * 解析失败的文件会被跳过，绝不抛出。
   */
  public listSessions(): PracticeSession[] {
    try {
      if (!fs.existsSync(this.cacheDir)) return [];
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.startsWith('session_') && f.endsWith('.json'));
      const sessions: PracticeSession[] = [];
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.cacheDir, file), 'utf8');
          const parsed = JSON.parse(content) as PracticeSession;
          if (parsed && Array.isArray(parsed.exercises)) sessions.push(parsed);
        } catch {
          // 单个坏文件不影响整体统计
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }
}
