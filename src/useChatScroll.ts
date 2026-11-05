import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Keep the user's reading position while output, images or tool results grow.
export function useChatScroll(conversationId: string | undefined, messages: unknown) {
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);

  const scrollToLatest = useCallback(() => {
    following.current = true;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      lastTop.current = viewport.scrollTop;
    }
    setShowLatest(false);
  }, [viewport]);

  const onScroll = useCallback(() => {
    if (!viewport) return;
    const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
    if (atBottom) following.current = true;
    else if (viewport.scrollTop < lastTop.current - 1) following.current = false;
    lastTop.current = viewport.scrollTop;
    setShowLatest(!following.current && !atBottom);
  }, [viewport]);

  const followOutput = useCallback(() => {
    if (!viewport) return;
    // A streamed update can arrive between the native scroll and its event.
    // Notice upward movement before writing scrollTop in that same frame.
    if (viewport.scrollTop < lastTop.current - 1 &&
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2) following.current = false;
    if (following.current) scrollToLatest();
    else setShowLatest(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2);
  }, [viewport, scrollToLatest]);

  useLayoutEffect(() => { scrollToLatest(); }, [conversationId, scrollToLatest]);
  useLayoutEffect(() => { followOutput(); }, [messages, followOutput]);
  useLayoutEffect(() => {
    if (!viewport || !content) return;
    const observer = new ResizeObserver(followOutput);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [viewport, content, followOutput]);

  return { viewportRef, contentRef, onScroll, scrollToLatest, showLatest };
}
