import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Preferences } from './preferences.js';

test('Preferences - 默认值、持久化与损坏文件回退', () => {
  const tmp = path.join(os.tmpdir(), `test-prefs-${Date.now()}.json`);

  // 默认值
  const p1 = new Preferences(tmp);
  assert.equal(p1.highlightEnabled, true);
  assert.equal(p1.pageSize, 15);

  // 写入后重新加载应恢复
  p1.setHighlightEnabled(false);
  p1.setPageSize(8);
  assert.ok(fs.existsSync(tmp), '应生成偏好文件');
  const p2 = new Preferences(tmp);
  assert.equal(p2.highlightEnabled, false);
  assert.equal(p2.pageSize, 8);

  // 越界 pageSize 被夹取
  p2.setPageSize(999);
  assert.equal(new Preferences(tmp).pageSize, 50);
  p2.setPageSize(1);
  assert.equal(new Preferences(tmp).pageSize, 3);

  // 损坏 JSON 回退默认值，不抛错
  fs.writeFileSync(tmp, '{ not json', 'utf8');
  const p3 = new Preferences(tmp);
  assert.equal(p3.highlightEnabled, true);
  assert.equal(p3.pageSize, 15);

  fs.rmSync(tmp, { force: true });
});
