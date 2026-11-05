"""Per-task Claude process supervisor. No network listener or privileged service."""
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

MAX_LOG = 32 * 1024 * 1024
# CLI events can contain base64 images, which are larger than the source file.
MAX_OUTPUT_LINE = 64 * 1024 * 1024
MAX_EVENT_LINE = 16 * 1024 * 1024
POLL_BYTES = 1024 * 1024


def display_event(value):
    """Omit binary copies from the display log, never from Claude's input."""
    if isinstance(value, list):
        return [display_event(item) for item in value]
    if isinstance(value, dict):
        return {key: '[base64 数据已省略]' if isinstance(item, str) and
                (key == 'base64' or key == 'data' and value.get('type') == 'base64')
                else display_event(item) for key, item in value.items()}
    return value


def read_output(stream, kind, events):
    try:
        while True:
            line = stream.readline(MAX_OUTPUT_LINE + 1)
            if not line:
                break
            if len(line) > MAX_OUTPUT_LINE:
                events.put(('failure', b'Claude output line exceeds 64 MB'))
                break
            events.put((kind, line))
    except Exception as error:
        events.put(('failure', str(error).encode('utf-8')))
    finally:
        events.put((kind, None))


def read_events(log, cursor):
    records = []
    with open(log, 'rb') as stream:
        stream.seek(cursor)
        while stream.tell() - cursor < POLL_BYTES:
            before = stream.tell()
            line = stream.readline(MAX_EVENT_LINE + 1)
            if len(line) > MAX_EVENT_LINE:
                raise ValueError('单条任务记录超过 16 MB，无法读取')
            if not line or not line.endswith(b'\n'):
                stream.seek(before)
                break
            # Return a large record alone so a poll stays within the SSH limit.
            if records and stream.tell() - cursor > POLL_BYTES:
                stream.seek(before)
                break
            records.append(json.loads(line))
        return records, stream.tell()


def atomic_json(target, value):
    temp = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temp, 'x', encoding='utf-8') as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream, ensure_ascii=False)
    os.replace(temp, target)


def read_json(target):
    if target.is_symlink():
        raise ValueError('任务文件不能是符号链接')
    with open(target, encoding='utf-8') as stream:
        return json.load(stream)


def private_dir(target):
    if target.is_symlink():
        raise ValueError('任务目录不能是符号链接')
    target.mkdir(mode=0o700, exist_ok=True)
    if not target.is_dir() or target.stat().st_uid != os.getuid():
        raise ValueError('任务目录的所有者不正确')
    os.chmod(target, 0o700)
    return target


def task_root(project):
    parent = private_dir(Path.home() / '.cloude-tasks')
    return private_dir(parent / hashlib.sha256(project.encode()).hexdigest()[:32])


def valid_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError('任务或会话标识无效')
    return value


def process_stamp(pid):
    try:
        text = Path('/proc/%s/stat' % pid).read_text()
        return text[text.rfind(')') + 2:].split()[19]
    except (OSError, IndexError):
        return None


def is_alive(status):
    pid = status.get('pid')
    if not pid:
        return status.get('state') == 'starting' and time.time() - status['createdAt'] / 1000 < 30
    try:
        os.kill(pid, 0)
        return not status.get('processStamp') or status['processStamp'] == process_stamp(pid)
    except OSError:
        return False


def snapshot(folder):
    status = read_json(folder / 'status.json')
    if status['state'] in ('starting', 'running', 'waiting') and not is_alive(status):
        status = {**status, 'state': 'interrupted', 'message': '远端进程已离开，保留已完成的输出；可从原会话继续。', 'pendingRequests': []}
    return status


def terminate(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=4)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=4)
    except ProcessLookupError:
        pass


def claude_args(config):
    if config.get('mode') not in ('edit', 'plan'):
        raise ValueError('权限模式无效')
    args = [config['executable'], '-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
            '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio']
    # Normal tasks inherit user/project/local settings, including the default mode.
    # Legacy allowCommands/askCommands values must not add Bash-only overrides.
    if config['mode'] == 'plan':
        args += ['--permission-mode', 'plan']
    if config.get('sessionId'):
        args += ['--resume', valid_id(config['sessionId'])]
    return args


def permission_response(tool, data):
    scope = data.get('scope', 'once')
    if scope not in ('once', 'project') or not isinstance(data.get('allow'), bool):
        raise ValueError('授权选项无效')
    name = tool.get('tool_name', '')
    if scope == 'project' and (data['allow'] is not True or
            name in ('AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode') or
            not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}', name)):
        raise ValueError('此请求不支持项目长期授权')
    if not data['allow']:
        return {'behavior': 'deny', 'message': '用户拒绝了此操作'}
    updated = dict(tool.get('input', {}))
    if name == 'AskUserQuestion':
        answers = data.get('answers', {})
        if not isinstance(answers, dict) or any(not isinstance(v, str) or len(v) > 10000 for v in answers.values()):
            raise ValueError('回答格式无效')
        if any(not answers.get(q['question'], '').strip() for q in updated.get('questions', [])):
            raise ValueError('请回答所有问题')
        updated['answers'] = answers
    response = {'behavior': 'allow', 'updatedInput': updated}
    if scope == 'project':
        # The pending request, not renderer-supplied rules, identifies the tool.
        # Claude persists and applies this via its native protocol, preserving
        # deny/ask rules and resolving the local settings location itself.
        response['updatedPermissions'] = [{'type': 'addRules', 'rules': [{'toolName': name}],
                                           'behavior': 'allow', 'destination': 'localSettings'}]
    return response


def worker(folder):
    config = read_json(folder / 'config.json')
    status = read_json(folder / 'status.json')
    status.update(state='running', pid=os.getpid(), processStamp=process_stamp(os.getpid()), pendingRequests=[])
    atomic_json(folder / 'status.json', status)
    event_file = open(folder / 'events.jsonl', 'ab', buffering=0)
    child = None
    pending = {}
    stopped = False
    result_seen = False

    def save():
        status['updatedAt'] = int(time.time() * 1000)
        status['pendingRequests'] = list(pending.values())
        atomic_json(folder / 'status.json', status)

    def record(event):
        encoded = (json.dumps(display_event(event), ensure_ascii=False) + '\n').encode()
        if len(encoded) > MAX_EVENT_LINE or event_file.tell() + len(encoded) > MAX_LOG:
            raise ValueError('任务输出超过保存限制，请缩小单次任务范围')
        event_file.write(encoded)

    def write(message):
        child.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
        child.stdin.flush()

    try:
        args = claude_args(config)
        env = dict(os.environ)
        env['PATH'] = str(Path.home() / '.local/bin') + ':' + env.get('PATH', '')
        env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = '1'
        child = subprocess.Popen(args, cwd=config['projectPath'], env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        events = queue.Queue(maxsize=256)

        for stream, kind in [(child.stdout, 'stdout'), (child.stderr, 'stderr')]:
            threading.Thread(target=read_output, args=(stream, kind, events), daemon=True).start()
        init_id = 'cloude-init-' + uuid.uuid4().hex
        write({'type': 'control_request', 'request_id': init_id, 'request': {'subtype': 'initialize', 'hooks': {}, 'sdkMcpServers': []}})
        initialized = False
        deadline = time.monotonic() + 60
        streams_closed = 0
        finished_at = None
        while True:
            if (folder / 'stop').exists():
                stopped = True
                terminate(child)
                break
            for answer_path in sorted((folder / 'responses').glob('*.json')):
                answer = read_json(answer_path)
                request_id = answer['response']['request_id']
                if request_id in pending:
                    write(answer)
                    del pending[request_id]
                    status['state'] = 'waiting' if pending else 'running'
                    save()
                answer_path.unlink()
            try:
                kind, line = events.get(timeout=0.15)
            except queue.Empty:
                if not initialized and time.monotonic() > deadline:
                    raise ValueError('Claude 未响应交互协议，请更新远端 Claude Code 后重试')
                if child.poll() is not None and streams_closed >= 2:
                    break
                if finished_at and time.monotonic() - finished_at > 10:
                    terminate(child)
                    break
                continue
            if line is None:
                streams_closed += 1
                continue
            if kind == 'failure':
                raise ValueError(line.decode())
            text = line.decode('utf-8', errors='replace')
            if kind == 'stderr':
                record({'type': 'stderr', 'data': text})
                continue
            try:
                event = json.loads(text)
            except ValueError:
                record({'type': 'stderr', 'data': text})
                continue
            if event.get('type') == 'control_response':
                reply = event.get('response', {})
                if reply.get('request_id') == init_id:
                    if reply.get('subtype') == 'error':
                        raise ValueError(reply.get('error', '交互协议初始化失败'))
                    initialized = True
                    write({'type': 'user', 'message': {'role': 'user', 'content': config['prompt']}, 'parent_tool_use_id': None, 'session_id': config.get('sessionId', '')})
                continue
            if event.get('session_id'):
                status['sessionId'] = event['session_id']
            if event.get('type') == 'control_request':
                request = event.get('request', {})
                if request.get('subtype') != 'can_use_tool':
                    write({'type': 'control_response', 'response': {'subtype': 'error', 'request_id': event['request_id'], 'error': '此客户端尚不支持该交互请求'}})
                    record({'type': 'stderr', 'data': '未支持的交互请求：' + str(request.get('subtype'))})
                else:
                    pending[event['request_id']] = event
                    status['state'] = 'waiting'
                save()
            elif event.get('type') == 'control_cancel_request':
                pending.pop(event.get('request_id'), None)
                status['state'] = 'waiting' if pending else 'running'
                save()
            else:
                record({'type': 'event', 'event': event})
            if event.get('type') == 'result':
                result_seen = True
                status['state'] = 'failed' if event.get('is_error') or event.get('subtype', 'success') != 'success' else 'completed'
                finished_at = time.monotonic()
                child.stdin.close()
                save()
        code = child.wait(timeout=5)
        if stopped:
            status.update(state='stopped', message='已停止远端任务')
        elif not result_seen:
            status.update(state='failed', message='Claude 已退出，未收到完整结果，请查看任务输出')
        status['exitCode'] = code
    except Exception as error:
        status.update(state='failed', message=str(error))
        if child:
            terminate(child)
    finally:
        pending.clear()
        save()
        event_file.close()


def dispatch(data):
    if os.name != 'posix':
        raise ValueError('断线续跑需要 Linux 或 macOS 远端')
    project = os.path.realpath(data['projectPath'])
    if not os.path.isdir(project) or project == '/':
        raise ValueError('项目目录无效')
    root = task_root(project)
    action = data['action']
    if action == 'list':
        tasks = []
        for folder in root.iterdir():
            if folder.is_dir() and not folder.is_symlink() and (folder / 'status.json').exists():
                value = snapshot(folder)
                if value.get('projectPath') == project:
                    tasks.append(value)
        return {'tasks': sorted(tasks, key=lambda item: item['createdAt'], reverse=True)[:100]}
    job_id = valid_id(data['jobId'])
    folder = root / job_id
    if folder.is_symlink():
        raise ValueError('任务目录无效')
    if action == 'start':
        if folder.exists():
            return {'jobId': job_id, 'existing': True, 'task': snapshot(folder)}
        if len([p for p in root.iterdir() if p.is_dir() and (p / 'status.json').exists() and snapshot(p)['state'] in ('starting', 'running', 'waiting')]) >= 4:
            raise ValueError('该项目最多运行 4 个后台任务')
        if data.get('sessionId'):
            valid_id(data['sessionId'])
        folder.mkdir(mode=0o700)
        (folder / 'responses').mkdir(mode=0o700)
        now = int(time.time() * 1000)
        status = {'jobId': job_id, 'conversationId': data.get('conversationId', ''), 'projectPath': project,
                  'title': data.get('title', '')[:80], 'state': 'starting', 'createdAt': now, 'updatedAt': now,
                  'sessionId': data.get('sessionId'), 'pendingRequests': []}
        config = {key: data.get(key) for key in ['executable', 'projectPath', 'prompt', 'sessionId', 'mode']}
        config['projectPath'] = project
        atomic_json(folder / 'config.json', config)
        atomic_json(folder / 'status.json', status)
        script = folder / 'runner.py'
        with open(script, 'x', encoding='utf-8') as stream:
            stream.write(data['runnerSource'])
        os.chmod(script, 0o600)
        subprocess.Popen([sys.executable, str(script), '--worker', str(folder)], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        return {'jobId': job_id, 'task': status}
    status = snapshot(folder)
    if status['projectPath'] != project:
        raise ValueError('任务不属于当前项目')
    if action == 'poll':
        cursor = data.get('cursor', 0)
        if not isinstance(cursor, int) or cursor < 0 or cursor > MAX_LOG:
            raise ValueError('任务游标无效')
        log = folder / 'events.jsonl'
        if log.is_symlink():
            raise ValueError('日志路径无效')
        if log.exists():
            records, cursor = read_events(log, cursor)
            more = log.stat().st_size > cursor
        else:
            records = []
            more = False
        return {'task': status, 'events': records, 'cursor': cursor, 'more': more}
    if action == 'reply':
        if status['state'] != 'waiting':
            raise ValueError('该任务目前没有待回答的问题')
        request_id = data.get('requestId')
        request = next((r for r in status['pendingRequests'] if r['request_id'] == request_id), None)
        if not request:
            raise ValueError('该问题已结束，请刷新任务')
        response = permission_response(request['request'], data)
        value = {'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request_id, 'response': response}}
        target = folder / 'responses' / (hashlib.sha256(request_id.encode()).hexdigest() + '.json')
        if target.exists():
            raise ValueError('回答正在提交，请等待任务继续')
        atomic_json(target, value)
        return {'ok': True}
    if action == 'stop':
        if status['state'] not in ('starting', 'running', 'waiting'):
            return {'ok': True, 'state': status['state']}
        (folder / 'stop').touch(mode=0o600, exist_ok=True)
        return {'ok': True, 'state': 'stopping'}
    raise ValueError('未知任务操作')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]))
    else:
        try:
            result = dispatch(json.loads(sys.stdin.buffer.read(2 * 1024 * 1024)))
            print(json.dumps(result, ensure_ascii=False))
        except Exception as error:
            print(json.dumps({'error': str(error)}, ensure_ascii=False))
            sys.exit(1)
