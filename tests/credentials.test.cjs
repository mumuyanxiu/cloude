const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { StateStore } = require('../electron/state.cjs');
const { CredentialStore, credentialId, connectWithCredentials } = require('../electron/credentials.cjs');
const { SCHEME } = require('../electron/dpapi.cjs');

const config = { host: 'workspace-fixture', port: 22, username: 'tester', authType: 'password', autoConnect: true };
test('pasted key bodies are rejected before credential lookup or SSH', async () => {
  const unexpected = async () => { assert.fail('must reject before touching credentials or SSH'); };
  await assert.rejects(connectWithCredentials({ connect: unexpected }, { hydrate: unexpected }, {
    ...config, authType: 'key', privateKeyPath: ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----', 'synthetic-body'].join(' '),
  }), /需要私钥文件路径/);
});

function encryptionFixture() {
  const key = crypto.randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(value.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}
async function fixture(t, encryption = encryptionFixture()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-credentials-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const provider = {
    scheme: SCHEME,
    async encrypt(value) {
      if (!await encryption.isAsyncEncryptionAvailable()) throw new Error('Windows 加密服务不可用，本次登录凭据未保存。');
      return encryption.encryptStringAsync(value);
    },
    async decrypt(value) { return (await encryption.decryptStringAsync(value)).result; },
  };
  return { directory, store, encryption, provider, credentials: new CredentialStore(store, 'win32', provider) };
}

test('successful login retains only ciphertext and hydrates the same identity', async t => {
  const { directory, credentials } = await fixture(t);
  const input = { ...config, password: 'fixture-password-123' };
  const result = await connectWithCredentials({ async connect(value) { assert.equal(value.password, input.password); return { hostname: 'workspace' }; } }, credentials, input);
  assert.equal(result.credentialSaved, true);
  const disk = await fs.readFile(path.join(directory, 'credentials.json'), 'utf8');
  assert.ok(!disk.includes(input.password));
  assert.ok(!disk.includes('"password"'));
  assert.equal(JSON.parse(disk).entries[credentialId(config, 'win32')].scheme, SCHEME);
  assert.equal((await credentials.hydrate(config)).password, input.password);
  assert.equal(await credentials.has(config), true);
  assert.equal(config.password, undefined);
});

test('saved secrets cannot cross host, port, user, authentication type, or key file', async t => {
  const { store, credentials } = await fixture(t);
  await credentials.remember({ ...config, password: 'one-device-only' });
  for (const other of [{ ...config, host: 'other' }, { ...config, port: 2222 }, { ...config, username: 'root' }]) {
    await assert.rejects(credentials.hydrate(other), /请先输入一次登录密码/);
  }
  const keyConfig = { ...config, authType: 'key', privateKeyPath: 'C:\\keys\\one', passphrase: 'one-key-only' };
  await credentials.remember(keyConfig);
  assert.equal((await credentials.hydrate({ ...keyConfig, passphrase: '', privateKeyPath: 'C:\\keys\\two' })).passphrase, '');
  assert.equal(await credentials.has({ ...config, authType: 'agent' }), false);
  // Even a ciphertext moved under a different lookup key cannot be reused.
  const data = await store.read('credentials.json');
  const other = { ...config, host: 'copied-record' };
  data.entries[credentialId(other, 'win32')] = data.entries[credentialId(config, 'win32')];
  await store.write('credentials.json', data);
  await assert.rejects(credentials.hydrate(other), /与当前设备不匹配/);
});

test('authentication failures do not save or replace a credential', async t => {
  const { credentials } = await fixture(t);
  const remote = { async connect() { throw new Error('fixture authentication rejected'); } };
  await assert.rejects(connectWithCredentials(remote, credentials, { ...config, password: 'wrong' }), /rejected/);
  assert.equal(await credentials.has(config), false);
  await credentials.remember({ ...config, password: 'previous-valid' });
  await assert.rejects(connectWithCredentials(remote, credentials, { ...config, password: 'changed-but-invalid' }), /rejected/);
  assert.equal((await credentials.hydrate(config)).password, 'previous-valid');
});

test('explicit replacement and disabling automatic login update the saved credential', async t => {
  const { credentials } = await fixture(t);
  const remote = { async connect() { return { hostname: 'workspace' }; } };
  await credentials.remember({ ...config, password: 'old' });
  await connectWithCredentials(remote, credentials, { ...config, password: 'new' });
  assert.equal((await credentials.hydrate(config)).password, 'new');
  const result = await connectWithCredentials(remote, credentials, { ...config, autoConnect: false });
  assert.equal(result.credentialSaved, false);
  assert.equal(await credentials.has(config), false);
  await credentials.remember({ ...config, password: 'again' });
  await credentials.forget(config);
  assert.equal(await credentials.has(config), false);
});

test('unavailable encryption does not fall back to plaintext or fail an established connection', async t => {
  const encryption = encryptionFixture();
  encryption.isAsyncEncryptionAvailable = async () => false;
  const { directory, credentials } = await fixture(t, encryption);
  const result = await connectWithCredentials({ async connect() { return { hostname: 'connected-workspace' }; } }, credentials, { ...config, password: 'must-not-leak' });
  assert.equal(result.hostname, 'connected-workspace');
  assert.equal(result.credentialSaved, false);
  assert.match(result.warning, /Windows 加密服务不可用/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('serialized concurrent updates keep both profiles and honor queued deletion', async t => {
  const { credentials } = await fixture(t);
  const second = { ...config, host: 'second' };
  await Promise.all([
    credentials.remember({ ...config, password: 'first' }),
    credentials.remember({ ...second, password: 'second' }),
    credentials.forget(config),
  ]);
  assert.equal(await credentials.has(config), false);
  assert.equal((await credentials.hydrate(second)).password, 'second');
});

test('an unreadable credential is not advertised as usable or deleted', async t => {
  const { store, credentials } = await fixture(t);
  const identity = credentialId(config, 'win32');
  const original = { version: 1, entries: { [identity]: { scheme: SCHEME, encrypted: Buffer.from('fixture-invalid-ciphertext').toString('base64') } } };
  await store.write('credentials.json', original);
  assert.equal(await credentials.has(config), false);
  await assert.rejects(credentials.hydrate(config), /无法解密.*重新输入一次/);
  assert.deepEqual(await store.read('credentials.json'), original);
});
