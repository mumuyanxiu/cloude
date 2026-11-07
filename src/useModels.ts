import { useEffect, useState } from 'react';
import { api, errorText } from './api';
import type { ModelCatalog } from './types';

export function useModels(connected: boolean, generation: number, projectPath?: string) {
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([connected, generation, projectPath, revision]);
  const [result, setResult] = useState<{ key: string; catalog?: ModelCatalog; error?: string }>();
  useEffect(() => {
    if (!connected) return;
    let canceled = false;
    void api.getModels({ projectPath }).then(catalog => {
      if (!canceled) setResult({ key, catalog });
    }).catch(error => { if (!canceled) setResult({ key, error: errorText(error) }); });
    return () => { canceled = true; };
  }, [key]);
  const current = connected && result?.key === key ? result : undefined;
  return { models: current?.catalog?.models ?? [], loading: connected && !current,
    error: current?.error ?? '', refresh: () => setRevision(value => value + 1) };
}
