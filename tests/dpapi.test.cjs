const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowsDpapiProvider } = require('../electron/dpapi.cjs');

function fakeProcess(onInput) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = value => onInput(value, child);
  child.kill = () => { child.killed = true; };
  return child;
}

test('DPAPI sends credentials only through pipes with a fixed command and no shell', async () => {
  const secret = 'fixture-pipe-only-中文';
  let argumentsSeen; let request;
  const provider = new WindowsDpapiProvider({ platform: 'win32', spawnProcess(executable, args, options) {
    argumentsSeen = { executable, args, options };
    return fakeProcess((value, child) => {
      request = JSON.parse(value);
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ value: Buffer.from('protected-fixture').toString('base64') }))); child.emit('close', 0); });
    });
  } });
  assert.equal((await provider.encrypt(secret)).toString(), 'protected-fixture');
  assert.equal(request.value, secret);
  assert.equal(request.operation, 'encrypt');
  assert.equal(argumentsSeen.options.shell, false);
  assert.equal(argumentsSeen.options.windowsHide, true);
  assert.ok(!JSON.stringify(argumentsSeen).includes(secret));
  assert.ok(argumentsSeen.args.includes('-NoProfile'));
});

test('DPAPI timeout terminates its helper and returns no helper diagnostic content', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let child;
  const provider = new WindowsDpapiProvider({ platform: 'win32', timeout: 5, spawnProcess() {
    child = fakeProcess((_value, process) => process.stderr.emit('data', Buffer.from('must-not-appear-in-error')));
    return child;
  } });
  const pending = provider.encrypt('fixture');
  t.mock.timers.tick(6);
  await assert.rejects(pending, error => /超时/.test(error.message) && !error.message.includes('must-not-appear'));
  assert.equal(child.killed, true);
});

test('DPAPI rejects oversized data and other platforms before spawning a helper', async () => {
  const never = () => { throw new Error('must not spawn'); };
  const provider = new WindowsDpapiProvider({ platform: 'win32', spawnProcess: never });
  await assert.rejects(provider.encrypt('x'.repeat(128 * 1024 + 1)), /过大/);
  await assert.rejects(provider.decrypt(Buffer.alloc(256 * 1024 + 1)), /格式无效/);
  await assert.rejects(new WindowsDpapiProvider({ platform: 'linux', spawnProcess: never }).encrypt('fixture'), /Windows/);
});
