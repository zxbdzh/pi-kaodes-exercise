import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AuthManager } from '../auth/manager.js';
import { KaodesClient } from './client.js';

test('KaodesClient - 接口封装与请求格式验证', async () => {
  let capturedHeaders: http.IncomingHttpHeaders = {};
  let capturedBody = '';
  let capturedPath = '';

  const server = http.createServer(async (req, res) => {
    capturedHeaders = req.headers;
    capturedPath = req.url || '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    capturedBody = Buffer.concat(chunks).toString('utf8');

    res.setHeader('Content-Type', 'application/json');
    if (capturedPath.includes('getUserProductList')) {
      res.end(JSON.stringify({
        code: 200,
        flag: true,
        data: {
          list: [{ productId: 37487638, name: '习近平新时代中国特色社会主义思想概论' }]
        }
      }));
    } else if (capturedPath.includes('course/list')) {
      res.end(JSON.stringify({
        code: 200,
        flag: true,
        data: {
          rows: [{ courseID: '25390', courseName: '测试课程', cstid: 40201 }],
        },
      }));
    } else if (capturedPath.includes('course/practice')) {
      res.end(JSON.stringify({
        code: 200,
        flag: true,
        data: {
          prId: 56430554,
          scoringMethod: 1,
          exerList: [
            { exerID: 3869417, title: '测试题目1', rightKey: 'C', keyType: '单选', newKeyType: 1 }
          ]
        }
      }));
    } else if (capturedPath.includes('course/submitPractice')) {
      res.end(JSON.stringify({
        code: 200,
        flag: true,
        data: {
          correctRate: '100%',
          exerNum: 1,
          correctNum: 1,
          errorNum: 0,
          createDate: '2026-09-18 12:00:00'
        }
      }));
    } else {
      res.end(JSON.stringify({ code: 200, flag: true, data: {} }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const mockBaseUrl = `http://127.0.0.1:${address.port}/mobile/`;

  const payload = { userId: 8319835, exp: 2500000000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const token = `eyJhbGciOiJIUzUxMiJ9.${payloadB64}.sig`;

  const auth = new AuthManager('/tmp/test-token-file.json');
  auth.saveConfig({ token });

  const client = new KaodesClient(auth, mockBaseUrl);

  // 1. 测试获取产品列表
  const products = await client.getUserProductList();
  assert.equal(products.length, 1);
  assert.equal(products[0].productId, 37487638);
  assert.equal(capturedHeaders.platform, 'Pc');
  assert.equal(capturedHeaders.token, token);

  const courseRows = await client.getCourseList(37487638);
  assert.equal(courseRows[0].courseID, '25390');
  assert.equal(capturedHeaders['content-type'], 'application/json');
  assert.ok(capturedBody.includes('"productId":37487638'));

  // 2. 测试获取练习试题
  const practice = await client.getChapterPractice({
    catId: '10015493',
    courseId: '25390',
    cstId: 40201
  });
  assert.equal(practice.prId, 56430554);
  assert.equal(practice.exerList.length, 1);
  assert.equal(practice.exerList[0].exerID, 3869417);
  assert.ok(capturedBody.includes('"catId":"10015493"'));

  // 3. 测试提交练习
  const submitRes = await client.submitPractice({
    prId: 56430554,
    lastPosition: 1,
    scoringMethod: 1,
    time: 10,
    exercises: [{ exerId: 3869417, score: 0, userKey: 'C' }]
  });
  assert.equal(submitRes.data.correctNum, 1);
  assert.ok(capturedBody.includes('"userKey":"C"'));

  // 4. 测试模拟考试与答题闯关接口
  const examList = await client.getMockExamList('25390');
  assert.equal(Array.isArray(examList), true);

  const challengeList = await client.getChallengeGroupList('25390');
  assert.equal(Array.isArray(challengeList), true);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeRetryClient(): KaodesClient {
  const fakeAuth = { ensureValidToken: async () => 'test-token' } as unknown as AuthManager;
  return new KaodesClient(fakeAuth, 'https://example.test/mobile/');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('KaodesClient - 网络异常自动重试后成功', async () => {
  const client = makeRetryClient();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) throw new Error('ECONNRESET');
    return jsonResponse({ code: 200, flag: true, message: 'ok', data: { list: [{ productId: 1, name: '科目' }] } });
  }) as typeof fetch;

  try {
    const products = await client.getUserProductList();
    assert.equal(calls, 3, '应在第 3 次尝试成功');
    assert.equal(products.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('KaodesClient - 持续失败时抛出可读的网络错误', async () => {
  const client = makeRetryClient();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('timeout');
  }) as typeof fetch;

  try {
    await assert.rejects(() => client.getUserProductList(), /网络请求失败（已重试 3 次）/);
  } finally {
    globalThis.fetch = original;
  }
});

test('KaodesClient - 非 JSON 响应给出可读错误而非裸解析异常', async () => {
  const client = makeRetryClient();
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html>502 Bad Gateway</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;

  try {
    await assert.rejects(() => client.getUserProductList(), /不是有效 JSON/);
  } finally {
    globalThis.fetch = original;
  }
});
