'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { RemoteClient } = require('../electron/remote.cjs');
const { LocalSftp } = require('./helpers/local-sftp.cjs');

test('mounting an existing external project permits only the selected tree and works with upload checks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-project-mount-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = new RemoteClient();
  remote.client = {}; remote.sftp = new LocalSftp(root);
  remote.home = '/home/tester'; remote.workspace = '/home/tester/work'; remote.workspaceInput = remote.workspace;
  await fs.mkdir(remote.sftp.native('/home/tester/work'), { recursive: true });
  await fs.mkdir(remote.sftp.native('/home/tester/example-project'), { recursive: true });
  await fs.mkdir(remote.sftp.native('/home/tester/other'), { recursive: true });
  await fs.writeFile(remote.sftp.native('/home/tester/example-project/code.py'), 'print(1)');
  await assert.rejects(remote.listFiles('/home/tester/example-project'), /工作目录/);
  assert.equal((await remote.openProject('/home/tester/example-project')).path, '/home/tester/example-project');
  assert.equal((await remote.listFiles('/home/tester/example-project'))[0].name, 'code.py');
  assert.equal((await remote.inspectUploadPath('/home/tester/example-project/new.txt')), null);
  await assert.rejects(remote.listFiles('/home/tester/other'), /工作目录/);
  remote.sftp.links.set('/home/tester/example-project/escape', '/home/tester/other');
  await fs.writeFile(remote.sftp.native('/home/tester/other/file'), 'outside');
  await assert.rejects(remote.readFile('/home/tester/example-project/escape/file'), /工作目录外/);
  await assert.rejects(remote.openProject('/'), /项目文件夹/);
});

test('remote history command is quoted, read-only and never starts Claude', async () => {
  const remote = new RemoteClient();
  remote._directory = async value => value;
  let command;
  remote._execCapture = async value => { command = value; return { code: 0, stdout: '{"sessions":[]}' }; };
  await remote.listSessions("/home/tester/work/a'b;$(false)");
  assert.match(command, /^'python3' '-c'/);
  assert.ok(command.includes("'/home/tester/work/a'\\''b;$(false)'"));
  assert.doesNotMatch(command, /exec 'claude'/);
  await assert.rejects(remote.readSession('/work', '../../.credentials'), /ID/);
});

test('transcript reader lists matching sessions and previews the active branch with bounded text', async t => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-session-reader-'));
  // Windows TEMP can use an 8.3 alias; the reader derives its slug from the real project path.
  const root = await fs.realpath(temporaryRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'original-project');
  const config = path.join(root, 'claude');
  const directory = path.join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(project);
  const file = path.join(directory, 'original-session.jsonl');
  const row = (uuid, parentUuid, type, text, extra = {}) => ({ uuid, parentUuid, type, cwd: project, sessionId: 'original-session', message: { role: type, content: [{ type: 'text', text }] }, ...extra });
  const rows = [row('first', null, 'user', '原项目的问题'), row('old', 'first', 'assistant', 'abandoned branch'),
    row('answer', 'first', 'assistant', '原来的回答'), row('side', 'answer', 'assistant', 'subagent', { isSidechain: true }),
    { type: 'assistant', message: 'invalid but tolerated' }, row('follow', 'answer', 'user', '下一步'),
    { type: 'custom-title', customTitle: '原有机器人项目' }];
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n{broken partial');
  const source = await fs.readFile(path.resolve(__dirname, '../electron/session-reader.py'), 'utf8');
  const read = (operation, id = '') => {
    const result = spawnSync('python', ['-c', source, project, operation, id], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const list = read('list');
  assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].title, '原有机器人项目');
  const loaded = read('read', 'original-session');
  assert.deepEqual(loaded.messages.map(m => m.content), ['原项目的问题', '原来的回答', '下一步']);
  const more = Array.from({ length: 240 }, (_, i) => row('m' + i, i ? 'm' + (i - 1) : 'follow', i % 2 ? 'assistant' : 'user', '记录'.repeat(1000)));
  await fs.appendFile(file, '\n' + more.map(JSON.stringify).join('\n'));
  const bounded = read('read', 'original-session');
  assert.equal(bounded.truncated, true); assert.ok(bounded.messages.length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 700000);
  assert.equal(bounded.messages.at(-1).id, 'm239');
  await fs.writeFile(file, JSON.stringify(row('x', null, 'user', 'unrelated', { cwd: path.join(root, 'other') })));
  assert.equal(read('list').sessions.length, 0);
});
