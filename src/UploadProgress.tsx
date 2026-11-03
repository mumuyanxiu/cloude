import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { formatBytes } from './api';
import { Spinner } from './components';
import type { UploadProgressData } from './types';
import './upload-progress.css';

const phaseLabels: Record<UploadProgressData['phase'], string> = {
  selecting: '选择要上传的内容', scanning: '正在扫描本地文件', checking: '正在检查目标目录',
  confirming: '等待确认同名文件', preparing: '正在准备上传', uploading: '正在上传',
  committing: '正在确认写入', verifying: '正在核对上传结果', complete: '上传完成',
};

export function UploadProgress({ progress }: { progress: UploadProgressData }) {
  const [now, setNow] = useState(Date.now());
  const bytes = progress.bytesTransferred || 0;
  const total = progress.bytesTotal || 0;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const transferring = ['uploading', 'committing', 'verifying', 'complete'].includes(progress.phase);
  const percent = progress.phase === 'complete' ? 100 : total > 0 ? Math.min(99, Math.floor(bytes / total * 100)) : null;
  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const idle = Math.max(0, Math.floor((now - progress.updatedAt) / 1000));
  const waiting = idle >= 15 && !['selecting', 'confirming', 'complete'].includes(progress.phase);
  const transferSeconds = progress.transferStartedAt === undefined ? 0 : Math.max(0, (now - progress.transferStartedAt) / 1000);
  const speed = transferSeconds >= 1 && bytes > 0 ? formatBytes(bytes / transferSeconds) + '/s' : '计算中…';

  return <section className={`upload-progress ${waiting ? 'waiting' : ''}`} aria-label="上传进度">
    <div className="upload-progress-heading"><span><Upload size={15} />{phaseLabels[progress.phase]}</span><strong>{transferring && percent !== null ? `${percent}%` : <Spinner />}</strong></div>
    {progress.name && <div className="upload-progress-name" title={progress.name}>{progress.name}</div>}
    <div className={`upload-progress-track ${!transferring || percent === null ? 'indeterminate' : ''}`}
      role="progressbar" aria-label="上传总进度" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={transferring && percent !== null ? percent : undefined}>
      <span style={transferring && percent !== null ? { width: `${percent}%` } : undefined} />
    </div>
    <div className="upload-progress-metrics">
      <span>{transferring ? `${formatBytes(bytes)} / ${formatBytes(total)}` : progress.entriesProcessed !== undefined ? `已检查 ${progress.entriesProcessed}${progress.entriesTotal !== undefined ? ` / ${progress.entriesTotal}` : ''} 项` : '等待选择文件…'}</span>
      <span>{transferring ? `文件 ${progress.filesCompleted || 0} / ${progress.filesTotal || 0}` : progress.filesTotal !== undefined ? `${progress.filesTotal} 个文件` : ''}</span>
    </div>
    {transferring && progress.fileTotal !== undefined && <div className="upload-progress-detail">当前文件 {formatBytes(progress.fileTransferred || 0)} / {formatBytes(progress.fileTotal)}</div>}
    <div className="upload-progress-metrics upload-progress-secondary"><span>{transferring ? `平均 ${speed}` : phaseLabels[progress.phase]}</span><span>已用 {elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ` : ''}{elapsed % 60} 秒</span></div>
    {waiting && <p className="upload-progress-wait" role="status">已 {idle} 秒没有进度更新，正在等待响应。请检查 设备连接或磁盘状态。</p>}
  </section>;
}
