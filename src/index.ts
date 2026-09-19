import { AuthManager } from './auth/manager.js';
import { KaodesClient } from './api/client.js';
import { SessionCache } from './cache/session.js';
import { ExerciseTUI, KAODES_HELP } from './tui/exercise.js';
import { pagedSelect } from './tui/pagedSelect.js';
import { AiTutorEngine } from './tutor/engine.js';
import { ChapterPracticeNode, PracticeSession } from './types.js';

export interface PiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface PiCommandUI {
  input(prompt: string, placeholder?: string): Promise<string | undefined>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
  custom<T>(
    factory: (
      tui: { requestRender(): void },
      theme: unknown,
      keybindings: unknown,
      done: (value: T) => void
    ) => PiComponent,
    options?: { overlay?: boolean }
  ): Promise<T>;
}

export interface PiCommandContext {
  ui: PiCommandUI;
  mode?: 'tui' | 'rpc' | 'json' | 'print';
  hasUI?: boolean;
  /** Pi 扩展上下文：用于调用当前会话 LLM（modelRegistry.complete 自动鉴权） */
  modelRegistry?: {
    complete(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
  };
  /** 当前会话模型（Pi ctx.model） */
  model?: unknown;
}

export interface PiExtensionContext {
  registerCommand?: (
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void> | void;
    }
  ) => void;
  /** Pi 原生扩展上下文（含 modelRegistry / model），由宿主注入 */
  modelRegistry?: PiCommandContext['modelRegistry'];
  model?: unknown;
  // 兼容旧的宿主测试接口；Pi 正式运行走 registerCommand。
  registerSlashCommand?: (name: string, handler: (args: string) => Promise<void> | void, description?: string) => void;
  registerTool?: (toolDef: unknown) => void;
  sendMessage?: (msg: string) => void;
}

/**
 * Pi 插件核心管理器
 */
export class KaodesExtension {
  public auth: AuthManager;
  public client: KaodesClient;
  public cache: SessionCache;
  public tutor: AiTutorEngine;
  /** Pi 宿主注入的 LLM 通道（initKaodesExtension 时透传） */
  public piModelRegistry?: PiCommandContext['modelRegistry'];
  public piModel?: unknown;
  /** 最近一次 AI 回答原文（供 TUI 提取记忆卡） */
  private lastAiAnswer?: string;

  constructor(options?: { configPath?: string; cacheDir?: string }) {
    this.auth = new AuthManager(options?.configPath);
    this.client = new KaodesClient(this.auth);
    this.cache = new SessionCache(options?.cacheDir);
    this.tutor = new AiTutorEngine();
  }

  private async chooseItem<T>(
    commandContext: PiCommandContext | undefined,
    title: string,
    items: T[],
    format: (item: T) => string,
    fallbackIndex = 0
  ): Promise<T | null> {
    if (!items.length) return null;
    if (items.length === 1) return items[fallbackIndex] || items[0];

    const ui = commandContext?.ui;
    // 优先用自带分页选择器：长章节列表可 ←/→ 翻页
    if (ui?.custom) {
      return (await pagedSelect(ui, { title, items, format })) ?? null;
    }
    if (!ui?.select) return items[fallbackIndex] || items[0];

    const options = items.map((item, index) => `${index + 1}. ${format(item)}`);
    const selected = await ui.select(title, options);
    if (!selected) return null;
    return items[options.indexOf(selected)] || null;
  }

  private chapterLabel(node: ChapterPracticeNode): string {
    const finished = Number(node.finishExerNum || 0);
    const total = Number(node.exerNum || 0);
    return `${node.name}  ${finished}/${total}题${node.finishRate ? `  ${node.finishRate}` : ''}`;
  }

  /**
   * 启动章节练习
   */
  public async startChapterExercise(courseIndex = 0, commandContext?: PiCommandContext): Promise<void> {
    const products = await this.client.getUserProductList();
    if (!products.length) {
      console.log('\n[Kaodes] 未查询到已购买的科目，请先确认账号或 Token 状态。');
      return;
    }

    const selectedProduct = await this.chooseItem(
      commandContext,
      '选择科目',
      products,
      (product) => product.name,
      courseIndex
    );
    if (!selectedProduct) return;
    console.log(`\n[Kaodes] 正在加载科目: 《${selectedProduct.name}》...`);

    // 产品列表通常不带课程 ID，先从官网同一接口解析真正的 courseID/cstid。
    const courseRows = selectedProduct.courseId
      ? []
      : await this.client.getCourseList(selectedProduct.productId);
    const selectedCourse = await this.chooseItem(
      commandContext,
      '选择课程',
      courseRows,
      (course) => course.courseName
    );
    if (!selectedProduct.courseId && courseRows.length > 0 && !selectedCourse) return;
    const requestedCourseId = selectedProduct.courseId || selectedCourse?.courseID || '';
    if (!requestedCourseId) {
      const message = `科目《${selectedProduct.name}》没有返回课程列表，无法确定 courseId。`;
      commandContext?.ui.notify(message, 'error');
      console.error(`[Kaodes] ${message}`);
      return;
    }

    const detail = await this.client.getCourseDetail(requestedCourseId, selectedProduct.productId);
    if (!detail) {
      const message = `科目《${selectedProduct.name}》没有返回课程详情，无法加载章节。`;
      commandContext?.ui.notify(message, 'error');
      console.error(`[Kaodes] ${message}`);
      return;
    }
    const cstId = detail?.cstId || selectedCourse?.cstid || 0;
    const courseId = detail?.courseId || requestedCourseId;
    if (!cstId) {
      const message = `科目《${selectedProduct.name}》没有返回有效 cstId，无法加载章节。`;
      commandContext?.ui.notify(message, 'error');
      console.error(`[Kaodes] ${message}`);
      return;
    }

    // 获取章节树
    const chapterTree = await this.client.getChapterTree(courseId, cstId, selectedProduct.productId);
    const selectedChapter = await this.chooseItem(
      commandContext,
      '选择章节',
      chapterTree.practiceChapter,
      (chapter) => this.chapterLabel(chapter)
    );
    if (!selectedChapter) return;

    const selectedSection = selectedChapter.children?.length
      ? await this.chooseItem(
          commandContext,
          selectedChapter.name,
          selectedChapter.children,
          (section) => this.chapterLabel(section)
        )
      : selectedChapter;
    if (!selectedSection) return;

    const catId = selectedSection.catId || selectedChapter.catId;
    if (!catId) {
      commandContext?.ui.notify('所选章节没有练习入口。', 'warning');
      return;
    }
    const sectionName = selectedSection.name;
    const chapterPath =
      selectedSection === selectedChapter ? selectedChapter.name : `${selectedChapter.name} > ${sectionName}`;

    // 检查是否有本地缓存断点
    let session = this.cache.loadSession(courseId, catId);
    if (!session) {
      console.log(`[Kaodes] 正在拉取题目: ${sectionName}...`);
      const practiceData = await this.client.getChapterPractice({
        catId,
        courseId,
        cstId,
        isRedo: 1,
        lastPosition: 0,
        linkName: `${selectedProduct.name}>${chapterPath}`,
        name: sectionName,
        scoringMethod: 1,
      });

      session = {
        prId: practiceData.prId,
        scoringMethod: practiceData.scoringMethod,
        courseId,
        courseName: selectedProduct.name,
        productId: selectedProduct.productId,
        cstId,
        catId,
        chapterName: chapterPath,
        exercises: practiceData.exerList.map((e, idx) => ({
          ...e,
          exerId: e.exerID || e.exerId || idx + 1,
          doResult: 0,
          userKey: null,
          viewAnswer: 0,
        })),
        currentIndex: 0,
        startTime: Date.now(),
        runSecond: 0,
      };
      this.cache.saveSession(session);
    } else {
      console.log(`[Kaodes] 恢复本地未完成断点进度 (当前第 ${session.currentIndex + 1} 题)...`);
    }

    const tui = new ExerciseTUI(session, this.client, this.cache, async (exer, mode) => {
      await this.tutor.interact(exer, mode);
    });

    await this.runTui(tui, commandContext);
  }

  /**
   * 启动每日一练
   */
  public async startDailyExercise(commandContext?: PiCommandContext): Promise<void> {
    const products = await this.client.getUserProductList();
    if (!products.length) return;
    const prod = products[0];

    console.log(`\n[Kaodes] 正在拉取《${prod.name}》每日一练...`);
    const exercises = await this.client.getEverydayExercises(String(prod.productId));
    if (!exercises.length) {
      console.log('[Kaodes] 今日每日一练已完成或暂无题目。');
      return;
    }

    const session: PracticeSession = {
      prId: Date.now(),
      scoringMethod: 1,
      courseId: String(prod.productId),
      courseName: prod.name,
      productId: prod.productId,
      cstId: 0,
      catId: 'daily',
      chapterName: '每日一练 (精选10题)',
      exercises: exercises.map((e, idx) => ({
        ...e,
        exerId: e.exerID || e.exerId || idx + 1,
        doResult: 0,
        userKey: null,
        viewAnswer: 0,
      })),
      currentIndex: 0,
      startTime: Date.now(),
      runSecond: 0,
    };

    const tui = new ExerciseTUI(session, this.client, this.cache, async (exer, mode) => {
      await this.tutor.interact(exer, mode);
    });
    await this.runTui(tui, commandContext);
  }

  /**
   * 启动错题本复习
   */
  public async startWrongQuestions(commandContext?: PiCommandContext): Promise<void> {
    const products = await this.client.getUserProductList();
    if (!products.length) return;
    const prod = products[0];

    console.log(`\n[Kaodes] 正在查询《${prod.name}》错题本...`);
    const wrongs = await this.client.getWrongQuestions(String(prod.productId));
    if (!wrongs.length) {
      console.log('✓ 恭喜！当前科目错题本为空。');
      return;
    }

    const session: PracticeSession = {
      prId: Date.now(),
      scoringMethod: 1,
      courseId: String(prod.productId),
      courseName: prod.name,
      productId: prod.productId,
      cstId: 0,
      catId: 'wrong',
      chapterName: '错题本精练攻坚',
      exercises: wrongs.map((e, idx) => ({
        ...e,
        exerId: e.exerID || e.exerId || idx + 1,
        doResult: 0,
        userKey: null,
        viewAnswer: 0,
      })),
      currentIndex: 0,
      startTime: Date.now(),
      runSecond: 0,
    };

    const tui = new ExerciseTUI(session, this.client, this.cache, async (exer, mode) => {
      await this.tutor.interact(exer, mode);
    });
    await this.runTui(tui, commandContext);
  }

  /**
   * 启动模拟考试模式
   */
  public async startMockExam(commandContext?: PiCommandContext): Promise<void> {
    const products = await this.client.getUserProductList();
    if (!products.length) return;
    const prod = products[0];

    console.log(`\n[Kaodes] 正在获取《${prod.name}》模拟考试试卷列表...`);
    const examList = await this.client.getMockExamList(String(prod.productId));
    if (!examList.length) {
      console.log('[Kaodes] 暂无开放的模拟考试试卷。');
      return;
    }

    const targetExam = examList[0];
    console.log(`[Kaodes] 正在进入试卷: 《${targetExam.name}》 (限时: ${targetExam.examTime || 60}分钟)...`);
    const examInfo = await this.client.getMockExamInfo(targetExam.id);

    const session: PracticeSession = {
      prId: targetExam.id,
      scoringMethod: 1,
      courseId: String(prod.productId),
      courseName: prod.name,
      productId: prod.productId,
      cstId: 0,
      catId: `exam_${targetExam.id}`,
      chapterName: `全真模拟考试: ${targetExam.name}`,
      exercises: (examInfo.exerList || []).map((e, idx) => ({
        ...e,
        exerId: e.exerID || e.exerId || idx + 1,
        doResult: 0,
        userKey: null,
        viewAnswer: 0,
      })),
      currentIndex: 0,
      startTime: Date.now(),
      runSecond: 0,
    };

    const tui = new ExerciseTUI(session, this.client, this.cache, async (exer, mode) => {
      await this.tutor.interact(exer, mode);
    });
    await this.runTui(tui, commandContext);
  }

  /**
   * 启动答题闯关模式
   */
  public async startChallenge(commandContext?: PiCommandContext): Promise<void> {
    const products = await this.client.getUserProductList();
    if (!products.length) return;
    const prod = products[0];

    console.log(`\n[Kaodes] 正在获取《${prod.name}》答题闯关关卡...`);
    const groups = await this.client.getChallengeGroupList(String(prod.productId));
    const targetGroup = groups[0] || { groupId: 1, name: '第一关：新手启航' };

    console.log(`[Kaodes] 正在进入关卡: ${targetGroup.name}...`);
    const challengeData = await this.client.getChallengePractice(targetGroup.groupId);

    const session: PracticeSession = {
      prId: targetGroup.groupId,
      scoringMethod: 1,
      courseId: String(prod.productId),
      courseName: prod.name,
      productId: prod.productId,
      cstId: 0,
      catId: `challenge_${targetGroup.groupId}`,
      chapterName: `答题闯关: ${targetGroup.name}`,
      exercises: (challengeData.exerList || []).map((e, idx) => ({
        ...e,
        exerId: e.exerID || e.exerId || idx + 1,
        doResult: 0,
        userKey: null,
        viewAnswer: 0,
      })),
      currentIndex: 0,
      startTime: Date.now(),
      runSecond: 0,
    };

    const tui = new ExerciseTUI(session, this.client, this.cache, async (exer, mode) => {
      await this.tutor.interact(exer, mode);
    });
    await this.runTui(tui, commandContext);
  }

  /** 调用 Pi 当前会话 LLM；不可用时返回 null */
  private async askPiLLM(commandContext: PiCommandContext, prompt: string): Promise<string | null> {
    const registry = commandContext.modelRegistry as
      | { complete(model: unknown, context: unknown): Promise<{ content?: Array<{ type: string; text?: string }>; errorMessage?: string }> }
      | undefined;
    const model = commandContext.model;
    if (!registry || !model) return null;
    try {
      const message = (await registry.complete(model, {
        systemPrompt:
          '你是备考伴学导师。回答学员关于当前题目的问题，简练准确。' +
          '若回答的知识点值得记忆，在回答末尾追加一张记忆卡，格式严格为：\n【记忆卡】\n【问】<一句话反问>\n【要点】<1-3 句要点>\n若不值得记忆则不加记忆卡。',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      })) as { content?: Array<{ type: string; text?: string }>; errorMessage?: string };
      if (message?.errorMessage) return null;
      const text = (message?.content || [])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('')
        .trim();
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * 快速问 AI：输入问题 → LLM 回答；回答含【记忆卡】时提示按 C 查看。
   */
  private async tutorInPi(
    exer: import('./types.js').ExerciseItem,
    mode: 'hint' | 'flashcard',
    commandContext: PiCommandContext
  ): Promise<void> {
    if (mode === 'hint') {
      // 一键点拨：直接让 AI 分析当前题（不剧透答案）
      const hint = await this.askPiLLM(commandContext, this.tutor.buildHintPrompt(exer));
      commandContext.ui.notify(hint || this.tutor.generateFallbackHint(exer), 'info');
      return;
    }

    // 快速提问：先收问题（预填题目上下文提示），再调 LLM
    const question = await commandContext.ui.input(
      '问 AI（关于当前题目）:',
      '如：这道题的 B 选项为什么不对？'
    );
    if (question === undefined || !question.trim()) return;

    const context = `【当前题目】${exer.title}\n${
      exer.a ? `A. ${exer.a}\n` : ''
    }${exer.b ? `B. ${exer.b}\n` : ''}${exer.c ? `C. ${exer.c}\n` : ''}${
      exer.d ? `D. ${exer.d}\n` : ''
    }${exer.userKey ? `【我的作答】${exer.userKey}\n` : ''}\n【我的问题】${question.trim()}`;

    const answer = await this.askPiLLM(commandContext, context);
    if (!answer) {
      commandContext.ui.notify('AI 暂不可用（无可用模型或调用失败），可稍后重试。', 'warning');
      return;
    }
    this.lastAiAnswer = answer;
    commandContext.ui.notify(answer, 'info');
    if (answer.includes('【记忆卡】')) {
      commandContext.ui.notify('AI 为你生成了一张记忆卡，按 C 键查看。', 'success');
    }
  }

  private async runTui(tui: ExerciseTUI, commandContext?: PiCommandContext): Promise<void> {
    if (commandContext) {
      if (commandContext.mode && commandContext.mode !== 'tui') {
        commandContext.ui.notify('刷题看板需要在 Pi 交互模式中运行。请直接启动 pi 后再执行 /kaodes。', 'warning');
        return;
      }
      // 补齐宿主 LLM 通道（命令 ctx 未携带时用 init 注入的）
      if (!commandContext.modelRegistry && this.piModelRegistry) {
        commandContext.modelRegistry = this.piModelRegistry;
        commandContext.model = this.piModel;
      }
      tui.setOnAiTutor(async (exer, mode) => {
        await this.tutorInPi(exer, mode, commandContext);
        // AI 回答后把记忆卡同步给 TUI（C 键查看）
        if (this.lastAiAnswer) {
          tui.setLastAiAnswer(this.lastAiAnswer);
          this.lastAiAnswer = undefined;
        }
      });
      await tui.startInPi(commandContext.ui);
      return;
    }
    await tui.start();
  }

  /**
   * 注册到 Pi 插件系统
   */
  public async handleCommand(args: string, ctx?: PiCommandContext): Promise<void> {
    this.auth.setPromptProvider(
      ctx ? (message) => ctx.ui.input(message, '粘贴 Token 或 Cookie，取消则返回') : undefined
    );
    const sub = (args || '').trim().toLowerCase();
    if (sub === 'login') {
      if (!ctx) {
        await this.auth.promptForToken();
        return;
      }
      const raw = await ctx.ui.input('粘贴 kaodes.com Token 或完整 Cookie:', 'Bearer eyJ...');
      if (raw === undefined) return;
      const token = this.auth.extractToken(raw);
      if (!token) {
        ctx.ui.notify('未输入 Token。', 'warning');
        return;
      }
      this.auth.saveTokenInput(raw);
      const valid = this.auth.isTokenValid(token);
      ctx.ui.notify(
        valid ? 'Kaodes Token 已保存。' : 'Token 已保存，但不是可解析的有效 JWT，调用接口时可能失败。',
        valid ? 'success' : 'warning'
      );
      return;
    }

    if (sub === 'help' || sub === 'h' || sub === '?') {
      if (ctx?.ui.notify) {
        ctx.ui.notify(KAODES_HELP, 'info');
      } else {
        console.log(`\n${KAODES_HELP}\n`);
      }
      return;
    }

    try {
      if (sub === 'daily') {
        await this.startDailyExercise(ctx);
      } else if (sub === 'wrong') {
        await this.startWrongQuestions(ctx);
      } else if (sub === 'exam') {
        await this.startMockExam(ctx);
      } else if (sub === 'challenge') {
        await this.startChallenge(ctx);
      } else {
        await this.startChapterExercise(0, ctx);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.ui.notify(`Kaodes 请求失败：${message}`, 'error');
      console.error(`[Kaodes] ${message}`);
    }
  }

  public register(ctx: PiExtensionContext): void {
    if (ctx.registerCommand) {
      ctx.registerCommand('kaodes', {
        description: '考得尚全模块终端刷题插件 (/kaodes help 查看完整帮助)',
        handler: (args, commandContext) => {
          // Pi 命令 ctx 本身就携带 modelRegistry/model（ExtensionCommandContext），直接透传
          if (!commandContext.modelRegistry && (ctx as { modelRegistry?: PiCommandContext['modelRegistry'] }).modelRegistry) {
            commandContext.modelRegistry = (ctx as { modelRegistry?: PiCommandContext['modelRegistry'] }).modelRegistry;
          }
          if (commandContext.model === undefined && (ctx as { model?: unknown }).model !== undefined) {
            commandContext.model = (ctx as { model?: unknown }).model;
          }
          return this.handleCommand(args, commandContext);
        },
      });
      return;
    }

    // 仅保留给旧测试宿主，不是 Pi 正式 API。
    ctx.registerSlashCommand?.('kaodes', (args) => this.handleCommand(args), '考得尚全模块终端刷题插件');
  }
}

/**
 * Pi 插件默认导出函数
 */
export default function initKaodesExtension(ctx: PiExtensionContext) {
  const ext = new KaodesExtension();
  // 透传宿主的 LLM 通道（modelRegistry/model），供快速问 AI 使用
  if (ctx.modelRegistry) ext.piModelRegistry = ctx.modelRegistry;
  if (ctx.model !== undefined) ext.piModel = ctx.model;
  ext.register(ctx);
  return ext;
}
