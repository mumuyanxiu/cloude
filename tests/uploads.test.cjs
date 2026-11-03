const test = require('node:test');
const assert = require('node:assert/strict');
const { sameLocalVersion } = require('../electron/uploads.cjs');
test('Windows missing volume ID does not prevent an unchanged file upload', () => {
  const version = { size: 10, mtimeMs: 1, ctimeMs: 2, ino: 123, dev: 0 };
  assert.equal(sameLocalVersion(version, { ...version, dev: 456 }), true);
  assert.equal(sameLocalVersion({ ...version, dev: 1 }, { ...version, dev: 2 }), false);
  for (const field of ['size', 'mtimeMs', 'ctimeMs', 'ino']) assert.equal(sameLocalVersion(version, { ...version, [field]: version[field] + 1 }), false);
});
