import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api, errorText } from './api';
import { Modal, Spinner } from './components';
import type { UpdateState } from './types';
import './updates.css';

export function UpdateControl({ blocked }: { blocked: boolean }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    let active = true;
    const unsubscribe = api.onEvent(event => { if (event.kind === 'update' && event.update) setState(event.update); });
    void api.getUpdateState().then(value => { if (active) setState(value); }).catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const action = async (operation: () => Promise<unknown>) => {
    setError('');
    try { await operation(); } catch (reason) { setError(errorText(reason)); }
  };
  const install = async () => {
    setInstalling(true);
    await action(() => api.installUpdate());
    setInstalling(false);
  };
  const busy = state?.status === 'checking' || state?.status === 'downloading' || installing;
  const available = state?.status === 'available' || state?.status === 'downloaded';
  const statusText = !state ? '正在读取版本…' : ({
    unsupported: '开发模式', idle: '检查新版本', checking: '正在检查更新…',
    latest: '已是最新版本', available: `发现新版本 ${state.version}`,
    downloading: `正在下载 ${Math.round(state.percent)}%`, downloaded: `版本 ${state.version} 已就绪`, error: '更新未完成',
  })[state.status];
  return <>
    <button className="sidebar-settings" onClick={() => setOpen(true)}><RefreshCw size={16} />应用更新<span>{available ? '有更新' : state?.currentVersion ? `v${state.currentVersion}` : ''}</span></button>
    {open && <Modal title="应用更新" subtitle={state?.currentVersion ? `当前版本 ${state.currentVersion}` : undefined} onClose={() => { if (!installing) setOpen(false); }}>
      <p className="update-status" role="status">{busy && <Spinner />}{statusText}</p>
      {state?.status === 'downloading' && <progress className="update-progress" aria-label="更新下载进度" max={100} value={state.percent} />}
      {(error || (state?.status === 'error' && state.message)) && <div className="form-error" role="alert">{error || state?.message}</div>}
      {state?.status === 'downloaded' && blocked && <p className="form-help">保存文件并完成当前任务后，即可重启安装。</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => void action(() => api.openReleases())}>下载页面</button><div>
        {state?.status === 'unsupported' ? null
          : state?.status === 'downloaded' ? <button className="primary-button" disabled={blocked || installing} onClick={() => void install()}>重启并安装</button>
          : state?.status === 'available' ? <button className="primary-button" disabled={busy} onClick={() => void action(() => api.downloadUpdate())}><Download size={15} />下载更新</button>
          : <button className="primary-button" disabled={!state || busy} onClick={() => void action(() => api.checkForUpdates())}>{busy ? <Spinner /> : <RefreshCw size={15} />}检查更新</button>}
      </div></div>
    </Modal>}
  </>;
}
