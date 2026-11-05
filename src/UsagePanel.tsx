import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Gauge, RefreshCw } from 'lucide-react';
import { api, errorText } from './api';
import type { AccountUsage } from './types';
import './usage.css';

type UsagePanelProps = { connectionKey: string | null; refreshToken: number; visible: boolean; revealToken?: number };
const refreshInterval = 5 * 60 * 1000;
const percentage = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const usageTimeZone = 'Asia/Shanghai';

function fullTimeLabel(value: string | number | null) {
  if (value === null) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toLocaleString('zh-CN', { timeZone: usageTimeZone, hour12: false })}（UTC+8）`
    : undefined;
}

function resetLabel(value: string | null, now: number) {
  if (!value) return '重置时间未提供';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '重置时间未提供';
  if (date.getTime() <= now) return '已到重置时间 · 待刷新';
  return `重置于 ${date.toLocaleString('zh-CN', { timeZone: usageTimeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}（UTC+8）`;
}

export function UsagePanel({ connectionKey, refreshToken, visible, revealToken = 0 }: UsagePanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [report, setUsage] = useState<(AccountUsage & { connectionKey: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const control = useRef({ generation: 0, key: null as string | null, busy: false, pending: false, mounted: false });
  const previousRefreshToken = useRef(refreshToken);
  const previousRevealToken = useRef(revealToken);
  const usage = report?.connectionKey === connectionKey ? report : null;

  // Keep requests serial even when a previous device disconnects mid-request.
  // The generation check prevents that response from appearing for a new device.
  const refresh = useCallback(async function requestUsage() {
    const current = control.current;
    if (!current.mounted || !current.key) return;
    if (current.busy) { current.pending = true; setLoading(true); return; }
    current.busy = true;
    const generation = current.generation;
    setLoading(true); setError('');
    try {
      const result = await api.getUsage();
      if (!current.mounted || generation !== current.generation) return;
      const limits = result.limits?.filter(limit => Number.isFinite(limit.percent) && limit.percent >= 0) || [];
      if (!result.available || !limits.length) {
        setError(result.message || '当前账户暂未返回额度信息。');
        return;
      }
      setUsage({ ...result, limits, connectionKey: current.key! }); setNow(Date.now());
    } catch (reason) {
      if (current.mounted && generation === current.generation) setError(errorText(reason));
    } finally {
      current.busy = false;
      if (current.mounted && generation === current.generation) setLoading(false);
      if (current.pending && current.mounted && current.key) {
        current.pending = false;
        void requestUsage();
      }
    }
  }, []);

  useEffect(() => {
    const current = control.current;
    current.generation++; current.key = connectionKey; current.mounted = true; current.pending = false;
    setUsage(null); setError(''); setLoading(false);
    if (connectionKey) void refresh();
    return () => { current.generation++; current.key = null; current.mounted = false; current.pending = false; };
  }, [connectionKey, refresh]);

  useEffect(() => {
    if (previousRevealToken.current === revealToken) return;
    previousRevealToken.current = revealToken;
    setExpanded(true); setNow(Date.now());
  }, [revealToken]);

  useEffect(() => {
    if (previousRefreshToken.current === refreshToken) return;
    previousRefreshToken.current = refreshToken;
    if (connectionKey) void refresh();
  }, [refreshToken, connectionKey, refresh]);

  useEffect(() => {
    if (!connectionKey || !expanded || !visible) return;
    const polling = setInterval(() => void refresh(), refreshInterval);
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(polling); clearInterval(clock); };
  }, [connectionKey, expanded, visible, refresh]);

  const updated = usage && Number.isFinite(usage.fetchedAt) ? new Date(usage.fetchedAt) : null;
  return <section className={`usage-card ${expanded ? 'expanded' : 'collapsed'}`} aria-label="Claude 账户额度">
    <div className="usage-heading">
      <button className="usage-toggle" onClick={() => { setExpanded(value => !value); setNow(Date.now()); }} aria-label={expanded ? '收起账户额度' : '展开账户额度'} aria-expanded={expanded} aria-controls="account-usage-details">
        <Gauge size={14} /><span>账户额度</span><ChevronDown size={12} className={expanded ? '' : 'rotated'} />
      </button>
      <button className="usage-refresh" aria-label="刷新账户额度" title="刷新账户额度" disabled={!connectionKey || loading} onClick={() => void refresh()}><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>
    </div>
    {expanded && <div id="account-usage-details" className="usage-body">
      {!connectionKey ? <p className="usage-message">连接后查看额度</p> : <>
        {usage ? <div className="usage-limits">{usage.limits.map((limit, index) => {
          const percent = percentage.format(limit.percent);
          const reset = resetLabel(limit.resetsAt, now);
          return <div className={`usage-limit ${limit.percent >= 90 ? 'near-limit' : ''}`} key={`${limit.kind}:${limit.group}:${index}`}>
            <div className="usage-limit-heading"><span title={limit.label}>{limit.label}</span><strong>{percent}<small>% 已用</small></strong></div>
            <div className="usage-meter" role="meter" aria-label={`${limit.label}已使用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, limit.percent)} aria-valuetext={`${percent}% 已使用`}><span style={{ width: `${Math.min(100, limit.percent)}%` }} /></div>
            <p className="usage-reset" title={fullTimeLabel(limit.resetsAt)}>{reset}</p>
          </div>;
        })}</div> : <p className={`usage-message ${error ? 'usage-error' : ''}`} role="status">{error || (loading ? '正在读取账户额度…' : '尚未读取账户额度')}</p>}
        {usage && error && <p className="usage-error usage-refresh-error" role="status"><strong>刷新失败</strong><span>{error}</span></p>}
        {usage && <div className="usage-footer"><span title={fullTimeLabel(updated?.getTime() ?? null)}>{updated ? `更新于 ${updated.toLocaleTimeString('zh-CN', { timeZone: usageTimeZone, hour: '2-digit', minute: '2-digit', hour12: false })}（UTC+8）` : '更新时间未提供'}</span><span>{loading ? '刷新中…' : 'Claude 账户'}</span></div>}
      </>}
    </div>}
  </section>;
}
