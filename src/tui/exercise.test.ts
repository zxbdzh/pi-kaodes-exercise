import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionCache } from '../cache/session.js';
import { ExerciseTUI, visibleWidth, KAODES_HELP } from './exercise.js';
import { KaodesClient } from '../api/client.js';
import { AuthManager } from '../auth/manager.js';
import { PracticeSession } from '../types.js';

function makeMockSession(): PracticeSession {
  return {
    prId: 56430554,
    scoringMethod: 1,
    courseId: '25390',
    courseName: '习近平新时代中国特色社会主义思想概论',
    productId: 37487638,
    cstId: 40201,
    catId: '10015493',
    chapterName: '第四节 铸就社会主义文化新辉煌',
    currentIndex: 0,
    startTime: Date.now(),
    runSecond: 0,
    exercises: [
      {
        exerId: 1,
        title: '题目一',
        keyType: '单选',
        newKeyType: 1,
        a: '选项A',
        b: '选项B',
        rightKey: 'A',
        userKey: null,
        doResult: 0
      },
      {
        exerId: 2,
        title: '题目二',
        keyType: '单选',
        newKeyType: 1,
        a: '选项A',
        b: '选项B',
        rightKey: 'B',
        userKey: 'B',
        doResult: 1
      }
    ]
  };
}

test('ExerciseTUI & SessionCache - 答题卡渲染与断点离线缓存', async () => {
  const tmpCacheDir = path.join(os.tmpdir(), `test-cache-${Date.now()}`);
  const cache = new SessionCache(tmpCacheDir);
  const mockSession = makeMockSession();

  // 1. 测试缓存写入与恢复
  cache.saveSession(mockSession);
  const loaded = cache.loadSession('25390', '10015493');
  assert.ok(loaded);
  assert.equal(loaded.exercises.length, 2);
  assert.equal(loaded.exercises[1].userKey, 'B');

  // 2. 测试 TUI 渲染
  const auth = new AuthManager();
  const client = new KaodesClient(auth);
  const tui = new ExerciseTUI(mockSession, client, cache);

  const sheetStr = tui.renderSheet();
  assert.ok(sheetStr.includes('[1:○]')); // 当前选中且未做
  assert.ok(sheetStr.includes('2:✔'));   // 第2题正确

  const qText = tui.renderQuestion();
  assert.ok(qText.includes('题目一'));
  assert.ok(qText.includes('A. 选项A'));

  // 上下键移动选项光标，Enter 确认作答（提问插件同款交互）
  tui.moveOptionCursor(1); // 光标移到 B
  tui.confirmOptionCursor();
  assert.equal(mockSession.exercises[0].userKey, 'B');
  assert.equal(mockSession.exercises[0].doResult, -1);
  // 答错自动展开答案与解析，无需手动按 V
  assert.equal(mockSession.exercises[0].viewAnswer, 1);
  assert.ok(tui.renderQuestion().includes('答案'));
  tui.moveOptionCursor(-1); // 回绕到 A
  tui.confirmOptionCursor();
  assert.equal(mockSession.exercises[0].userKey, 'A');
  assert.equal(mockSession.exercises[0].doResult, 1);
  // Pi 官方 select 同款：→ 指示光标行，其余行两空格缩进
  assert.ok(tui.renderQuestion().includes('→ A. 选项A'));
  assert.ok(tui.renderQuestion().includes('  B. 选项B'));
  assert.ok(!tui.renderQuestion().includes('[✔]'));
  assert.ok(!tui.renderQuestion().includes('[ ]'));
  // 主界面不再展示快捷键说明
  assert.ok(!qText.includes('作答'));
  assert.ok(!qText.includes('快捷'));
  assert.ok(!qText.includes('翻题'));

  // 3. 测试作答逻辑
  tui.selectAnswer('A');
  assert.equal(mockSession.exercises[0].userKey, 'A');
  assert.equal(mockSession.exercises[0].doResult, 1);

  // 4. 测试 Pi 官方 custom() 组件适配与按键路由
  let component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
  await tui.startInPi({
    custom: async <T>(factory: any): Promise<T> => {
      await new Promise<void>((resolve) => {
        component = factory({ requestRender() {} }, {}, {}, () => resolve());
        assert.ok(component!.render(40).every((line) => visibleWidth(line) <= 40));
        assert.ok(component!.render(10).every((line) => visibleWidth(line) <= 10));
        component!.handleInput?.('n');
        component!.handleInput?.('p');
        component!.handleInput?.('v');
        component!.handleInput?.('\x1b[B'); // down：选项光标移到 B
        component!.handleInput?.('\x1b[A'); // up：选项光标移回 A
        component!.handleInput?.('\r'); // enter：确认光标所在选项 A
        assert.equal(mockSession.exercises[0].userKey, 'A');
        component!.handleInput?.('\x1b'); // esc：组件内自绘退出对话框
        assert.ok(component!.render(80).some((line) => line.includes('退出练习')), '应渲染退出对话框');
        component!.handleInput?.('\x1b'); // 再按 esc：继续答题
        assert.ok(!component!.render(80).some((line) => line.includes('退出练习')));
        component!.handleInput?.('\x1b'); // 重新打开
        component!.handleInput?.('\x1b[B'); // ↓ 移到「不保存退出」
        component!.handleInput?.('\r'); // Enter → 清断点并结束
      });
      return undefined as T;
    },
    input: async () => undefined,
    notify: () => undefined,
  });
  assert.equal(mockSession.currentIndex, 0);
  // 答错时自动展开（viewAnswer=1），序列中的 'v' 又将其切换隐藏
  assert.equal(mockSession.exercises[0].viewAnswer, 0);
  assert.equal(cache.loadSession('25390', '10015493'), null);

  // 清理
  cache.clearSession('25390', '10015493');
  assert.equal(cache.loadSession('25390', '10015493'), null);
  if (fs.existsSync(tmpCacheDir)) fs.rmdirSync(tmpCacheDir, { recursive: true });
});

test('ExerciseTUI - 低调布局：session 底栏、指令输入行与多终端宽度稳定', async () => {
  const tmpCacheDir = path.join(os.tmpdir(), `test-cache-${Date.now()}`);
  const cache = new SessionCache(tmpCacheDir);
  const mockSession = makeMockSession();
  const tui = new ExerciseTUI(mockSession, new KaodesClient(new AuthManager()), cache);

  let component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
  const notified: string[] = [];
  await tui.startInPi({
    custom: async <T>(factory: any): Promise<T> => {
      await new Promise<void>((resolve) => {
        component = factory({ requestRender() {} }, undefined, {}, () => resolve());

        for (const width of [120, 80, 40, 20, 10, 6, 4, 1]) {
          const lines = component!.render(width);
          assert.ok(lines.length > 0, `width=${width} 应有输出`);
          for (const line of lines) {
            assert.ok(
              visibleWidth(line) <= width,
              `width=${width} 行越界 (${visibleWidth(line)}): ${JSON.stringify(line)}`
            );
          }
        }

        // 常规宽度：边框 + session 行 + ❯ 输入行
        const lines80 = component!.render(80);
        assert.ok(lines80[0].includes('╭'));
        assert.ok(lines80[lines80.length - 1].includes('❯'));
        const sessionLine = lines80.find((line) => line.includes('session:'));
        assert.ok(sessionLine, '应包含 session 底栏行');
        assert.ok(sessionLine!.includes('1/2'));
        assert.ok(sessionLine!.includes('已做 1'));
        // 主区域不出现快捷键说明
        assert.ok(!lines80.some((line) => line.includes('作答') || line.includes('交卷')));

        component!.handleInput?.('\x1b'); // esc → 退出对话框（光标默认在「保存断点并退出」）
        component!.handleInput?.('\r'); // Enter → 保存并退出
      });
      return undefined as T;
    },
    input: async () => undefined,
    notify: (message) => notified.push(message),
  });
  assert.deepEqual(notified, []);
  assert.ok(cache.loadSession('25390', '10015493'), '保存断点并退出应保留本地断点');
  if (fs.existsSync(tmpCacheDir)) fs.rmSync(tmpCacheDir, { recursive: true });
});

test('ExerciseTUI - 指令输入：输入/提交/取消/无效/跳题/退出全状态', async () => {
  const tmpCacheDir = path.join(os.tmpdir(), `test-cache-${Date.now()}`);
  const cache = new SessionCache(tmpCacheDir);
  const mockSession = makeMockSession();
  const tui = new ExerciseTUI(mockSession, new KaodesClient(new AuthManager()), cache);

  let component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
  const notified: string[] = [];

  await tui.startInPi({
    custom: async <T>(factory: any): Promise<T> => {
      await new Promise<void>((resolve) => {
        component = factory({ requestRender() {} }, undefined, {}, () => resolve());

        // --- 输入状态：: 聚焦，逐字符输入 goto 2 ---
        component!.handleInput?.(':');
        for (const ch of 'goto 2') component!.handleInput?.(ch);
        let lines = component!.render(80);
        let inputLine = lines[lines.length - 1];
        assert.ok(inputLine.includes('goto 2'), `输入行应回显 goto 2: ${JSON.stringify(inputLine)}`);
        assert.ok(inputLine.includes('\x1b[7m'), '聚焦时应显示反显光标');

        // --- 提交状态：Enter 执行并跳到第 2 题 ---
        component!.handleInput?.('\r');
        assert.equal(mockSession.currentIndex, 1);
        lines = component!.render(80);
        assert.ok(lines.find((line) => line.includes('session:'))!.includes('2/2'));
        // 提交后输入框清空并退出聚焦
        assert.ok(!lines[lines.length - 1].includes('goto'));

        // --- 取消状态：Esc 清空未提交内容 ---
        component!.handleInput?.(':');
        for (const ch of 'save') component!.handleInput?.(ch);
        component!.handleInput?.('\x1b');
        lines = component!.render(80);
        assert.ok(!lines[lines.length - 1].includes('save'), '取消后输入行应清空');
        // 未提交不应触发保存副作用
        assert.deepEqual(notified, [] as string[]);

        // --- 退格与 Ctrl+U ---
        component!.handleInput?.(':');
        for (const ch of 'xyz') component!.handleInput?.(ch);
        component!.handleInput?.('\x7f');
        lines = component!.render(80);
        assert.ok(lines[lines.length - 1].includes('xy'));
        component!.handleInput?.('\x15');
        lines = component!.render(80);
        assert.ok(!lines[lines.length - 1].includes('xy'));

        // --- 无效命令状态：错误反馈 ---
        component!.handleInput?.(':');
        for (const ch of 'nosuchcmd') component!.handleInput?.(ch);
        component!.handleInput?.('\r');
        lines = component!.render(80);
        const statusLine = lines.find((line) => line.includes('未知命令'));
        assert.ok(statusLine, '无效命令应有错误反馈');
        assert.ok(statusLine!.includes('✗'));

        // --- 数字快捷跳题 ---
        component!.handleInput?.(':');
        component!.handleInput?.('1');
        component!.handleInput?.('\r');
        assert.equal(mockSession.currentIndex, 0);

        // --- 越界跳题报错 ---
        component!.handleInput?.(':');
        for (const ch of 'goto 9') component!.handleInput?.(ch);
        component!.handleInput?.('\r');
        lines = component!.render(80);
        assert.ok(lines.some((line) => line.includes('超出范围')));
        assert.equal(mockSession.currentIndex, 0);

        // --- help 命令 ---
        component!.handleInput?.(':');
        component!.handleInput?.('h');
        component!.handleInput?.('\r');
        assert.ok(notified.some((message) => message.includes('Kaodes 刷题帮助')));

        // --- exit discard：不保存退出 ---
        component!.handleInput?.(':');
        for (const ch of 'exit discard') component!.handleInput?.(ch);
        component!.handleInput?.('\r');
      });
      return undefined as T;
    },
    input: async () => undefined,
    select: async () => '继续答题',
    notify: (message) => notified.push(message),
  });

  assert.equal(cache.loadSession('25390', '10015493'), null, 'exit discard 应清除本地断点');
  assert.ok(KAODES_HELP.includes('goto') && KAODES_HELP.includes('exit'));
  if (fs.existsSync(tmpCacheDir)) fs.rmSync(tmpCacheDir, { recursive: true });
});

test('ExerciseTUI - 规则高亮：行内分段着色与 :hl 开关', async () => {
  const tmpCacheDir = path.join(os.tmpdir(), `test-hl-${Date.now()}`);
  const cache = new SessionCache(tmpCacheDir);
  const session: PracticeSession = {
    prId: 1,
    scoringMethod: 1,
    courseId: 'hl-course',
    courseName: '高亮测试',
    productId: 1,
    cstId: 1,
    catId: 'hl-cat',
    chapterName: '高亮',
    currentIndex: 0,
    startTime: Date.now(),
    runSecond: 0,
    exercises: [
      {
        exerId: 1,
        title: '全面推进强国建设，关键是党，错误的是哪一项',
        keyType: '单选',
        newKeyType: 1,
        a: '坚持党的全面领导',
        b: '坚持党的中心工作',
        rightKey: 'A',
        userKey: null,
        doResult: 0,
        analyze: '由此可见，根本在于坚持党的领导。',
      },
    ],
  };
  const tui = new ExerciseTUI(session, new KaodesClient(new AuthManager()), cache);

  const painted: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      painted.push(`${color}|${text}`);
      return `<${color}>${text}</>`;
    },
  };

  await tui.startInPi({
    custom: async <T>(factory: any): Promise<T> => {
      await new Promise<void>((resolve) => {
        const component = factory({ requestRender() {} }, theme, {}, () => resolve());

        painted.length = 0;
        component.render(80);
        assert.ok(painted.includes('yellow|关键'), `题干题眼应为黄: ${painted.join(' / ')}`);
        assert.ok(painted.includes('red|错误的是'), `否定设问应为红: ${painted.join(' / ')}`);
        assert.ok(painted.includes('muted|坚持党的'), '选项公共前缀应弱化');
        assert.ok(painted.includes('accent|→ A. '), '光标行选项字母不应被弱化');
        assert.ok(!painted.some((p) => p.startsWith('green|')), '解析未展开时不应出现结论着色');

        component.handleInput?.('v'); // 展开答案与解析
        painted.length = 0;
        component.render(80);
        assert.ok(painted.includes('green|由此可见'), '解析结论词应为绿');

        component.handleInput?.(':');
        for (const ch of 'hl off') component.handleInput?.(ch);
        component.handleInput?.('\r');
        painted.length = 0;
        component.render(80);
        assert.ok(
          !painted.includes('yellow|关键') &&
            !painted.includes('red|错误的是') &&
            !painted.includes('green|由此可见') &&
            !painted.includes('muted|坚持党的'),
          `:hl off 后应无任何规则着色: ${painted.join(' / ')}`
        );

        component.handleInput?.(':');
        for (const ch of 'exit discard') component.handleInput?.(ch);
        component.handleInput?.('\r');
      });
      return undefined as T;
    },
    input: async () => undefined,
    notify: () => undefined,
  });
  if (fs.existsSync(tmpCacheDir)) fs.rmSync(tmpCacheDir, { recursive: true });
});
