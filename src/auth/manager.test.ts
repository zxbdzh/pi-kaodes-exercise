import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthManager } from './manager.js';

test('AuthManager - JWT 解析与有效性检测', () => {
  const tmpConfig = path.join(os.tmpdir(), `test-kaodes-config-${Date.now()}.json`);
  const auth = new AuthManager(tmpConfig);

  // 构造一个未来的有效 JWT payload: { userId: 8319835, exp: 2500000000 }
  const payload = { userId: 8319835, exp: 2500000000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const validToken = `eyJhbGciOiJIUzUxMiJ9.${payloadB64}.mocksignature`;

  const parsed = auth.parseToken(validToken);
  assert.ok(parsed);
  assert.equal(parsed.userId, 8319835);
  assert.equal(auth.isTokenValid(validToken), true);

  // 构造一个过期的 JWT payload: { userId: 1234, exp: 1000000000 }
  const expiredPayload = { userId: 1234, exp: 1000000000 };
  const expiredB64 = Buffer.from(JSON.stringify(expiredPayload)).toString('base64');
  const expiredToken = `eyJhbGciOiJIUzUxMiJ9.${expiredB64}.mocksignature`;

  assert.equal(auth.isTokenValid(expiredToken), false);

  // 提取 Cookie 测试
  const cookieStr = `sidebar=open; token=${validToken}; userId=8319835`;
  const extracted = auth.extractToken(cookieStr);
  assert.equal(extracted, validToken);

  // 保存与读取测试
  auth.saveConfig({ token: validToken });
  const loaded = auth.loadConfig();
  assert.ok(loaded);
  assert.equal(loaded.token, validToken);
  assert.equal(loaded.userId, 8319835);

  if (fs.existsSync(tmpConfig)) fs.unlinkSync(tmpConfig);
});
