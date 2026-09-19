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

test('KaodesExtension - 使用 Pi 标准选择器选择章节与小节', async () => {
  const tmpConfig = path.join(os.tmpdir(), `test-chapter-select-${Date.now()}.json`);
  const tmpCache = path.join(os.tmpdir(), `test-chapter-cache-${Date.now()}`);
  const ext = new KaodesExtension({ configPath: tmpConfig, cacheDir: tmpCache });
  let requestedCatId = '';
  const selectedTitles: string[] = [];

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
      select: async (title, options) => {
        selectedTitles.push(title);
        return options.find((option) => option.includes(title === '选择章节' ? '第二章' : '第二节'));
      },
      notify: () => undefined,
      custom: async <T>() => undefined as T,
    },
  });

  assert.deepEqual(selectedTitles, ['选择章节', '第二章']);
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

