'use strict';

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function normalizeModels(models) {
  if (!Array.isArray(models) || models.length > 500) throw new Error('远端未返回有效模型列表，请更新 Claude Code 后重试。');
  const result = []; const seen = new Set();
  for (const model of models) {
    if (!model || typeof model.value !== 'string' || !model.value || model.value.length > 120 || /[\s\x00-\x1f\x7f]/.test(model.value) || model.value === 'custom' || seen.has(model.value)) continue;
    seen.add(model.value);
    const entry = { value: model.value, displayName: typeof model.displayName === 'string' ? model.displayName.slice(0, 200) : model.value,
      description: typeof model.description === 'string' ? model.description.slice(0, 1000) : '' };
    if (typeof model.supportsEffort === 'boolean') entry.supportsEffort = model.supportsEffort;
    if (Array.isArray(model.supportedEffortLevels)) entry.supportedEffortLevels = EFFORT_LEVELS.filter(level => model.supportedEffortLevels.includes(level));
    result.push(entry);
  }
  return result;
}

function modelListCommand(executable, directory, quote) {
  const args = [executable, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return `export PATH="$HOME/.local/bin:$PATH"; export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1; cd -- ${quote(directory)} && exec ${args.map(quote).join(' ')}`;
}

// The Agent SDK's supportedModels() reads models from this initialize response.
// Keep stdin open for the handshake, send no user message, and stop the process
// immediately afterwards. Never forward account data or CLI diagnostics.
function queryModels(client, command, { timeout = 20000, assertCurrent = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `cloude-models-${crypto.randomUUID()}`;
    let channel; let settled = false; let bytes = 0; let buffer = '';
    const decoder = new StringDecoder('utf8');
    const stop = stream => {
      try { stream.signal('TERM'); } catch { /* Already closed. */ }
      try { stream.close(); } catch { /* Already closed. */ }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); client.off('close', onDisconnect);
      if (channel) stop(channel);
      if (error) reject(error); else resolve(result);
    };
    const onDisconnect = () => finish(new Error('SSH 已断开，请重新连接后刷新模型列表。'));
    const timer = setTimeout(() => finish(new Error('读取远端模型列表超时，请重试。')), timeout);
    client.once('close', onDisconnect);
    try {
      client.exec(command, (error, stream) => {
        if (settled) { if (stream) { stream.on('error', () => {}); stop(stream); } return; }
        if (error) return finish(new Error('无法启动远端模型查询，请检查 Claude 命令。'));
        channel = stream;
        const consume = chunk => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { finish(new Error('远端模型列表响应过大。')); return false; }
          return true;
        };
        stream.on('error', () => finish(new Error('读取远端模型列表失败，请重试。')));
        stream.on('close', () => finish(new Error('远端未返回模型列表，请检查登录状态和 Claude Code 版本。')));
        stream.stderr.on('data', consume);
        stream.on('data', chunk => {
          if (settled || !consume(chunk)) return;
          buffer += decoder.write(chunk);
          let newline;
          while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event?.type !== 'control_response' || event.response?.request_id !== requestId) continue;
            if (event.response.subtype !== 'success') return finish(new Error('远端不支持模型查询，请更新 Claude Code 后重试。'));
            try {
              assertCurrent();
              finish(null, { models: normalizeModels(event.response.response?.models), fetchedAt: Date.now() });
            } catch (error) { finish(error); }
          }
        });
        try {
          assertCurrent();
          stream.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] } }) + '\n');
        } catch { finish(new Error('连接已变化，请重新读取模型列表。')); }
      });
    } catch { finish(new Error('无法启动远端模型查询，请重试。')); }
  });
}

module.exports = { normalizeModels, modelListCommand, queryModels };
