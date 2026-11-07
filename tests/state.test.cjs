const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanState, StateStore, atomicDownload, safeFilename } = require('../electron/state.cjs');

test('connection credentials never enter saved state', () => {
  const state = cleanState({ connection: { host: 'workspace', password: 'secret', passphrase: 'phrase', privateKey: 'key-data', privateKeyPath: 'C:/key', port: 22, autoConnect: false, credentialSaved: true }, projects: [], conversations: [] });
  assert.equal(state.connection.host, 'workspace');
  assert.equal(state.connection.privateKeyPath, 'C:/key');
  assert.equal(state.connection.autoConnect, false);
  assert.equal(state.connection.credentialSaved, undefined);
  assert.equal(cleanState({ connection: { host: 'old-profile' } }).connection.autoConnect, true);
  for (const secret of ['secret', 'phrase', 'key-data']) assert.ok(!JSON.stringify(state).includes(secret));
});
test('private key bodies in the path field are removed before saving and when loading old profiles', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-key-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const secret = 'synthetic-key-body-not-for-storage';
  const raw = { connection: { host: 'fixture', privateKeyPath: ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----', secret].join(' ') } };
  await store.save(raw);
  assert.equal((await store.load()).connection.privateKeyPath, '');
  assert.ok(!(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).includes(secret));
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify(raw));
  const loaded = await store.load();
  assert.equal(loaded.connection.host, 'fixture');
  assert.equal(loaded.connection.privateKeyPath, '');
  await store.save(loaded);
  assert.ok(!(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).includes(secret));
});

test('queued writes preserve latest state and reload intact', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.save({ connection: { host: `workspace-${index}` }, projects: [], conversations: [] })));
  assert.equal((await store.load()).connection.host, 'workspace-7');
  assert.deepEqual(await fs.readdir(dir), ['workspace.json']);
});

test('Windows temporary file locks retry atomically, permanent locks preserve the old state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-state-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = new StateStore(dir);
  await original.save({ connection: { host: 'original' } });
  let attempts = 0; const pauses = [];
  const transient = new StateStore(dir, {
    platform: 'win32', wait: async ms => { pauses.push(ms); },
    rename: async (source, target) => {
      attempts++;
      if (attempts < 3) { const error = new Error('fixture file lock'); error.code = 'EPERM'; throw error; }
      return fs.rename(source, target);
    },
  });
  await transient.save({ connection: { host: 'updated' } });
  assert.equal((await transient.load()).connection.host, 'updated');
  assert.equal(attempts, 3); assert.deepEqual(pauses, [50, 100]);
  attempts = 0;
  const locked = new StateStore(dir, { platform: 'win32', wait: async () => {}, rename: async () => {
    attempts++; const error = new Error('fixture permanent lock'); error.code = 'EACCES'; throw error;
  } });
  await assert.rejects(locked.save({ connection: { host: 'must-not-replace' } }), /permanent lock/);
  assert.equal(attempts, 5);
  assert.equal((await original.load()).connection.host, 'updated');
  assert.deepEqual(await fs.readdir(dir), ['workspace.json']);
});
test('failed transfer preserves pre-existing destination and cleans partial data', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'report.txt');
  await fs.writeFile(target, 'original');
  const remote = { async download(_remote, local) { await fs.writeFile(local, 'half'); throw new Error('connection lost'); } };
  await assert.rejects(atomicDownload(remote, '/report.txt', target), /connection lost/);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(dir), ['report.txt']);
});
test('successful binary download replaces selected target exactly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, '结果.bin');
  const bytes = Buffer.from([0, 255, 13, 10, 0, 99]);
  await fs.writeFile(target, 'old');
  const result = await atomicDownload({ async download(_remote, local) { await fs.writeFile(local, bytes); return { bytes: bytes.length }; } }, '/结果.bin', target);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(result.bytes, 6);
  assert.deepEqual(await fs.readdir(dir), ['结果.bin']);
});
test('Windows download filenames are safe', () => {
  assert.equal(safeFilename('/tmp/CON.txt'), 'download_CON.txt');
  assert.equal(safeFilename('/tmp/a:b?.txt'), 'a_b_.txt');
  assert.equal(safeFilename('/tmp/结果.py'), '结果.py');
});
