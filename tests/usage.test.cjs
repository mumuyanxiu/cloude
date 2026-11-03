const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseUsageOutput, supportsUsageVersion } = require('../electron/usage.cjs');
const { RemoteClient, usageCommand, shellQuote } = require('../electron/remote.cjs');

const row = (percent = 42) => ({ kind: 'session', group: 'session', percent, resets_at: '2026-10-30T18:00:00Z', severity: 'normal', is_active: true });
const stream = limits => JSON.stringify({ type: 'assistant', usage_report: { rate_limits: { limits } } });
const success = limits => ({ code: 0, stdout: stream(limits), stderr: '' });
function client() {
  const remote = new RemoteClient({});
  remote.client = { end() {} };
  remote.sftp = {};
  remote.home = '/home/tester';
  remote.claudeVersion = '2.1.314 (Claude Code)';
  return remote;
}

test('structured account windows preserve zero percent, order, scopes, and server severity', () => {
  const output = parseUsageOutput(stream([
    row(0), { ...row(62.5), kind: 'weekly_all', group: 'weekly', severity: 'warning' },
    { ...row(11), kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Opus' } }, resets_at: null },
    { ...row(7), kind: 'future_meter', group: 'future', scope: { surface: { display_name: 'Desktop' } } },
  ]), 12345);
  assert.equal(output.available, true);
  assert.equal(output.fetchedAt, 12345);
  assert.deepEqual(output.limits.map(item => item.percent), [0, 62.5, 11, 7]);
  assert.equal(output.limits[1].severity, 'warning');
  assert.equal(output.limits[2].label, '每周 · Opus');
  assert.equal(output.limits[2].resetsAt, null);
  assert.equal(output.limits[3].kind, 'future_meter');
});

test('plain answers, missing data, invalid rows and failed requests never become zero usage', () => {
  for (const stdout of [
    '五小时额度已使用 0%，每周使用 20%',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'usage_report: 42%' }] } }),
    stream(null), stream([]), stream([{ ...row(), percent: '42' }]), stream([{ ...row(), percent: 101 }]),
    stream([row()]) + '\n' + JSON.stringify({ type: 'result', is_error: true }),
  ]) {
    const result = parseUsageOutput(stdout);
    assert.equal(result.available, false);
    assert.deepEqual(result.limits, []);
  }
});

test('a newer unavailable report replaces earlier rows and explicit null never revives legacy data', () => {
  const newer = JSON.stringify({ type: 'assistant', usage_report: { rate_limits: null } });
  assert.equal(parseUsageOutput(stream([row()]) + '\n' + newer).available, false);
  const mixed = { limits: null, five_hour: { utilization: 80 } };
  assert.equal(parseUsageOutput(JSON.stringify({ type: 'assistant', usage_report: { rate_limits: mixed } })).available, false);
  const legacy = { five_hour: { utilization: 0, resets_at: 'bad-date' }, seven_day: { utilization: 30, resets_at: null } };
  const result = parseUsageOutput(JSON.stringify({ type: 'assistant', usage_report: { rate_limits: legacy } }));
  assert.deepEqual(result.limits.map(item => item.percent), [0, 30]);
  assert.equal(result.limits[0].resetsAt, null);
});

test('usage command is fixed, quoted, nonpersistent and does not issue a natural-language task', () => {
  const executable = "/home/tester/Claude's binary";
  const directory = '/home/tester/a; touch injected';
  const command = usageCommand(executable, directory);
  assert.ok(command.includes(`cd -- ${shellQuote(directory)} && exec ${shellQuote(executable)}`));
  assert.ok(command.includes("'-p' '/usage'"));
  for (const argument of ['--output-format', 'stream-json', '--no-session-persistence', '--max-turns', '--tools', '--strict-mcp-config']) assert.ok(command.includes(shellQuote(argument)));
  assert.ok(command.includes("'--tools' ''"));
  assert.ok(command.includes(shellQuote('{"disableAllHooks":true}')));
  assert.ok(command.includes(shellQuote('{"mcpServers":{}}')));
  assert.ok(!command.includes('--bare'));
  assert.ok(!command.includes('--disable-slash-commands'));
  assert.ok(!command.includes('--resume'));
});

test('unsupported versions do not start a Claude process', async () => {
  for (const version of ['', 'unknown', '2.1.313 (Claude Code)', '1.9.999']) {
    const remote = client(); remote.claudeVersion = version;
    remote._execCapture = () => { throw new Error('must not execute'); };
    assert.equal((await remote.getUsage()).available, false);
  }
  for (const version of ['2.1.314 (Claude Code)', '2.1.315', '2.2.0', '3.0.0']) assert.equal(supportsUsageVersion(version), true);
});

test('simultaneous reads share one bounded request, successful data caches, failures do not use stale rows', async () => {
  const remote = client();
  let resolve; let count = 0;
  remote._execCapture = (command, options) => {
    count++;
    assert.ok(command.includes("'/usage'"));
    assert.deepEqual(options, { maxBytes: 512 * 1024, timeout: 20000 });
    return new Promise(done => { resolve = done; });
  };
  const first = remote.getUsage(); const second = remote.getUsage();
  assert.equal(count, 1);
  resolve(success([row(55)]));
  assert.deepEqual(await first, await second);
  assert.equal((await remote.getUsage()).limits[0].percent, 55);
  assert.equal(count, 1);
  remote.usageCache.at -= 31000;
  remote._execCapture = async () => { count++; return { code: 1, stdout: '', stderr: 'fixture failure' }; };
  assert.equal((await remote.getUsage()).available, false);
  assert.equal((await remote.getUsage()).available, false);
  assert.equal(count, 3);
});

test('late response from another connection is discarded and cannot populate the current cache', async () => {
  const remote = client();
  let resolve;
  remote._execCapture = () => new Promise(done => { resolve = done; });
  const pending = remote.getUsage();
  remote.generation++;
  remote.sftp = {};
  resolve(success([row(99)]));
  await assert.rejects(pending, /连接已发生变化|连接已变化/);
  assert.equal(remote.usageCache, null);
  remote._execCapture = async () => success([row(3)]);
  assert.equal((await remote.getUsage()).limits[0].percent, 3);
});

test('capture timeout closes its SSH channel instead of leaving a pending usage request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = client();
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  let closed = false;
  channel.end = () => {};
  channel.close = () => { closed = true; };
  remote.client.exec = (_command, callback) => callback(null, channel);
  const pending = remote.getUsage();
  t.mock.timers.tick(20001);
  await assert.rejects(pending, /超时/);
  assert.equal(closed, true);
  assert.equal(remote.usageFlight, null);
});
