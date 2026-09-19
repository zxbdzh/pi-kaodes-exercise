import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PREFS_PATH = path.join(os.homedir(), '.pi', 'kaodes-prefs.json');

/** 可持久化的用户偏好。缺省值即“开箱即用”的默认体验。 */
export interface KaodesPreferences {
  /** 规则高亮开关（题眼黄 / 否定红 / 结论绿 / 选项前缀弱化）。 */
  highlightEnabled: boolean;
  /** 分页选择器每页条数。 */
  pageSize: number;
}

const DEFAULTS: KaodesPreferences = {
  highlightEnabled: true,
  pageSize: 15,
};

/**
 * 用户偏好持久化：读写 ~/.pi/kaodes-prefs.json。
 * 设计原则：任何 IO/解析异常都不得影响刷题主流程，一律回落到默认值。
 */
export class Preferences {
  private filePath: string;
  private data: KaodesPreferences;

  constructor(customPath?: string) {
    this.filePath = customPath || DEFAULT_PREFS_PATH;
    this.data = { ...DEFAULTS, ...this.read() };
  }

  private read(): Partial<KaodesPreferences> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<KaodesPreferences>;
      const out: Partial<KaodesPreferences> = {};
      if (typeof parsed.highlightEnabled === 'boolean') out.highlightEnabled = parsed.highlightEnabled;
      if (typeof parsed.pageSize === 'number' && parsed.pageSize >= 3 && parsed.pageSize <= 50) {
        out.pageSize = Math.floor(parsed.pageSize);
      }
      return out;
    } catch {
      return {};
    }
  }

  private write(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // 偏好写入失败不应打断刷题
    }
  }

  public get highlightEnabled(): boolean {
    return this.data.highlightEnabled;
  }

  public get pageSize(): number {
    return this.data.pageSize;
  }

  public setHighlightEnabled(value: boolean): void {
    this.data.highlightEnabled = value;
    this.write();
  }

  public setPageSize(value: number): void {
    const clamped = Math.min(50, Math.max(3, Math.floor(value)));
    this.data.pageSize = clamped;
    this.write();
  }

  /** 返回当前偏好快照（只读用途，如 :prefs 展示）。 */
  public snapshot(): KaodesPreferences {
    return { ...this.data };
  }
}
