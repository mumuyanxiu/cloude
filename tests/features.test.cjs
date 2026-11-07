'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { RemoteClient } = require('../electron/remote.cjs');
const { LocalSftp } = require('./helpers/local-sftp.cjs');
const { imageMime, portNumber } = require('../electron/remote-features.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-features-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = new RemoteClient(); remote.sftp = new LocalSftp(root); remote.client = {};
  remote.home = '/home/tester'; remote.workspace = '/home/tester/work'; remote.workspaceInput = remote.workspace;
  await fs.mkdir(remote.sftp.native(remote.workspace), { recursive: true });
  return { remote, native: p => remote.sftp.native(p) };
}
test('media preview checks actual bytes and confines access to the project', async t => {
  const { remote, native } = await fixture(t);
  await fs.writeFile(native('/home/tester/work/image.png'), PNG);
  const media = await remote.readMedia('/home/tester/work/image.png');
  assert.equal(media.mime, 'image/png'); assert.equal(media.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  await fs.writeFile(native('/home/tester/work/fake.png'), '<script>do not render</script>');
  await assert.rejects(remote.readMedia('/home/tester/work/fake.png'), /支持预览/);
  await assert.rejects(remote.readMedia('/home/tester/private.png'), /工作目录/);
  assert.equal(imageMime(Buffer.from('<svg></svg>')), null);
});
test('file references search recursively and omit dependency trees and symbolic links', async t => {
  const { remote, native } = await fixture(t);
  await fs.mkdir(native('/home/tester/work/src')); await fs.mkdir(native('/home/tester/work/node_modules'));
  await fs.writeFile(native('/home/tester/work/src/main.py'), 'print(1)'); await fs.writeFile(native('/home/tester/work/node_modules/main.py'), 'skip');
  const found = await remote.searchFiles({ projectPath: remote.workspace, query: 'main' });
  assert.deepEqual(found.files.map(f => f.path), ['/home/tester/work/src/main.py']);
});
test('tunnel binds only loopback, forwards data, reuses the connection and closes all sockets', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const remote = new RemoteClient(); remote.sftp = {};
  const requests = [];
  remote.client = { forwardOut(source, sourcePort, target, targetPort, callback) { requests.push({ target, targetPort }); const socket = net.connect(targetPort, target, () => callback(null, socket)); socket.close = () => socket.destroy(); } };
  t.after(() => { remote.closePorts(); echo.close(); });
  const tunnel = await remote.forwardPort({ remotePort: echo.address().port });
  assert.equal(remote.tunnels.get(tunnel.id).server.address().address, '127.0.0.1');
  assert.equal((await remote.forwardPort({ remotePort: echo.address().port })).id, tunnel.id);
  const socket = net.connect(tunnel.localPort, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  const answer = new Promise(resolve => socket.once('data', resolve)); socket.write('forwarded bytes');
  assert.equal(String(await answer), 'forwarded bytes'); assert.equal(requests[0].target, '127.0.0.1');
  socket.destroy(); remote.closePort(tunnel.id); assert.equal(remote.listPorts().length, 0);
  assert.throws(() => portNumber(0)); assert.throws(() => portNumber(65536));
});
test('task prompts travel on stdin and helper code is fixed, even with shell characters', async () => {
  const remote = new RemoteClient(); remote._directory = async value => value;
  let captured;
  remote._execCapture = async (command, options) => { captured = { command, options }; return { code: 0, stdout: '{"jobId":"fixture"}' }; };
  await remote.startPersistentChat({ projectPath: '/project', jobId: 'fixture', conversationId: 'conversation', prompt: 'literal $(touch forbidden) secret', mode: 'edit' });
  assert.doesNotMatch(captured.command, /literal \$\(touch forbidden\) secret/);
  assert.ok(Buffer.byteLength(captured.command) < 2048, 'SSH exec carries only a fixed loader, not the entire supervisor');
  assert.equal(JSON.parse(captured.options.input).prompt, 'literal $(touch forbidden) secret');
  assert.match(JSON.parse(captured.options.input).runnerSource, /Per-task Claude/);
  assert.equal(JSON.parse(captured.options.input).allowCommands, undefined);
  assert.equal(JSON.parse(captured.options.input).askCommands, undefined);
});

test('approval scope crosses the task transport without renderer-supplied permission rules', async () => {
  const remote = new RemoteClient();
  const calls = [];
  remote.taskRequest = async (...args) => { calls.push(args); };
  const options = { projectPath: '/project', jobId: 'job', requestId: 'approval', allow: true };
  await remote.replyTask(options);
  await remote.replyTask({ ...options, scope: 'project', toolName: 'Bash', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] });
  assert.deepEqual(calls.map(call => call[2].scope), ['once', 'project']);
  assert.equal(calls[1][0], '/project');
  assert.equal(calls[1][1], 'reply');
  assert.equal(calls[1][2].toolName, undefined);
  assert.equal(calls[1][2].updatedPermissions, undefined);
});

test('effort capability checks preserve defaults and reject unsupported CLI options before launch', async () => {
  const remote = new RemoteClient();
  let calls = 0;
  remote._execCapture = async () => { calls++; return { code: 0, stdout: '  --effort <level> Effort level (low, medium, high, max)\n  --model <model> Model name\n' }; };
  assert.deepEqual(await remote.checkInferenceOptions({}), {});
  assert.deepEqual(await remote.checkInferenceOptions({ model: 'sonnet' }), { model: 'sonnet' });
  assert.equal(calls, 0, 'following remote settings must not probe or override effort');
  assert.deepEqual(await remote.checkInferenceOptions({ effort: 'high' }), { effort: 'high' });
  await assert.rejects(remote.checkInferenceOptions({ effort: 'xhigh' }), /不支持或未列出 xhigh/);
  remote._execCapture = async () => ({ code: 0, stdout: '  --model <model> low medium high max\n' });
  await assert.rejects(remote.checkInferenceOptions({ effort: 'high' }), /不支持/);
  remote._execCapture = async () => ({ code: 0, stdout: '  --effort <level>\n      Supported: low, medium, high, xhigh, max\n  --model <model>\n' });
  assert.equal((await remote.checkInferenceOptions({ effort: 'xhigh' })).effort, 'xhigh');
});

test('both task paths carry selected model and effort; persistent launch rejects unsupported effort', async () => {
  const remote = new RemoteClient(); remote._directory = async value => value;
  remote._execCapture = async () => ({ code: 0, stdout: '  --effort <level> low medium high max\n  --model <model>\n' });
  let task, job;
  remote.taskRequest = async (_project, _operation, options) => { task = options; return { jobId: options.jobId }; };
  remote._startJob = async options => { job = options; return { jobId: options.jobId }; };
  const options = { projectPath: '/project', jobId: 'fixture', conversationId: 'conversation', prompt: 'Fixture', mode: 'edit', sessionId: 'previous', model: 'opus', effort: 'high' };
  await remote.startPersistentChat(options);
  assert.equal(task.model, 'opus'); assert.equal(task.effort, 'high'); assert.equal(task.sessionId, 'previous');
  await remote.startChat(options);
  assert.match(job.command, /'--model' 'opus'/); assert.match(job.command, /'--effort' 'high'/);
  task = undefined;
  await assert.rejects(remote.startPersistentChat({ ...options, effort: 'xhigh' }), /不支持/);
  assert.equal(task, undefined);
});

test('task polling can transport a complete saved event larger than 4 MB', async () => {
  const remote = new RemoteClient(); remote._directory = async value => value;
  const result = { task: { state: 'completed' }, events: [{ type: 'event', event: { text: 'X'.repeat(5 * 1024 * 1024) } }], cursor: 1, more: false };
  remote._execCapture = async (_command, options) => {
    const stdout = JSON.stringify(result);
    assert.ok(Buffer.byteLength(stdout) <= options.maxBytes);
    return { code: 0, stdout };
  };
  assert.deepEqual(await remote.pollTask({ projectPath: '/project', jobId: 'fixture' }), result);
});
