import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { AuthTokenPayload, KaodesConfig } from '../types.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.pi');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'kaodes-token.json');

/**
 * 鉴权与凭证管理模块
 * 支持从环境变量、本地配置文件读取，支持 JWT 格式校验、过期检测与终端交互录入
 */
export class AuthManager {
  private configPath: string;
  private promptProvider?: (message: string) => Promise<string | undefined>;

  constructor(customConfigPath?: string) {
    this.configPath = customConfigPath || DEFAULT_CONFIG_PATH;
  }

  /**
   * 解析 JWT Token payload
   */
  public parseToken(token: string): AuthTokenPayload | null {
    try {
      const parts = token.trim().split('.');
      if (parts.length !== 3) return null;
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(jsonStr) as AuthTokenPayload;
    } catch {
      return null;
    }
  }

  /**
   * 检查 Token 是否有效（存在且未过期）
   */
  public isTokenValid(token: string): boolean {
    const payload = this.parseToken(token);
    if (!payload) return false;
    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      return payload.exp > now;
    }
    return true;
  }

  /**
   * 获取当前有效 Token
   * 优先级: 环境变量 KAODES_TOKEN -> 本地配置文件
   */
  public getToken(): string | null {
    const envToken = process.env.KAODES_TOKEN;
    if (envToken && this.isTokenValid(envToken)) {
      return envToken.trim();
    }

    const config = this.loadConfig();
    if (config?.token && this.isTokenValid(config.token)) {
      return config.token.trim();
    }

    return null;
  }

  /**
   * 读取本地配置
   */
  public loadConfig(): KaodesConfig | null {
    try {
      if (!fs.existsSync(this.configPath)) return null;
      const content = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(content) as KaodesConfig;
    } catch {
      return null;
    }
  }

  /**
   * 持久化配置到本地文件
   */
  public saveConfig(config: KaodesConfig): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = this.parseToken(config.token);
    const dataToSave: KaodesConfig = {
      ...config,
      userId: payload?.userId || config.userId,
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(this.configPath, JSON.stringify(dataToSave, null, 2), 'utf8');
  }

  /**
   * 从用户输入中提取 Token（兼容纯 Token 或浏览器 Cookie 字符串）
   */
  public extractToken(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // 如果是完整的 cookie 字符串，如 "token=eyJ...; user=..."
    if (trimmed.includes('token=')) {
      const match = trimmed.match(/(?:^|;\s*)token=([^;]+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    // 如果本身是 Bearer 格式
    if (trimmed.startsWith('Bearer ')) {
      return trimmed.slice(7).trim();
    }

    // 默认直接作为 Token 处理
    return trimmed;
  }

  /**
   * 保存用户输入的 Token 或 Cookie，并返回实际保存的 Token
   */
  public saveTokenInput(input: string): string {
    const extracted = this.extractToken(input);
    const token = extracted || input.trim();
    this.saveConfig({ token });
    return token;
  }

  public setPromptProvider(provider?: (message: string) => Promise<string | undefined>): void {
    this.promptProvider = provider;
  }

  /**
   * 交互式提示用户输入 Token（独立 CLI 模式使用）
   */
  public async promptForToken(promptMessage?: string): Promise<string> {
    const msg =
      promptMessage ||
      '\n[Kaodes] 请输入 kaodes.com 的 Token 或完整 Cookie (输入后回车):\n' +
      '  获取方式：浏览器登录 kaodes.com → F12 打开开发者工具 → Network 任一接口\n' +
      '  → 复制请求头里的 token（或整段 Cookie）粘贴到这里即可。\n';

    if (this.promptProvider) {
      const rawInput = await this.promptProvider(msg);
      if (rawInput === undefined) throw new Error('Kaodes Token 输入已取消');
      const token = this.extractToken(rawInput) || rawInput.trim();
      if (!token) throw new Error('Kaodes Token 不能为空');
      this.saveConfig({ token });
      return token;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(msg, (rawInput) => {
        rl.close();
        const extracted = this.extractToken(rawInput);
        if (extracted && this.isTokenValid(extracted)) {
          this.saveConfig({ token: extracted });
          resolve(extracted);
        } else {
          // 如果解析失败但用户确实输入了内容，仍先保存尝试
          const fallback = rawInput.trim();
          this.saveConfig({ token: fallback });
          resolve(fallback);
        }
      });
    });
  }

  /**
   * 确保获得一个可用 Token，若缺失或过期则触发交互输入
   */
  public async ensureValidToken(): Promise<string> {
    const existing = this.getToken();
    if (existing) return existing;

    console.warn('\n[Kaodes 认证提示] 未检测到有效的登录凭证或 Token 已过期。');
    return this.promptForToken();
  }
}
