import { Brain, Cpu } from 'lucide-react';
import type { ClaudeEffort } from './types';
import './model-controls.css';

export const modelChoices = ['', 'sonnet', 'opus', 'haiku', 'opusplan', 'custom'];
export const effortChoices: ClaudeEffort[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

export function ModelControls({ model, customModel, effort, disabled, onModel, onCustomModel, onEffort }: {
  model: string; customModel: string; effort: ClaudeEffort; disabled: boolean;
  onModel: (value: string) => void; onCustomModel: (value: string) => void; onEffort: (value: ClaudeEffort) => void;
}) {
  return <div className="model-controls">
    <label><Cpu size={13} /><span>模型</span><select aria-label="Claude 模型" value={model} disabled={disabled} onChange={e => onModel(e.target.value)}>
      <option value="">跟随远端</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option><option value="opusplan">Opus 计划 / Sonnet 执行</option><option value="custom">自定义模型…</option>
    </select></label>
    <label title="更高强度通常需要更多时间和额度；支持的强度由远端 CLI 和模型决定。"><Brain size={13} /><span>思考强度</span><select aria-label="Claude 思考强度" value={effort} disabled={disabled} onChange={e => onEffort(e.target.value as ClaudeEffort)}>
      <option value="">跟随远端</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">超高</option><option value="max">最高</option>
    </select></label>
    {model === 'custom' && <input className="custom-model" aria-label="自定义模型 ID" value={customModel} disabled={disabled} maxLength={120} onChange={e => onCustomModel(e.target.value)} placeholder="输入模型 ID 或网关部署名" />}
    <span className="model-controls-note">{disabled ? '完成当前操作后可更改' : '对下一条消息生效'}</span>
  </div>;
}
