import { ExerciseItem } from '../types.js';

export interface AiTutorOptions {
  /**
   * LLM 生成函数。由宿主注入（Pi 环境下接 modelRegistry.complete，
   * 自动使用当前会话模型与鉴权）；未注入时全部走离线模板降级。
   */
  generateResponse?: (prompt: string) => Promise<string>;
}

/** 闪卡数据：正面问题 / 背面要点 */
export interface Flashcard {
  question: string;
  keyPoints: string;
  /** 是否由 LLM 生成（false 为离线模板降级） */
  generated: boolean;
}

/**
 * AI 伴学导师与反问闪卡引擎。
 * - [T] 思路点拨：不剧透答案，错因剖析 / 考点提炼
 * - [F] 反问闪卡：LLM 针对当前题生成变式反问，正面提问 → 翻面对照要点与点评
 */
export class AiTutorEngine {
  private customGenerate?: (prompt: string) => Promise<string>;

  constructor(options?: AiTutorOptions) {
    this.customGenerate = options?.generateResponse;
  }

  /** 是否具备真实 LLM 能力 */
  public get hasLLM(): boolean {
    return !!this.customGenerate;
  }

  /**
   * 生成思路点拨 Prompt（防剧透模式）
   */
  public buildHintPrompt(exer: ExerciseItem): string {
    const isWrong = exer.doResult === -1;
    let context = `【题目】${exer.title}\n`;
    if (exer.a) context += `A. ${exer.a}\n`;
    if (exer.b) context += `B. ${exer.b}\n`;
    if (exer.c) context += `C. ${exer.c}\n`;
    if (exer.d) context += `D. ${exer.d}\n`;

    if (isWrong) {
      context += `\n【用户作答】用户选择了: ${exer.userKey || '未知'}`;
    }

    return `你是一位温和、专业的备考伴学导师。请基于以下题目为学员进行辅导：
${context}

【要求】
1. 绝对不要直接说出正确选项（如"正确答案选C"）；
2. ${
      isWrong
        ? '分析用户所选选项的常见混淆原因，指出概念之间的关键差异，启发用户重新审视。'
        : '提取核心考点与关键词，引导学员理清解题思路与排除法的切入点。'
    }
3. 语言简练，重点突出，控制在 150 字以内。`;
  }

  /**
   * 生成反问闪卡 Prompt（苏格拉底式提问，要求结构化输出）
   */
  public buildFlashcardPrompt(exer: ExerciseItem): string {
    let context = `【题目】${exer.title}\n`;
    if (exer.a) context += `A. ${exer.a}\n`;
    if (exer.b) context += `B. ${exer.b}\n`;
    if (exer.c) context += `C. ${exer.c}\n`;
    if (exer.d) context += `D. ${exer.d}\n`;

    return `你是一位擅长苏格拉底式教学的备考伴学导师。针对下面这道题考察的核心知识点，设计一张"反问闪卡"：
${context}
【参考解析】${exer.analyze || '无'}

【要求】
1. 问题必须针对本题的具体知识点，换个角度变式提问（不要复述题干），检验学员是否真正理解；
2. 问题要具体、可简短作答，避免空泛；
3. 严格按以下格式输出，不要输出其他内容：
【问题】<反问内容，一句话>
【要点】<翻面后展示的参考要点，1-3 句话，可含正确方向但不直接抄解析>`;
  }

  /**
   * 生成入集闪卡 Prompt：答错确认后调用。
   * 结合本题累计错误次数与本 session 内其他错题（相似题线索），
   * 生成可直接入闪卡集的问答对；输出格式与反问卡一致（【问题】【要点】）。
   */
  public buildCardPrompt(exer: ExerciseItem, wrongCount: number, siblingTitles: string[]): string {
    let context = `【题目】${exer.title}\n`;
    if (exer.a) context += `A. ${exer.a}\n`;
    if (exer.b) context += `B. ${exer.b}\n`;
    if (exer.c) context += `C. ${exer.c}\n`;
    if (exer.d) context += `D. ${exer.d}\n`;

    const siblings = siblingTitles.length
      ? `【本组其他错题】${siblingTitles.slice(0, 3).join('；')}\n（若与本题考点相关，可在要点中一并对比说明）\n`
      : '';

    return `你是备考伴学导师。学员在下面这道题上已答错 ${wrongCount} 次，请把它的核心考点做成一张闪卡加入复习集：
${context}${siblings}
【参考解析】${exer.analyze || '无'}

【要求】
1. 问题直击本题考点，若错误次数多（≥2 次）则覆盖易错辨析；
2. 严格按以下格式输出，不要输出其他内容：
【问题】<一句话反问>
【要点】<1-3 句要点，可含正确方向但不直接抄解析>`;
  }

  /**
   * 生成简答点评 Prompt
   */
  public buildReviewPrompt(exer: ExerciseItem, question: string, userAnswer: string, keyPoints: string): string {
    return `你是备考伴学导师。学员刚回答了闪卡反问，请给出简短点评：
【题目】${exer.title}
【闪卡问题】${question}
【参考要点】${keyPoints}
【学员简答】${userAnswer || '（未作答，仅思考）'}

【要求】
1. 先判断学员回答是否抓住了核心（对/部分对/未抓住）；
2. 指出遗漏或偏差，补充关键点，控制在 100 字以内；
3. 语气鼓励、具体，不要空泛表扬。直接输出点评内容。`;
  }

  /** 调用注入的 LLM；失败时抛出由调用方降级 */
  public async generate(prompt: string): Promise<string> {
    if (!this.customGenerate) throw new Error('LLM 未接入');
    return this.customGenerate(prompt);
  }

  /**
   * 生成闪卡：LLM 优先，失败或未接入时降级为离线模板。
   */
  public async makeFlashcard(exer: ExerciseItem): Promise<Flashcard> {
    if (this.customGenerate) {
      try {
        const raw = await this.customGenerate(this.buildFlashcardPrompt(exer));
        const qMatch = raw.match(/【问题】\s*([\s\S]*?)(?:【要点】|$)/);
        const kMatch = raw.match(/【要点】\s*([\s\S]*?)$/);
        if (qMatch && qMatch[1].trim()) {
          return {
            question: qMatch[1].trim(),
            keyPoints: kMatch?.[1]?.trim() || exer.analyze?.slice(0, 120) || '',
            generated: true,
          };
        }
      } catch {
        // 落入离线降级
      }
    }
    return this.fallbackFlashcard(exer);
  }

  /**
   * 离线降级闪卡（无 LLM 时）
   */
  public fallbackFlashcard(exer: ExerciseItem): Flashcard {
    return {
      question:
        '针对这道题考察的知识点：如果把题干中的条件换成同级并列概念，最容易混淆的干扰项是什么？核心分界点在哪里？',
      keyPoints: exer.analyze ? exer.analyze.slice(0, 150) : '思考其与相邻概念的本质区别。',
      generated: false,
    };
  }

  /**
   * 点评学员简答：LLM 优先，失败时降级为要点回顾。
   */
  public async reviewAnswer(
    exer: ExerciseItem,
    question: string,
    userAnswer: string,
    keyPoints: string
  ): Promise<string> {
    if (this.customGenerate) {
      try {
        return await this.customGenerate(this.buildReviewPrompt(exer, question, userAnswer, keyPoints));
      } catch {
        // 落入离线降级
      }
    }
    return `已记录你的回答。参考要点：${keyPoints}`;
  }

  /**
   * 思路点拨：LLM 优先，失败时降级。
   */
  public async hint(exer: ExerciseItem): Promise<string> {
    if (this.customGenerate) {
      try {
        return await this.customGenerate(this.buildHintPrompt(exer));
      } catch {
        // 落入离线降级
      }
    }
    return this.generateFallbackHint(exer);
  }

  /**
   * 默认离线点拨规则生成器（当无外部 LLM 时也能即时提供启发）
   */
  public generateFallbackHint(exer: ExerciseItem): string {
    if (exer.analyze) {
      const sanitized = exer.analyze
        .replace(/^[A-Za-z0-9\s、，]+[选项正确]+/g, '')
        .slice(0, 160);
      return `【AI 核心思路点拨】\n本题聚焦核心考点，请注意题干中的限定词与关联范畴。\n启发线索: "${sanitized}..."，思考其与各选项的精确对应。`;
    }
    return '【AI 核心思路点拨】请特别留意题干中的核心关键词与修饰主语，利用排除法先筛掉概念明显扩缩的选项。';
  }

  /**
   * 兼容保留：旧接口直接生成闪卡问题文本。
   */
  public async interact(exer: ExerciseItem, mode: 'hint' | 'flashcard'): Promise<void> {
    const text = mode === 'hint' ? await this.hint(exer) : (await this.makeFlashcard(exer)).question;
    console.log(text);
  }
}
