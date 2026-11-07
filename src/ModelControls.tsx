import { Brain, Cpu, RefreshCw } from 'lucide-react';
import type { ClaudeEffort, ClaudeModel } from './types';
import './model-controls.css';

export const effortChoices: ClaudeEffort[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const effortLabels: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };

export function ModelControls({ model, customModel, effort, disabled, onModel, onCustomModel, onEffort, models, connected, loading, error, refresh }: {
  model: string; customModel: string; effort: ClaudeEffort; disabled: boolean;
  models: ClaudeModel[]; connected: boolean; loading: boolean; error: string; refresh: () => void;
  onModel: (value: string) => void; onCustomModel: (value: string) => void; onEffort: (value: ClaudeEffort) => void;
}) {
  const selected = models.find(item => item.value === (model === 'custom' ? customModel.trim() : model));
  const levels = selected?.supportsEffort === false ? [] : selected?.supportedEffortLevels ?? effortChoices.filter(value => value !== '');
  const missingModel = model && model !== 'custom' && !models.some(item => item.value === model);
  const unsupportedEffort = !!effort && !levels.includes(effort);
  const changeModel = (value: string) => {
    onModel(value);
    const next = models.find(item => item.value === value);
    if (effort && (next?.supportsEffort === false || next?.supportedEffortLevels && !next.supportedEffortLevels.includes(effort))) onEffort('');
  };
  return <div className="model-controls">
    <label><Cpu size={13} /><span>模型</span><select aria-label="Claude 模型" value={model} disabled={disabled} onChange={e => changeModel(e.target.value)} title={selected?.description}>
      <option value="">跟随远端</option>
      {models.map(item => <option key={item.value} value={item.value}>{item.displayName}</option>)}
      {missingModel && <option value={model}>{model}（{loading ? '正在核对' : '未在远端列表中'}）</option>}
      <option value="custom">自定义模型…</option>
    </select></label>
    <button type="button" className="model-refresh" aria-label="刷新远端模型列表" title="刷新远端 Claude Code 模型列表" disabled={!connected || loading || disabled} onClick={refresh}><RefreshCw size={12} /></button>
    <label title="更高强度通常需要更多时间和额度；支持的强度由远端 CLI 和模型决定。"><Brain size={13} /><span>思考强度</span><select aria-label="Claude 思考强度" value={effort} disabled={disabled} onChange={e => onEffort(e.target.value as ClaudeEffort)}>
      <option value="">跟随远端</option>{levels.map(value => <option key={value} value={value}>{effortLabels[value]}</option>)}
      {unsupportedEffort && <option value={effort}>{effortLabels[effort]}（当前模型不支持）</option>}
    </select></label>
    {model === 'custom' && <input className="custom-model" aria-label="自定义模型 ID" value={customModel} disabled={disabled} maxLength={120} onChange={e => onCustomModel(e.target.value)} placeholder="输入模型 ID 或网关部署名" />}
    <span className="model-controls-note">{disabled ? '完成当前操作后可更改' : '对下一条消息生效'}</span>
    <span className={`model-catalog-status${error ? ' error' : ''}`} role="status">{!connected ? '连接后读取远端模型列表' : loading ? '正在读取远端模型…' : error ? `${error} 可刷新重试或使用自定义模型。` : models.length ? '模型列表来自远端 Claude Code' : '远端未列出模型，可刷新重试或使用自定义模型。'}</span>
  </div>;
}
