'use strict';

// Conservative compatibility baseline for this workbench, not the feature's
// introduction version. Older/unknown CLIs are never sent a fallback prompt.
const MIN_USAGE_VERSION = [2, 1, 314];
function supportsUsageVersion(version) {
  const match = typeof version === 'string' && version.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== MIN_USAGE_VERSION[index]) return parts[index] > MIN_USAGE_VERSION[index];
  }
  return true;
}

function unavailable(message, fetchedAt = Date.now()) {
  return { available: false, limits: [], fetchedAt, message };
}

function resetTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function rowLabel(row) {
  if (row.kind === 'session') return '五小时用量';
  if (row.kind === 'weekly_all') return '每周总用量';
  const scope = [row.scope?.model?.display_name, row.scope?.surface?.display_name]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.slice(0, 100)).join(' · ');
  if (row.kind === 'weekly_scoped') return scope ? `每周 · ${scope}` : '每周分类用量';
  return scope ? `${row.kind} · ${scope}` : row.kind;
}

function parseRows(rateLimits) {
  if (Object.hasOwn(rateLimits, 'limits')) {
    // An explicit null/empty current reply must never revive legacy/stale rows.
    if (!Array.isArray(rateLimits.limits)) return [];
    return rateLimits.limits.filter(row => row && typeof row.kind === 'string' && row.kind &&
      typeof row.group === 'string' && row.group && typeof row.percent === 'number' &&
      Number.isFinite(row.percent) && row.percent >= 0 && row.percent <= 100).map(row => ({
      kind: row.kind.slice(0, 128), group: row.group.slice(0, 128), percent: row.percent,
      resetsAt: resetTime(row.resets_at), label: rowLabel(row).slice(0, 240),
      ...(typeof row.severity === 'string' ? { severity: row.severity.slice(0, 32) } : {}),
    }));
  }
  // Compatibility for structured reports from a server that predates limits[].
  return [
    ['five_hour', 'session', 'session', '五小时用量'],
    ['seven_day', 'weekly_all', 'weekly', '每周总用量'],
  ].flatMap(([key, kind, group, label]) => {
    const row = rateLimits[key];
    if (!row || typeof row.utilization !== 'number' || !Number.isFinite(row.utilization) || row.utilization < 0 || row.utilization > 100) return [];
    return [{ kind, group, label, percent: row.utilization, resetsAt: resetTime(row.resets_at) }];
  });
}

function parseUsageOutput(stdout, fetchedAt = Date.now()) {
  let report;
  let failed = false;
  for (const line of String(stdout).split(/\r?\n/)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (!message || typeof message !== 'object') continue;
    if (message.type === 'assistant' && Object.hasOwn(message, 'usage_report')) report = message.usage_report;
    if (message.type === 'result' && message.is_error === true) failed = true;
  }
  if (failed) return unavailable('Claude 未能完成额度查询，请稍后重试。', fetchedAt);
  if (!report?.rate_limits || typeof report.rate_limits !== 'object') {
    return unavailable('Claude 未返回账户额度。请确认 远程设备上使用的是 Claude 订阅登录，且登录凭据具备读取用量的权限。', fetchedAt);
  }
  const limits = parseRows(report.rate_limits);
  if (!limits.length) return unavailable('本次查询没有返回可用的账户额度数据，请稍后重试。', fetchedAt);
  return { available: true, limits, fetchedAt };
}

module.exports = { parseUsageOutput, supportsUsageVersion, unavailable };
