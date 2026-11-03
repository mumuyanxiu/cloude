import { baseName, shellQuote } from './api';

export interface CommandSuggestion { id: string; command: string; description: string; local?: boolean }
export const chatCommands: CommandSuggestion[] = [
  { id: 'help', command: '/help', description: '查看工作台常用命令与快捷键', local: true },
  { id: 'clear', command: '/clear', description: '开始新对话，保留已有聊天记录', local: true },
  { id: 'usage', command: '/usage', description: '展开并刷新账户额度', local: true },
  { id: 'permissions', command: '/permissions', description: '打开工作台权限设置', local: true },
  { id: 'compact', command: '/compact', description: '让 Claude 压缩当前对话上下文' },
  { id: 'context', command: '/context', description: '查看当前会话的上下文占用' },
  { id: 'init', command: '/init', description: '让 Claude 为项目准备 CLAUDE.md' },
  { id: 'review', command: '/review', description: '让 Claude 检查当前代码改动' },
];

const commonTerminalCommands: CommandSuggestion[] = [
  { id: 'pwd', command: 'pwd', description: '查看当前工作目录' },
  { id: 'ls', command: 'ls -la', description: '列出目录内容，包含隐藏文件' },
  { id: 'date', command: 'date', description: '查看 远程设备 系统时间与时区' },
  { id: 'git-status', command: 'git status', description: '查看 Git 工作区状态' },
  { id: 'git-diff', command: 'git diff', description: '查看尚未暂存的代码改动' },
  { id: 'python-version', command: 'python3 --version', description: '查看 Python 版本' },
  { id: 'python-main', command: 'python3 main.py', description: '运行项目中的 main.py' },
  { id: 'ros-topics', command: 'ros2 topic list', description: '列出 ROS 2 话题' },
  { id: 'ros-nodes', command: 'ros2 node list', description: '列出 ROS 2 节点' },
  { id: 'colcon', command: 'colcon build', description: '构建当前 ROS 2 工作区' },
];

export function terminalCommands(openFilePath?: string): CommandSuggestion[] {
  if (!openFilePath?.endsWith('.py')) return commonTerminalCommands;
  return [{ id: 'run-open-file', command: `python3 ${shellQuote(openFilePath)}`, description: `运行当前文件 ${baseName(openFilePath)}` }, ...commonTerminalCommands];
}

export function localChatCommand(text: string) {
  const command = text.trim().split(/\s/, 1)[0].toLowerCase();
  return chatCommands.find(item => item.local && item.command === command)?.id;
}

export function fillCommand(value: string, command: string, mode: 'chat' | 'terminal') {
  if (!value.trim()) return command;
  if (mode === 'chat') {
    if (/^\/\S*/.test(value)) return command + value.replace(/^\/\S*/, '');
    return `${command} ${value}`;
  }
  const words = [...value.matchAll(/\S+/g)];
  const template = [...command.matchAll(/\S+/g)];
  let consumed = 0;
  while (consumed < words.length && consumed < template.length && template[consumed][0].startsWith(words[consumed][0])) consumed++;
  if (!consumed) return `${command} ${value}`;
  if (consumed === words.length) return command;
  const suffix = value.slice(words[consumed - 1].index! + words[consumed - 1][0].length);
  const completedPrefix = command.slice(0, template[consumed - 1].index! + template[consumed - 1][0].length);
  return completedPrefix + suffix;
}
