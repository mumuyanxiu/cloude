'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Server, utils } = require('ssh2');
const { RemoteClient, shellQuote, isWithin, expandPath, JsonLines, claudeCommand, MAX_TEXT_BYTES } = require('../electron/remote.cjs');
const { createUploadPlan, executeUploadPlan } = require('../electron/uploads.cjs');

const { LocalSftp } = require('./helpers/local-sftp.cjs');

test('pasted private keys fail before filesystem or connection changes without exposing their contents', async t => {
  const remote = new RemoteClient({ clientFactory: () => { throw new Error('must not create SSH client'); } });
  let disconnects = 0;
  remote.disconnect = async () => { disconnects++; };
  t.mock.method(fsp, 'stat', async () => { throw new Error('must not inspect a pasted key as a path'); });
  const marker = kind => ['-----BEGIN', kind, 'PRIVATE KEY-----'].filter(Boolean).join(' ');
  const secret = 'synthetic-key-body-never-log';
  for (const input of [
    `${marker('OPENSSH')}\n${secret}\n-----END OPENSSH PRIVATE KEY-----`,
    `${marker('RSA')} ${secret}`,
    `${marker('EC')}\r\n${secret}`,
    `${marker('ENCRYPTED')} ${secret}`,
    `${marker('')} ${secret}`,
    `PuTTY-User-Key-File-3: ssh-ed25519\n${secret}`,
    `b3BlbnNzaC1rZXktdjE${secret}`,
  ]) {
    await assert.rejects(remote.connect({ host: 'fixture', username: 'tester', authType: 'key', privateKeyPath: input }), error => {
      assert.match(error.message, /需要私钥文件路径/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  assert.equal(disconnects, 0);
  assert.equal(fsp.stat.mock.callCount(), 0);
});

test('missing private key file reports a recoverable error without echoing its input', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-missing-key-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const remote = new RemoteClient();
  await assert.rejects(remote.connect({ host: 'fixture', username: 'tester', authType: 'key', privateKeyPath: path.join(dir, 'missing') }), error => {
    assert.match(error.message, /找不到私钥文件/);
    assert.ok(!error.message.includes(dir));
    return true;
  });
  assert.equal(remote.connecting, false);
  assert.equal(remote.client, null);
});

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-remote-test-'));
  t.after(async () => { if (path.basename(root).startsWith('workspace-remote-test-')) await fsp.rm(root, { recursive: true, force: true }); });
  await fsp.mkdir(path.join(root, 'home', 'tester', 'work'), { recursive: true });
  await fsp.mkdir(path.join(root, 'secrets'), { recursive: true });
  const events = [];
  const remote = new RemoteClient({ emit: event => events.push(event) });
  remote.client = {};
  remote.sftp = new LocalSftp(root);
  remote.home = '/home/tester'; remote.workspace = '/home/tester/work'; remote.workspaceInput = remote.workspace;
  return { root, remote, events, sftp: remote.sftp, file: value => remote.sftp.native(value) };
}

test('shell quoting treats apostrophes, substitutions and newlines as literal arguments', () => {
  assert.equal(shellQuote("/tmp/a'b;$(touch bad)\n"), "'/tmp/a'\\''b;$(touch bad)\n'");
  assert.throws(() => shellQuote('a\0b'));
  assert.equal(expandPath('~/work/../work/demo', '/home/tester', '/x'), '/home/tester/work/demo');
  assert.equal(isWithin('/home/tester/work', '/home/tester/work/a'), true);
  assert.equal(isWithin('/home/tester/work', '/home/tester/work-other'), false);
  assert.equal(isWithin('/home/tester/work', '/home/tester'), false);
});

test('Claude commands inherit remote permissions and preserve explicit session IDs', () => {
  const command = claudeCommand({ executable: '/home/tester/a b/claude', projectPath: "/home/tester/work/a'b", mode: 'edit', sessionId: 'test-123', allowCommands: false });
  assert.match(command, /'--resume' 'test-123'/);
  assert.doesNotMatch(command, /--permission-mode|--allowedTools|--disallowedTools/);
  assert.doesNotMatch(command, /dangerously-skip|bypassPermissions/);
  assert.doesNotMatch(claudeCommand({ executable: 'claude', projectPath: '/work', mode: 'edit', allowCommands: true }), /--permission-mode|--allowedTools|--disallowedTools/);
  const plan = claudeCommand({ executable: 'claude', projectPath: '/work', mode: 'plan' });
  assert.match(plan, /'--permission-mode' 'plan'/);
  assert.doesNotMatch(plan, /--allowedTools|--disallowedTools/);
  assert.throws(() => claudeCommand({ executable: 'claude', projectPath: '/work', mode: 'edit', sessionId: 'foo;bar' }));
});

test('JSON streaming survives byte-split Chinese text and ignores startup diagnostics', () => {
  const events = []; const notes = [];
  const parser = new JsonLines(event => events.push(event), text => notes.push(text));
  const payload = Buffer.from('startup notice\n' + JSON.stringify({ type: 'assistant', text: '你好，远程设备！' }) + '\n' + JSON.stringify({ type: 'result', session_id: 'test' }));
  for (const byte of payload) parser.push(Buffer.from([byte]));
  parser.end();
  assert.equal(events[0].text, '你好，远程设备！');
  assert.equal(events[1].session_id, 'test');
  assert.deepEqual(notes, ['startup notice\n']);
});

test('model and effort overrides reach Claude without changing inherited defaults', () => {
  const options = { executable: 'claude', projectPath: '/work', mode: 'edit' };
  assert.doesNotMatch(claudeCommand(options), /--model|--effort|CLAUDE_CODE_EFFORT_LEVEL/);
  const command = claudeCommand({ ...options, model: "gateway/model's;$(literal)", effort: 'high' });
  assert.ok(command.includes("'--model' " + shellQuote("gateway/model's;$(literal)")));
  assert.match(command, /'--effort' 'high'/);
  assert.match(command, /export CLAUDE_CODE_EFFORT_LEVEL='high'/);
  assert.doesNotMatch(command, /--permission-mode|--allowedTools/);
  for (const model of [null, 42, 'bad model', 'bad\nmodel', 'x'.repeat(121)]) {
    assert.throws(() => claudeCommand({ ...options, model }));
  }
  for (const effort of [null, 'invalid', 'high;echo']) {
    assert.throws(() => claudeCommand({ ...options, effort }));
  }
});

test('workspace checks reject traversal, sibling-prefix and symlink escapes', async t => {
  const { remote, file, sftp } = await fixture(t);
  await fsp.writeFile(file('/secrets/token'), 'secret');
  sftp.links.set('/home/tester/work/link', '/secrets');
  await assert.rejects(remote.resolvePath('../elsewhere'), /工作目录/);
  await assert.rejects(remote.resolvePath('/home/tester/work-other/file'), /工作目录/);
  await assert.rejects(remote.readFile('/home/tester/work/link/token'), /符号链接/);
  await assert.rejects(remote.saveFile('/home/tester/work/link/new.txt', 'x'), /工作目录外/);
  assert.equal(await fsp.readFile(file('/secrets/token'), 'utf8'), 'secret');
});

test('dangling symlinks cannot create files outside the workspace', async t => {
  const { remote, sftp, root } = await fixture(t);
  sftp.links.set('/home/tester/work/dangling', '/secrets/not-yet-created');
  await assert.rejects(remote.saveFile('/home/tester/work/dangling', 'bad'), /符号链接/);
  await assert.rejects(fsp.access(path.join(root, 'secrets', 'not-yet-created')));
});

test('text reads and saves preserve Unicode and detect same-second remote edits', async t => {
  const { remote, file } = await fixture(t);
  const target = '/home/tester/work/demo.py';
  await fsp.writeFile(file(target), 'print("你好")\n');
  const opened = await remote.readFile(target);
  assert.equal(opened.content, 'print("你好")\n');
  await fsp.writeFile(file(target), 'print("再见")\n');
  await fsp.utimes(file(target), opened.mtime, opened.mtime);
  await assert.rejects(remote.saveFile(target, 'new', opened.mtime), /远端修改/);
  const refreshed = await remote.readFile(target);
  await remote.saveFile(target, 'print("更新")\n', refreshed.mtime);
  assert.equal(await fsp.readFile(file(target), 'utf8'), 'print("更新")\n');
  assert.equal((await fsp.readdir(path.dirname(file(target)))).some(name => name.startsWith('.workspace-save')), false);
});

test('create-only empty file uses exclusive creation and preserves an existing file', async t => {
  const { remote, file } = await fixture(t);
  const target = '/home/tester/work/new.py';
  const created = await remote.saveFile(target, '', null);
  assert.equal(created.size, 0);
  await fsp.writeFile(file(target), 'keep this content');
  await assert.rejects(remote.saveFile(target, '', null), /同名文件已存在/);
  assert.equal(await fsp.readFile(file(target), 'utf8'), 'keep this content');
});

test('create-only does not overwrite a file created after path validation', async t => {
  const { remote, sftp, file } = await fixture(t);
  const target = '/home/tester/work/racing.py';
  const originalWrite = sftp.writeFile.bind(sftp);
  sftp.writeFile = (remotePath, data, options, callback) => {
    fsp.writeFile(file(target), 'created concurrently').then(() => originalWrite(remotePath, data, options, callback), callback);
  };
  await assert.rejects(remote.saveFile(target, '', null), /同名文件已存在/);
  assert.equal(await fsp.readFile(file(target), 'utf8'), 'created concurrently');
});

test('large and binary files are refused by text editor without blocking download', async t => {
  const { remote, file, root } = await fixture(t);
  await fsp.writeFile(file('/home/tester/work/binary.bin'), Buffer.from([0, 1, 2, 255]));
  await assert.rejects(remote.readFile('/home/tester/work/binary.bin'), /二进制/);
  await fsp.writeFile(file('/home/tester/work/large.txt'), Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
  await assert.rejects(remote.readFile('/home/tester/work/large.txt'), /超过 2 MB/);
  const destination = path.join(root, 'download.bin');
  await remote.download('/home/tester/work/binary.bin', destination);
  assert.deepEqual(await fsp.readFile(destination), Buffer.from([0, 1, 2, 255]));
});

test('completed downloads retain byte integrity and emit final progress', async t => {
  const { remote, file, root, events } = await fixture(t);
  const content = crypto.randomBytes(150123);
  await fsp.writeFile(file('/home/tester/work/result.bin'), content);
  const destination = path.join(root, 'download.bin');
  await fsp.writeFile(destination, 'old content');
  const result = await remote.download('/home/tester/work/result.bin', destination);
  assert.equal(result.bytes, content.length);
  assert.deepEqual(await fsp.readFile(destination), content);
  assert.equal(events.at(-1).transferred, content.length);
  assert.equal(events.at(-1).direction, 'download');
  assert.equal((await fsp.readdir(root)).some(name => name.endsWith('.partial')), false);
});

test('failed download preserves an existing Windows file and removes partial data', async t => {
  const { remote, file, root, sftp } = await fixture(t);
  await fsp.writeFile(file('/home/tester/work/result.txt'), 'remote content');
  const destination = path.join(root, 'existing.txt');
  await fsp.writeFile(destination, 'keep me');
  sftp.failReads = true;
  await assert.rejects(remote.download('/home/tester/work/result.txt', destination), /simulated transport/);
  assert.equal(await fsp.readFile(destination, 'utf8'), 'keep me');
  assert.equal((await fsp.readdir(root)).some(name => name.endsWith('.partial')), false);
});

test('upload preserves bytes and refuses accidental overwrite', async t => {
  const { remote, root, file } = await fixture(t);
  const source = path.join(root, '上传.txt');
  await fsp.writeFile(source, '上传数据\n');
  const target = await remote.upload(source, '/home/tester/work');
  assert.equal(target, '/home/tester/work/上传.txt');
  assert.equal(await fsp.readFile(file(target), 'utf8'), '上传数据\n');
  await assert.rejects(remote.upload(source, '/home/tester/work'), /已有/);
  await fsp.writeFile(source, '明确覆盖的新内容');
  await remote.upload(source, '/home/tester/work', { overwrite: true });
  assert.equal(await fsp.readFile(file(target), 'utf8'), '明确覆盖的新内容');
});

test('explicit upload overwrite still rejects a symlink target', async t => {
  const { remote, root, sftp, file } = await fixture(t);
  const source = path.join(root, 'linked.txt');
  await fsp.writeFile(source, 'replacement');
  await fsp.writeFile(file('/secrets/linked.txt'), 'original');
  sftp.links.set('/home/tester/work/linked.txt', '/secrets/linked.txt');
  await assert.rejects(remote.upload(source, '/home/tester/work', { overwrite: true }), /符号链接/);
  assert.equal(await fsp.readFile(file('/secrets/linked.txt'), 'utf8'), 'original');
});

test('an in-flight operation cannot continue after the SFTP connection changes', async t => {
  const { remote, sftp, root, file } = await fixture(t);
  await fsp.writeFile(file('/home/tester/work/code.py'), 'original');
  const originalStat = sftp.stat.bind(sftp);
  sftp.stat = (remotePath, callback) => originalStat(remotePath, (error, result) => {
    remote.generation++;
    remote.sftp = new LocalSftp(root);
    callback(error, result);
  });
  await assert.rejects(remote.saveFile('/home/tester/work/code.py', 'replacement'), /连接已发生变化/);
  assert.equal(await fsp.readFile(sftp.native('/home/tester/work/code.py'), 'utf8'), 'original');
});

test('disconnect clears a pending job reservation and a late exec cannot start it', async () => {
  const remote = new RemoteClient();
  let execCallback;
  remote.client = { exec(command, options, callback) { execCallback = callback; }, end() {} };
  remote.sftp = {};
  const pending = remote._startJob({ jobId: 'pending', conversationId: 'conversation', kind: 'chat', command: 'test', input: 'message', pty: false });
  assert.equal(remote.jobs.size, 1);
  await remote.disconnect();
  assert.equal(remote.jobs.size, 0);
  let closed = false;
  execCallback(null, { close() { closed = true; } });
  await assert.rejects(pending, /连接已断开/);
  assert.equal(closed, true);
});

// This server exercises the real ssh2 handshake and SFTP wire protocol on loopback.
// It does not contact 远程设备 and does not execute any real shell command.
async function startProtocolServer(t, adapter, allowedKey = null) {
  const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const connections = new Set(); const seen = { prompts: [], commands: [], modelRequests: [] };
  const server = new Server({ hostKeys: [privateKey] }, client => {
    connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', ctx => {
      if (ctx.username !== 'tester') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'test-only') return ctx.accept();
      if (ctx.method === 'publickey' && allowedKey && ctx.key.algo === allowedKey.type
          && ctx.key.data.equals(allowedKey.getPublicSSH())
          && (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
      ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', acceptSftp => {
        const stream = acceptSftp(); const handles = new Map(); let nextHandle = 0;
        const respond = (id, error, result, kind) => error ? stream.status(id, error.code === 2 ? 2 : 4, error.message) : kind === 'attrs' ? stream.attrs(id, result) : stream.status(id, 0);
        stream.on('REALPATH', (id, remote) => adapter.realpath(remote, (error, actual) => error ? stream.status(id, 2) : stream.name(id, [{ filename: actual, longname: actual, attrs: {} }])));
        stream.on('STAT', (id, remote) => adapter.stat(remote, (error, attrs) => respond(id, error, attrs, 'attrs')));
        stream.on('LSTAT', (id, remote) => adapter.lstat(remote, (error, attrs) => respond(id, error, attrs, 'attrs')));
        stream.on('MKDIR', (id, remote, attrs) => adapter.mkdir(remote, attrs, error => respond(id, error)));
        stream.on('OPEN', async (id, remote, flags) => {
          try { const file = await fsp.open(adapter.native(remote), utils.sftp.flagsToString(flags)); const handle = Buffer.from(String(++nextHandle)); handles.set(handle.toString(), file); stream.handle(id, handle); }
          catch (error) { stream.status(id, error.code === 'ENOENT' ? 2 : 4); }
        });
        stream.on('FSTAT', (id, handle) => { const file = handles.get(handle.toString()); if (!file) return stream.status(id, 4); file.stat().then(stats => stream.attrs(id, adapter.attrs(stats)), () => stream.status(id, 4)); });
        stream.on('READ', async (id, handle, offset, length) => {
          try { const buffer = Buffer.alloc(length); const { bytesRead } = await handles.get(handle.toString()).read(buffer, 0, length, offset); bytesRead ? stream.data(id, buffer.subarray(0, bytesRead)) : stream.status(id, 1); }
          catch { stream.status(id, 4); }
        });
        stream.on('WRITE', async (id, handle, offset, data) => { try { await handles.get(handle.toString()).write(data, 0, data.length, offset); stream.status(id, 0); } catch { stream.status(id, 4); } });
        stream.on('CLOSE', async (id, handle) => { try { await handles.get(handle.toString()).close(); handles.delete(handle.toString()); stream.status(id, 0); } catch { stream.status(id, 4); } });
        stream.on('REMOVE', (id, remote) => adapter.unlink(remote, error => respond(id, error)));
        stream.on('RENAME', (id, from, to) => adapter.rename(from, to, error => respond(id, error)));
        stream.on('end', () => { for (const file of handles.values()) file.close().catch(() => {}); });
      });
      session.on('exec', (acceptExec, reject, info) => {
        const stream = acceptExec(); seen.commands.push(info.command);
        if (info.command.includes('--version')) { stream.exit(0); stream.end('local-test\n2.1.test\n'); return; }
        if (info.command.includes('--no-session-persistence') && info.command.includes('--input-format')) {
          let buffer = '';
          stream.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (!buffer.includes('\n')) return;
            const request = JSON.parse(buffer.trim()); seen.modelRequests.push(request); buffer = '';
            stream.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: [{ value: 'fable', displayName: 'Fable fixture', description: 'Protocol fixture' }] } } }) + '\n');
          });
          return;
        }
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          seen.prompts.push(Buffer.concat(chunks).toString('utf8'));
          const output = Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'local-test-session' }) + '\n' + JSON.stringify({ type: 'result', result: '本地协议测试完成', session_id: 'local-test-session' }) + '\n');
          stream.write(output.subarray(0, 149)); stream.write(output.subarray(149)); stream.exit(0); stream.end();
        });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const connection of connections) connection.end(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, seen };
}

test('real loopback SSH verifies host key, downloads via SFTP and streams a Claude session', async t => {
  const { root, sftp } = await fixture(t);
  const content = crypto.randomBytes(100003);
  await fsp.writeFile(sftp.native('/home/tester/work/protocol.bin'), content);
  const { port, seen } = await startProtocolServer(t, sftp);
  const events = []; let hostVerified = false;
  const remote = new RemoteClient({ emit: event => events.push(event), verifyHost: async ({ fingerprint }) => { hostVerified = /^SHA256:[A-Za-z0-9+/]+$/.test(fingerprint); return true; } });
  t.after(() => remote.disconnect());
  const config = { host: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'test-only', workspace: '~/work', claudePath: 'claude' };
  const info = await remote.connect(config);
  assert.equal(hostVerified, true);
  assert.equal(info.workspace, '/home/tester/work');
  assert.equal(info.claudeAvailable, true);
  await remote.download('/home/tester/work/protocol.bin', path.join(root, 'protocol-result.bin'));
  assert.deepEqual(await fsp.readFile(path.join(root, 'protocol-result.bin')), content);
  await remote.startChat({ jobId: 'job-test', conversationId: 'conversation-test', projectPath: '/home/tester/work', prompt: '你好 $(do-not-execute)', mode: 'plan' });
  const deadline = Date.now() + 3000;
  while (!events.some(event => event.type === 'exit') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(seen.prompts[0], '你好 $(do-not-execute)');
  assert.equal(seen.commands.some(command => command.includes('do-not-execute')), false);
  assert.equal(events.find(event => event.event?.type === 'result').event.result, '本地协议测试完成');
  assert.equal(events.find(event => event.type === 'exit').code, 0);
  await remote.disconnect();
});

test('model discovery performs only the initialize handshake over real loopback SSH', async t => {
  const { sftp } = await fixture(t);
  const { port, seen } = await startProtocolServer(t, sftp);
  const remote = new RemoteClient({ verifyHost: async () => true });
  t.after(() => remote.disconnect());
  await remote.connect({ host: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'test-only', workspace: '~/work' });
  const result = await remote.getModels('/home/tester/work');
  assert.equal(result.models[0].value, 'fable');
  assert.equal(seen.modelRequests.length, 1);
  assert.equal(seen.modelRequests[0].request.subtype, 'initialize');
  assert.deepEqual(seen.prompts, []);
});

test('a selected private key file still authenticates over real loopback SSH', async t => {
  const { root, sftp } = await fixture(t);
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const keyPath = path.join(root, 'selected private key');
  await fsp.writeFile(keyPath, key);
  const { port } = await startProtocolServer(t, sftp, utils.parseKey(key));
  const remote = new RemoteClient({ verifyHost: async () => true });
  t.after(() => remote.disconnect());
  const info = await remote.connect({ host: '127.0.0.1', port, username: 'tester', authType: 'key', privateKeyPath: keyPath, workspace: '~/work' });
  assert.equal(info.hostname, 'local-test');
  assert.equal(info.claudeAvailable, true);
  assert.equal(await fsp.readFile(keyPath, 'utf8'), key);
});

test('untrusted SSH host is rejected before any workspace or execution operation', async t => {
  const { sftp } = await fixture(t);
  const { port, seen } = await startProtocolServer(t, sftp);
  const remote = new RemoteClient({ verifyHost: async () => false });
  await assert.rejects(remote.connect({ host: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'test-only', workspace: '~/work' }), /连接失败/);
  assert.equal(seen.commands.length, 0);
});

test('folder upload preserves nested binary files and empty directories over real loopback SFTP', async t => {
  const { root, sftp } = await fixture(t);
  const source = path.join(root, '协议 上传');
  await fsp.mkdir(path.join(source, '数据 子目录'), { recursive: true });
  await fsp.mkdir(path.join(source, '空目录'));
  const binary = crypto.randomBytes(65543);
  await fsp.writeFile(path.join(source, '数据 子目录', '模型.bin'), binary);
  await fsp.writeFile(path.join(source, '说明.txt'), '嵌套文件夹协议验证\n');
  const { port } = await startProtocolServer(t, sftp);
  const remote = new RemoteClient({ verifyHost: async () => true });
  t.after(() => remote.disconnect());
  await remote.connect({ host: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'test-only', workspace: '~/work', claudePath: 'claude' });
  const plan = await createUploadPlan(remote, { directory: '/home/tester/work', localPaths: [source], kind: 'folder' });
  assert.deepEqual(plan.conflicts, []);
  const result = await executeUploadPlan(remote, plan);
  const destination = '/home/tester/work/协议 上传';
  assert.deepEqual(result.folders, [destination]);
  assert.equal(result.files.length, 2);
  assert.deepEqual(await fsp.readFile(sftp.native(`${destination}/数据 子目录/模型.bin`)), binary);
  assert.equal(await fsp.readFile(sftp.native(`${destination}/说明.txt`), 'utf8'), '嵌套文件夹协议验证\n');
  assert.ok((await fsp.stat(sftp.native(`${destination}/空目录`))).isDirectory());
  assert.deepEqual(await fsp.readdir(sftp.native(`${destination}/空目录`)), []);
});
