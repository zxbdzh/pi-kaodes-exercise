import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 一张闪卡：答错后经用户确认 + AI 生成入集。 */
export interface Flashcard {
  /** 关联题目 id（同一题重复入卡时按此累加错误次数） */
  exerId: number;
  question: string;
  keyPoints: string;
  /** 该题累计答错次数（重复入卡 +1） */
  wrongCount: number;
  /** 最近几次答错时间戳（毫秒），供错误趋势分析 */
  wrongTimes: number[];
  createdAt: number;
  /** 最近一次抽卡复习时间戳；从未复习为 undefined（优先出） */
  lastReviewedAt?: number;
  /** 累计复习次数 */
  reviewCount: number;
  courseId?: string;
  chapterName?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 抽卡优先级：错得多优先、久未复习优先、从未复习的卡最优先。
 * 简单加权即可；若将来要真正的间隔重复（SRS），替换此函数。
 */
export function cardPriority(card: Flashcard, now: number): number {
  // 从未复习视为「很久没看」（30 天），保证新卡最先出现
  const daysSince = card.lastReviewedAt ? (now - card.lastReviewedAt) / DAY_MS : 30;
  return card.wrongCount * 2 + daysSince;
}

/** 闪卡持久化存储：~/.pi/kaodes-flashcards.json（可注入路径供测试）。 */
export class FlashcardStore {
  private filePath: string;
  private cards: Flashcard[];

  constructor(customPath?: string) {
    this.filePath = customPath || path.join(os.homedir(), '.pi', 'kaodes-flashcards.json');
    this.cards = this.load();
  }

  private load(): Flashcard[] {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Flashcard[];
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cards, null, 2), 'utf8');
  }

  public all(): Flashcard[] {
    return [...this.cards];
  }

  public size(): number {
    return this.cards.length;
  }

  /** 找同题已有卡 */
  public findByExerId(exerId: number): Flashcard | undefined {
    return this.cards.find((c) => c.exerId === exerId);
  }

  /**
   * 入卡：同题已存在则累加错误次数并更新内容，否则新建。
   * wrongTime 为本次答错时间戳。
   */
  public upsert(card: Omit<Flashcard, 'wrongCount' | 'wrongTimes' | 'createdAt' | 'reviewCount'>, wrongTime: number): Flashcard {
    const existing = this.findByExerId(card.exerId);
    if (existing) {
      existing.question = card.question;
      existing.keyPoints = card.keyPoints;
      existing.wrongCount += 1;
      existing.wrongTimes.push(wrongTime);
      existing.courseId = card.courseId ?? existing.courseId;
      existing.chapterName = card.chapterName ?? existing.chapterName;
      this.save();
      return existing;
    }
    const fresh: Flashcard = {
      ...card,
      wrongCount: 1,
      wrongTimes: [wrongTime],
      createdAt: wrongTime,
      reviewCount: 0,
    };
    this.cards.push(fresh);
    this.save();
    return fresh;
  }

  /** 抽卡：按优先级降序取前 n 张。 */
  public draw(n: number, now = Date.now()): Flashcard[] {
    return [...this.cards]
      .sort((a, b) => cardPriority(b, now) - cardPriority(a, now))
      .slice(0, Math.max(0, n));
  }

  /** 复习完成：记一次复习时间。 */
  public markReviewed(exerId: number, now = Date.now()): void {
    const card = this.findByExerId(exerId);
    if (!card) return;
    card.lastReviewedAt = now;
    card.reviewCount += 1;
    this.save();
  }
}
