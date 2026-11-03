import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { fillCommand, type CommandSuggestion } from './commands';
import './commands.css';

type InputElement = HTMLInputElement | HTMLTextAreaElement;
type Options = { value: string; onChange(value: string): void; commands: CommandSuggestion[]; inputRef: RefObject<InputElement | null>; mode: 'chat' | 'terminal'; disabled?: boolean };

export function isComposingInput(event: KeyboardEvent<InputElement>) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export function useCommandSuggestions({ value, onChange, commands, inputRef, mode, disabled = false }: Options) {
  const [manual, setManual] = useState(false);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const previousValue = useRef(value);
  const prefix = mode === 'chat' ? value : value.trimStart();
  const eligible = mode === 'chat' ? /^\/[^\s]*$/.test(prefix) : !!prefix.trim();
  const options = commands.filter(item => manual || (mode === 'chat' ? item.command.toLowerCase().startsWith(prefix.toLowerCase()) : item.command.startsWith(prefix)));
  const visible = !disabled && (manual || eligible) && value !== dismissedValue && options.length > 0;
  const index = Math.min(activeIndex, Math.max(options.length - 1, 0));
  const listId = mode === 'chat' ? 'chat-command-suggestions' : 'terminal-command-suggestions';

  useEffect(() => {
    if (previousValue.current !== value) {
      previousValue.current = value; setActiveIndex(0); setManual(false);
      if (dismissedValue !== value) setDismissedValue(null);
    }
  }, [value, dismissedValue]);
  useEffect(() => { if (disabled) { setManual(false); setDismissedValue(value); } }, [disabled]);

  const close = () => { setManual(false); setDismissedValue(value); };
  const choose = (item: CommandSuggestion) => {
    const completed = fillCommand(value, item.command, mode);
    onChange(completed); setManual(false); setDismissedValue(completed); setActiveIndex(0);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(completed.length, completed.length); });
  };
  const toggle = () => {
    if (disabled) return;
    if (visible) close();
    else { setManual(true); setDismissedValue(null); setActiveIndex(0); inputRef.current?.focus(); }
  };
  const handleKeyDown = (event: KeyboardEvent<InputElement>) => {
    if (!visible || disabled || isComposingInput(event) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActiveIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); return true;
    }
    if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); choose(options[index]); return true; }
    if (event.key === 'Escape') { event.preventDefault(); close(); return true; }
    return false;
  };

  return { visible, options, activeIndex: index, listId, choose, toggle, close, handleKeyDown, activeDescendant: visible ? `${listId}-${options[index].id}` : undefined };
}

type Controller = ReturnType<typeof useCommandSuggestions>;
export function CommandSuggestions({ controller, label, className = '' }: { controller: Controller; label: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (controller.visible) container.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [controller.visible, controller.activeIndex]);
  if (!controller.visible) return null;
  return <div className={`command-menu ${className}`}>
    <div className="command-menu-heading"><span>{label}</span><small>↑↓ 选择 · Tab / Enter 填入</small></div>
    <div className="command-menu-options" role="listbox" aria-label={label} id={controller.listId} ref={container}>
      {controller.options.map((item, index) => <button type="button" role="option" tabIndex={-1} id={`${controller.listId}-${item.id}`} aria-selected={index === controller.activeIndex} className={index === controller.activeIndex ? 'selected' : ''} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => controller.choose(item)}><span><code>{item.command}</code>{item.local && <small>工作台</small>}</span><span className="command-description">{item.description}</span></button>)}
    </div>
    <div className="command-menu-caption">填入后确认内容，再发送或运行 · Esc 收起</div>
  </div>;
}
