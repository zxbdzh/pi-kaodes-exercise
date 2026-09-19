import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { KaodesExtension } from './index.js';

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

