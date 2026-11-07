'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { normalizeModels, modelListCommand, queryModels } = require('../electron/models.cjs');
const { RemoteClient, shellQuote } = require('../electron/remote.cjs');

function fixture(action) {
  const client = new EventEmitter(); const stream = new EventEmitter();
  stream.stderr = new EventEmitter(); stream.signals = []; stream.closed = 0; stream.writes = [];
  stream.signal = signal => stream.signals.push(signal);
  stream.close = () => { stream.closed++; stream.emit('close'); };
  stream.write = data => { const request = JSON.parse(data); stream.writes.push(request); action?.(stream, request); };
  client.exec = (_command, callback) => callback(null, stream);
  return { client, stream };
}
function response(request, models) {
  return Buffer.from(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models, account: { token: 'never-forward-account-data' } } } }) + '\n');
}

test('official initialize response supplies future models and effort metadata without a user prompt', async () => {
  const { client, stream } = fixture((stream, request) => {
    assert.equal(request.type, 'control_request'); assert.equal(request.request.subtype, 'initialize');
    stream.emit('data', Buffer.from('startup diagnostic\n'));
    stream.emit('data', response({ request_id: 'unrelated' }, []));
    const bytes = response(request, [{ value: 'fable', displayName: 'Fable 未来版', description: '来自远端', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'xhigh'] }, { value: 'provider/new-model', displayName: 'New model' }]);
    for (const byte of bytes) stream.emit('data', Buffer.from([byte]));
  });
  const result = await queryModels(client, 'fixture');
  assert.deepEqual(result.models.map(model => model.value), ['fable', 'provider/new-model']);
  assert.equal(result.models[0].displayName, 'Fable 未来版');
  assert.deepEqual(result.models[0].supportedEffortLevels, ['low', 'high', 'xhigh']);
  assert.ok(!JSON.stringify(result).includes('never-forward-account-data'));
  assert.equal(stream.writes.length, 1); assert.equal(stream.closed, 1);
  assert.deepEqual(stream.signals, ['TERM']); assert.equal(client.listenerCount('close'), 0);
});

test('missing models are an error, empty lists stay empty, and malformed entries are filtered', () => {
  assert.throws(() => normalizeModels(undefined), /未返回有效模型列表/);
  assert.deepEqual(normalizeModels([]), []);
  assert.deepEqual(normalizeModels([null, { value: 'bad model' }, { value: 'custom' }, { value: 'sonnet', supportsEffort: false }, { value: 'sonnet' }]), [
    { value: 'sonnet', displayName: 'sonnet', description: '', supportsEffort: false },
  ]);
});

test('lookup command uses the selected project and disables hooks, MCP and session persistence', () => {
  const command = modelListCommand("/opt/cli's/claude", "/work/a'b", shellQuote);
  assert.ok(command.includes(shellQuote("/work/a'b"))); assert.ok(command.includes(shellQuote("/opt/cli's/claude")));
  assert.match(command, /--no-session-persistence/); assert.match(command, /disableAllHooks/); assert.match(command, /--strict-mcp-config/);
  assert.doesNotMatch(command, /--model |--resume |--dangerously-skip|--permission-mode/);
});

test('lookup failures hide diagnostics, close the process, and cannot return a stale connection result', async () => {
  for (const action of [
    stream => { stream.stderr.emit('data', Buffer.from('sensitive diagnostic')); stream.emit('close'); },
    stream => stream.emit('data', Buffer.alloc(1024 * 1024 + 1)),
    (stream, request) => stream.emit('data', response(request, undefined)),
  ]) {
    const { client, stream } = fixture(action);
    await assert.rejects(queryModels(client, 'fixture'), error => { assert.ok(!error.message.includes('sensitive')); return true; });
    assert.equal(stream.closed, 1);
  }
  let checks = 0;
  const { client } = fixture((stream, request) => stream.emit('data', response(request, [{ value: 'fable' }])));
  await assert.rejects(queryModels(client, 'fixture', { assertCurrent() { if (++checks > 1) throw new Error('connection changed'); } }), /connection changed/);
});

test('timeouts and disconnects terminate a probe, including a late SSH channel', async () => {
  const { client, stream } = fixture(); let callback;
  client.exec = (_command, ready) => { callback = ready; };
  await assert.rejects(queryModels(client, 'fixture', { timeout: 10 }), /超时/);
  callback(null, stream); assert.equal(stream.closed, 1);
  const second = fixture();
  const pending = queryModels(second.client, 'fixture'); second.client.emit('close');
  await assert.rejects(pending, /SSH 已断开/); assert.equal(second.stream.closed, 1);
});

test('remote model lookup validates project access before starting the CLI', async () => {
  const remote = new RemoteClient(); remote.client = {}; remote.sftp = {};
  remote._directory = async directory => { assert.equal(directory, '/outside'); throw new Error('project access refused'); };
  await assert.rejects(remote.getModels('/outside'), /project access refused/);
});

test('remote model lookup rejects a late response from a previous SSH generation', async () => {
  let reply;
  const { client } = fixture((stream, request) => { reply = () => stream.emit('data', response(request, [{ value: 'stale' }])); });
  const remote = new RemoteClient(); remote.client = client; remote.sftp = {}; remote.workspace = '/work'; remote.claudePath = 'claude';
  const pending = remote.getModels(); remote.generation++; reply();
  await assert.rejects(pending, /连接已变化/);
});
