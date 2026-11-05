'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('task supervisor handles image output, large records and resumable log paging', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [path.join(__dirname, 'task-runner-unit-test.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
