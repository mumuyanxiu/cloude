import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { api, errorText, id } from './api';
import type { AppState, ConnectionInfo, Conversation, Project } from './types';

export function useProjectHistory({ project, conversation, connection, generation, stateRef, setState, setActiveConversationId }: {
  project?: Project; conversation?: Conversation; connection: ConnectionInfo | null; generation: number;
  stateRef: RefObject<AppState>; setState: Dispatch<SetStateAction<AppState>>;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
}) {
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState({ loading: false, error: '', warning: '' });
  const [reading, setReading] = useState({ id: '', error: '' });
  const refresh = () => setRevision(value => value + 1);

  useEffect(() => {
    if (!project || !connection) { setListing({ loading: false, error: '', warning: '' }); return; }
    let canceled = false;
    const target = project;
    setListing({ loading: true, error: '', warning: '' });
    void api.listSessions({ projectPath: target.path }).then(result => {
      if (canceled) return;
      const existing = stateRef.current.conversations.filter(item => item.projectId === target.id);
      const discovered: Conversation[] = result.sessions.map(session =>
        existing.find(item => item.sessionId === session.sessionId) || {
          ...session, id: id(), projectId: target.id, messages: [], historyLoaded: false,
        });
      setState(current => ({ ...current, conversations: [...current.conversations, ...discovered.filter(item =>
        !current.conversations.some(old => old.projectId === target.id && old.sessionId === item.sessionId))] }));
      const latest = [...existing, ...discovered].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      // Do not replace a selection or a new conversation created while listing.
      if (latest) setActiveConversationId(current => current || latest.id);
      setListing({ loading: false, error: '', warning: result.warning || '' });
    }).catch(error => { if (!canceled) setListing({ loading: false, error: errorText(error), warning: '' }); });
    return () => { canceled = true; };
  }, [project?.id, project?.path, connection, generation, revision, setState, setActiveConversationId, stateRef]);

  useEffect(() => {
    if (!project || !connection || !conversation?.sessionId || conversation.projectId !== project.id || conversation.historyLoaded !== false) {
      setReading({ id: '', error: '' }); return;
    }
    let canceled = false;
    const target = conversation;
    setReading({ id: target.id, error: '' });
    void api.readSession({ projectPath: project.path, sessionId: target.sessionId! }).then(result => {
      if (canceled) return;
      setState(current => ({ ...current, conversations: current.conversations.map(item =>
        item.id === target.id && item.historyLoaded === false ? {
          ...item, messages: result.messages, historyLoaded: true, historyNotice: result.notice,
        } : item) }));
    }).catch(error => { if (!canceled) setReading({ id: target.id, error: errorText(error) }); });
    return () => { canceled = true; };
  }, [project?.id, project?.path, conversation?.id, conversation?.sessionId, conversation?.historyLoaded, connection, generation, revision, setState]);

  return { ...listing, readError: reading.id === conversation?.id ? reading.error : '', refresh };
}
