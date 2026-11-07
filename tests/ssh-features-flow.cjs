'use strict';
// Optional Windows/WSL integration. Uses an ephemeral SSH server and Linux test
// processes; never logs into a user's device or sends a model request.
const { Server, Client, utils } = require('ssh2');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { RemoteClient } = require('../electron/remote.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const linuxPath = file => '/mnt/' + file[0].toLowerCase() + file.slice(2).replaceAll('\\', '/');
const python = code => { const result = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'python3', '-c', code], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };
async function main() {
  const fixtureSource = linuxPath(path.resolve('tests/task-runner-test.py'));
  const fixture = JSON.parse(python(`import importlib.util,json,tempfile,pathlib,shlex
spec=importlib.util.spec_from_file_location('fixture',${JSON.stringify(fixtureSource)})
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root=pathlib.Path(tempfile.mkdtemp(prefix='cloude-ssh-test-'))
project=root/'project'; project.mkdir()
cli=root/'claude-fixture'; cli.write_text(module.FAKE); cli.chmod(0o700)
envfile=root/'shell-env'; envfile.write_text('export HOME='+shlex.quote(str(root))+'\\n')
print(json.dumps({'root':str(root),'project':str(project),'cli':str(cli),'envfile':str(envfile)}))`));
  const key = utils.generateKeyPairSync('ed25519'); const peers = new Set(); const children = new Set();
  const ssh = new Server({ hostKeys: [key.private] }, client => {
    peers.add(client); client.on('error', () => {}); client.on('close', () => peers.delete(client));
    client.on('authentication', context => context.username === 'fixture' && context.method === 'password' && context.password === 'fixture-only' ? context.accept() : context.reject());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.());
        session.on('exec', (accept, reject, info) => {
          const channel = accept();
          const child = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'env', 'HOME=' + fixture.root, 'BASH_ENV=' + fixture.envfile, 'bash', '-c', info.command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          children.add(child); child.stdin.on('error', () => {}); channel.on('error', () => {});
          child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false }); channel.pipe(child.stdin);
          child.on('close', code => { children.delete(child); try { channel.exit(code || 0); channel.end(); } catch {} });
          session.on('signal', (_accept, _reject, info) => { if (['INT', 'TERM'].includes(info.name)) child.kill(); });
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        const socket = net.connect(info.destPort, '127.0.0.1', () => { const channel = accept(); channel.pipe(socket).pipe(channel); });
        socket.on('error', () => reject());
      });
    });
  });
  await new Promise(resolve => ssh.listen(0, '127.0.0.1', resolve));
  const events = []; const remote = new RemoteClient({ emit: event => events.push(event) });
  // Filesystem path confinement is covered by remote.test.cjs; this fixture
  // isolates the actual SSH exec/PTY/tunnel boundary and task supervisor.
  remote._directory = async value => { assert.equal(value, fixture.project); return value; };
  async function connect() {
    const client = new Client(); client.on('error', () => {});
    await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: '127.0.0.1', port: ssh.address().port, username: 'fixture', password: 'fixture-only', hostVerifier: () => true }); });
    remote.client = client; remote.sftp = {}; remote.claudePath = fixture.cli;
  }
  async function waitState(state, jobId = 'ssh-task') { let latest; for (let i = 0; i < 30; i++) { latest = await remote.pollTask({ projectPath: fixture.project, jobId, cursor: 0 }); if (latest.task.state === state) return latest; await pause(150); } throw new Error('Task state: ' + JSON.stringify(latest.task)); }
  let echo;
  try {
    await connect();
    await remote.startPersistentChat({ projectPath: fixture.project, jobId: 'ssh-task', conversationId: 'ssh-conversation', prompt: 'question', mode: 'edit', askCommands: true });
    await waitState('waiting'); await remote.disconnect();
    await pause(300); await connect();
    const restored = await waitState('waiting'); assert.equal(restored.task.pendingRequests[0].request_id, 'question-1');
    await remote.replyTask({ projectPath: fixture.project, jobId: 'ssh-task', requestId: 'question-1', allow: true, answers: { 'Which option?': 'B' } });
    const finished = await waitState('completed'); assert.equal(finished.events.filter(e => e.event?.type === 'result').length, 1);
    console.log('PASS actual SSH disconnect/reconnect preserves the same task and waiting question');
    await remote.disconnect(); await connect();
    await remote.startPersistentChat({ projectPath: fixture.project, jobId: 'ssh-followup', conversationId: 'ssh-conversation', sessionId: finished.task.sessionId, prompt: 'second turn', mode: 'edit' });
    const followup = await waitState('completed', 'ssh-followup');
    assert.equal(followup.task.processReused, true);
    assert.equal(followup.task.pid, finished.task.pid);
    assert.deepEqual(followup.events.filter(e => e.event?.type === 'assistant').map(e => e.event.fixture_prompt), ['second turn']);
    assert.deepEqual((await remote.pollTask({ projectPath: fixture.project, jobId: 'ssh-task', cursor: finished.cursor })).events, []);
    console.log('PASS completed session reuses the same Claude process after SSH reconnect without replaying the first prompt');
    await remote.openTerminal({ jobId: 'shell', projectPath: fixture.project, cols: 80, rows: 24 });
    await remote.writeJob('shell', 'export CLOUDE_FIXTURE_VALUE=retained; cd ..\n');
    await pause(200);
    await remote.writeJob('shell', 'printf "STATE=%s DIR=%s\\n" "$CLOUDE_FIXTURE_VALUE" "$PWD"\n');
    for (let i = 0; i < 30 && !events.some(e => e.data?.includes('STATE=retained DIR=' + fixture.root)); i++) await pause(100);
    assert.ok(events.some(e => e.data?.includes('STATE=retained DIR=' + fixture.root)));
    await remote.writeJob('shell', 'exit\n');
    console.log('PASS actual SSH shell retains exported variables and working directory across inputs');
    echo = net.createServer(socket => socket.pipe(socket)); await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
    const tunnel = await remote.forwardPort({ remotePort: echo.address().port });
    const socket = net.connect(tunnel.localPort, '127.0.0.1'); await new Promise(resolve => socket.once('connect', resolve));
    const response = new Promise(resolve => socket.once('data', resolve)); socket.write('ssh tunnel verified'); assert.equal(String(await response), 'ssh tunnel verified'); socket.destroy();
    console.log('PASS actual SSH direct-tcpip forwards bytes through a loopback-only port');
  } finally {
    await remote.disconnect(); for (const peer of peers) peer.end(); for (const child of children) child.kill(); ssh.close(); echo?.close();
    python(`import pathlib,shutil,json,time
root=pathlib.Path(${JSON.stringify(fixture.root)})
assert root.parent==pathlib.Path('/tmp') and root.name.startswith('cloude-ssh-test-')
workers=list((root/'.cloude-tasks').glob('*/*/worker.json'))
for p in workers: p.with_name('retire').touch()
deadline=time.monotonic()+8
while time.monotonic()<deadline and any(json.loads(p.read_text())['state']!='closed' for p in workers): time.sleep(0.1)
shutil.rmtree(root)`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
