import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { KaodesExtension, PLUGIN_VERSION } from './index.js';

test('KaodesExtension - courseDetail 返回 null 时不应抛出 cstId 错误', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-null-detail-${Date.now()}.json`);
  const ext = new KaodesExtension({ configPath: tmpConfig });
  const notifications: string[] = [];

  ext.client = {
    getUserProductList: async () => [{ productId: 37487638, name: '测试科目' }],
    getCourseList: async () => [{ courseID: '25390', courseName: '测试课程', cstid: 40201 }],
    getCourseDetail: async () => null,
  } as any;

  await assert.doesNotReject(() => ext.startChapterExercise(0, {
    ui: {
      input: async () => undefined,
      notify: (message: string) => notifications.push(message),
      custom: async <T>() => undefined as T,
    },
  }));
  assert.ok(notifications.some((message) => message.includes('课程详情')));
});

test('KaodesExtension - 分页选择器选择章节与小节（支持左右键翻页）', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-chapter-select-${Date.now()}.json`);
  const tmpCache = path.join(os.tmpdir(), `test-chapter-cache-${Date.now()}`);
  const ext = new KaodesExtension({ configPath: tmpConfig, cacheDir: tmpCache });
  let requestedCatId = '';
  const selectedTitles: string[] = [];
  let customCalls = 0;

  ext.client = {
    getUserProductList: async () => [{ productId: 1, name: '测试科目' }],
    getCourseList: async () => [{ courseID: 'course-1', courseName: '测试课程', cstid: 9 }],
    getCourseDetail: async () => ({ courseId: 'course-1', courseName: '测试课程', cstId: 9 }),
    getChapterTree: async () => ({
      practiceChapter: [
        { name: '第一章', catId: 'chapter-1', exerNum: 2, finishExerNum: 0, children: [] },
        {
          name: '第二章',
          catId: 'chapter-2',
          exerNum: 4,
          finishExerNum: 1,
          children: [
            { name: '第一节', catId: 'section-1', exerNum: 2, finishExerNum: 0 },
            { name: '第二节', catId: 'section-2', exerNum: 2, finishExerNum: 1 },
          ],
        },
      ],
    }),
    getChapterPractice: async (params: { catId: string }) => {
      requestedCatId = params.catId;
      return {
        prId: 1,
        scoringMethod: 1,
        exerList: [{ exerId: 1, title: '测试题', keyType: '单选', newKeyType: 1, a: 'A', b: 'B' }],
      };
    },
  } as any;

  await ext.startChapterExercise(0, {
    ui: {
      input: async () => undefined,
      notify: () => undefined,
      custom: async <T>(factory: any): Promise<T> => {
        customCalls++;
        // 前两次 custom 调用来自分页选择器（选择章节 / 第二章小节）；
        // 第三次起是答题 TUI 主组件，直接返回结束。
        if (customCalls > 2) return undefined as T;
        return new Promise<T>((resolve) => {
          const comp = factory({ requestRender() {} }, undefined, {}, (v: T) => resolve(v));
          selectedTitles.push(String(comp.render(80)[0]).replace(/\x1b\[[0-9;]*m/g, ''));
          comp.handleInput?.('\x1b[C'); // → 翻页（单页时不应越界）
          comp.handleInput?.('\x1b[D'); // ← 翻回
          comp.handleInput?.('\x1b[B'); // ↓ 光标到第二项
          comp.handleInput?.('\r'); // Enter 确认
        });
      },
    },
  });

  assert.ok(selectedTitles[0]?.includes('选择章节'), `标题应为选择章节: ${selectedTitles[0]}`);
  assert.ok(selectedTitles[1]?.includes('第二章'), `标题应为第二章: ${selectedTitles[1]}`);
  assert.equal(requestedCatId, 'section-2');
});

test('KaodesExtension - 选择列表按 ⌫ 返回上一级重选', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-chapter-back-${Date.now()}.json`);
  const tmpCache = path.join(os.tmpdir(), `test-chapter-back-cache-${Date.now()}`);
  const ext = new KaodesExtension({ configPath: tmpConfig, cacheDir: tmpCache });
  let requestedCatId = '';
  const titles: string[] = [];
  let customCalls = 0;
  // 每次分页选择器调用要按的键：第 1 次在课程页按 ⌫ 返回，之后逐级 down+Enter 选第二项
  const scripts = [['\x7f'], ['\x1b[B', '\r'], ['\x1b[B', '\r'], ['\x1b[B', '\r']];

  ext.client = {
    getUserProductList: async () => [{ productId: 1, name: '测试科目' }],
    getCourseList: async () => [
      { courseID: 'course-1', courseName: '课程一', cstid: 9 },
      { courseID: 'course-2', courseName: '课程二', cstid: 9 },
    ],
    getCourseDetail: async (courseId: string) => ({ courseId, courseName: '测试课程', cstId: 9 }),
    getChapterTree: async () => ({
      practiceChapter: [
        { name: '第一章', catId: 'chapter-1', exerNum: 2, finishExerNum: 0, children: [] },
        {
          name: '第二章',
          catId: 'chapter-2',
          exerNum: 4,
          finishExerNum: 1,
          children: [
            { name: '第一节', catId: 'section-1', exerNum: 2, finishExerNum: 0 },
            { name: '第二节', catId: 'section-2', exerNum: 2, finishExerNum: 1 },
          ],
        },
      ],
    }),
    getChapterPractice: async (params: { catId: string }) => {
      requestedCatId = params.catId;
      return {
        prId: 1,
        scoringMethod: 1,
        exerList: [{ exerId: 1, title: '测试题', keyType: '单选', newKeyType: 1, a: 'A', b: 'B' }],
      };
    },
  } as any;

  await ext.startChapterExercise(0, {
    ui: {
      input: async () => undefined,
      notify: () => undefined,
      custom: async <T>(factory: any): Promise<T> => {
        customCalls++;
        if (customCalls > scripts.length) return undefined as T; // 答题 TUI 主组件
        return new Promise<T>((resolve) => {
          const comp = factory({ requestRender() {} }, undefined, {}, (v: T) => resolve(v));
          titles.push(String(comp.render(80)[0]).replace(/\x1b\[[0-9;]*m/g, ''));
          for (const key of scripts[customCalls - 1]) comp.handleInput?.(key);
        });
      },
    },
  });

  assert.equal(customCalls, scripts.length + 1, '应为 4 次选择 + 1 次答题组件');
  assert.ok(titles[0]?.includes('选择课程'), `第 1 步应为选择课程: ${titles[0]}`);
  assert.ok(titles[1]?.includes('选择课程'), `⌫ 后应回到选择课程重选: ${titles[1]}`);
  assert.ok(titles[2]?.includes('选择章节'));
  assert.equal(requestedCatId, 'section-2');
  if (fs.existsSync(tmpCache)) fs.rmSync(tmpCache, { recursive: true });
});

test('KaodesExtension - 插件初始化与命令注册验证', () => {
  const tmpConfig = path.join(os.tmpdir(), `test-ext-cfg-${Date.now()}.json`);
  const ext = new KaodesExtension({ configPath: tmpConfig });

  let registeredCommand = '';
  let registeredDesc = '';
  const mockCtx = {
    registerCommand: (name: string, options: { description: string; handler: any }) => {
      registeredCommand = name;
      registeredDesc = options.description;
    },
  };

  ext.register(mockCtx);

  assert.equal(registeredCommand, 'kaodes');
  assert.ok(registeredDesc.includes('考得尚全模块终端刷题插件'));
});

test('KaodesExtension - /kaodes version 报告版本号与构建目录', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-version-${Date.now()}.json`);
  const ext = new KaodesExtension({ configPath: tmpConfig });
  const notifications: string[] = [];

  await ext.handleCommand('version', {
    ui: {
      input: async () => undefined,
      notify: (message: string) => notifications.push(message),
      custom: async <T>() => undefined as T,
    },
  });

  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].includes(`v${PLUGIN_VERSION}`), `应含版本号: ${notifications[0]}`);
  assert.ok(notifications[0].includes('构建目录'), `应含构建目录: ${notifications[0]}`);
});

test('KaodesExtension - 错题本走数字 courseID 而不是 productId', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-wrong-course-${Date.now()}.json`);
  const tmpCache = path.join(os.tmpdir(), `test-wrong-cache-${Date.now()}`);
  const ext = new KaodesExtension({ configPath: tmpConfig, cacheDir: tmpCache });
  let requestedCourseId = '';

  ext.client = {
    getUserProductList: async () => [{ productId: 37487638, name: '测试科目' }],
    getCourseList: async () => [{ courseID: '25390', courseName: '测试课程', cstid: 40201 }],
    getWrongPractice: async (courseId: string) => {
      requestedCourseId = courseId;
      return {
        lastPosition: 2,
        exerList: [
          { exerId: 1, title: '错题1', keyType: '单选', newKeyType: 1, a: 'A', b: 'B', rightKey: 'A', userKey: 'A' },
          { exerId: 2, title: '错题2', keyType: '单选', newKeyType: 1, a: 'A', b: 'B', rightKey: 'B', userKey: null },
        ],
      };
    },
  } as any;

  await ext.startWrongQuestions({
    ui: {
      input: async () => undefined,
      notify: () => undefined,
      custom: async <T>() => undefined as T,
    },
  });

  assert.equal(requestedCourseId, '25390');
  if (fs.existsSync(tmpCache)) fs.rmSync(tmpCache, { recursive: true });
});

test('KaodesExtension - 错题本加载过滤已移出题', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-wrong-drop-${Date.now()}.json`);
  const tmpCache = path.join(os.tmpdir(), `test-wrong-drop-cache-${Date.now()}`);
  const removedPath = path.join(tmpCache, 'removed.json');
  fs.mkdirSync(tmpCache, { recursive: true });
  const ext = new KaodesExtension({ configPath: tmpConfig, cacheDir: tmpCache, removedPath });
  ext.removed.add('25390', 1);
  const seen: number[] = [];

  ext.client = {
    getUserProductList: async () => [{ productId: 37487638, name: '测试科目' }],
    getCourseList: async () => [{ courseID: '25390', courseName: '测试课程', cstid: 40201 }],
    getWrongPractice: async () => ({
      lastPosition: 1,
      exerList: [
        { exerId: 1, title: '已移出', keyType: '单选', newKeyType: 1, a: 'A', b: 'B' },
        { exerId: 2, title: '留下', keyType: '单选', newKeyType: 1, a: 'A', b: 'B' },
      ],
    }),
  } as any;

  await ext.startWrongQuestions({
    ui: {
      input: async () => undefined,
      notify: () => undefined,
      custom: async <T>(factory: any): Promise<T> => {
        const comp = factory({ requestRender() {} }, undefined, {}, () => undefined);
        const text = comp.render(80).join('\n');
        seen.push(text.includes('已移出') ? 1 : 0);
        seen.push(text.includes('留下') ? 1 : 0);
        return undefined as T;
      },
    },
  });

  assert.deepEqual(seen, [0, 1]);
  if (fs.existsSync(tmpCache)) fs.rmSync(tmpCache, { recursive: true });
});

function wrongUi(notes: string[]) {
  return {
    input: async () => undefined,
    notify: (message: string) => notes.push(message),
    custom: async <T>() => undefined as T,
  };
}

test('KaodesExtension - 错题本空列表、接口失败、Token 失效都只提示不抛出', async () => {
  const base = () => ({
    getUserProductList: async () => [{ productId: 37487638, name: '测试科目' }],
    getCourseList: async () => [{ courseID: '25390', courseName: '测试课程', cstid: 40201 }],
  });

  const emptyNotes: string[] = [];
  const emptyExt = new KaodesExtension({
    configPath: path.join(os.tmpdir(), `test-wrong-empty-${Date.now()}.json`),
    cacheDir: path.join(os.tmpdir(), `test-wrong-empty-cache-${Date.now()}`),
  });
  emptyExt.client = { ...base(), getWrongPractice: async () => ({ exerList: [], lastPosition: 0 }) } as any;
  await assert.doesNotReject(() => emptyExt.startWrongQuestions({ ui: wrongUi(emptyNotes) }));
  assert.ok(emptyNotes.some((message) => message.includes('错题本是空的')));

  const apiNotes: string[] = [];
  const apiExt = new KaodesExtension({
    configPath: path.join(os.tmpdir(), `test-wrong-api-${Date.now()}.json`),
    cacheDir: path.join(os.tmpdir(), `test-wrong-api-cache-${Date.now()}`),
  });
  apiExt.client = { ...base(), getWrongPractice: async () => { throw new Error('findWrong: 系统异常（code 500）'); } } as any;
  await assert.doesNotReject(() => apiExt.startWrongQuestions({ ui: wrongUi(apiNotes) }));
  assert.ok(apiNotes.some((message) => message.includes('接口失败')));
  assert.ok(!apiNotes.some((message) => message.includes('Token 已失效')));

  const tokenNotes: string[] = [];
  const tokenExt = new KaodesExtension({
    configPath: path.join(os.tmpdir(), `test-wrong-token-${Date.now()}.json`),
    cacheDir: path.join(os.tmpdir(), `test-wrong-token-cache-${Date.now()}`),
  });
  tokenExt.client = { ...base(), getWrongPractice: async () => { throw new Error('登录已过期 code 10005'); } } as any;
  await assert.doesNotReject(() => tokenExt.startWrongQuestions({ ui: wrongUi(tokenNotes) }));
  assert.ok(tokenNotes.some((message) => message.includes('Token 已失效')));
  assert.ok(tokenNotes.some((message) => message.includes('不受影响')));
});

