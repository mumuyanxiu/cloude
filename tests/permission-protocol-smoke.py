"""Optional real CLI permission test against a loopback model fixture, no paid API.

Usage: python tests/permission-protocol-smoke.py /path/to/claude
Uses isolated Claude settings and writes only inside a temporary project.
"""
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('runner', Path(__file__).resolve().parents[1] / 'electron/task-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'count_tokens' in self.path:
            data = json.dumps({'input_tokens': 100}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(data)
            return
        self.server.requests.append({'model': request.get('model'), 'effort': request.get('output_config', {}).get('effort')})
        results = sum(block.get('type') == 'tool_result' for message in request.get('messages', [])
                      if isinstance(message.get('content'), list) for block in message['content'])
        tool_available = any(tool.get('name') == 'Write' for tool in request.get('tools', []))
        use_tool = tool_available and results < getattr(self.server, 'tool_calls', 1)
        block = {'type': 'tool_use', 'id': 'fixture-write-%s' % results, 'name': 'Write',
                 'input': {'file_path': str(self.server.project / 'marker.txt'), 'content': 'fixture'}} if use_tool else {'type': 'text', 'text': 'Fixture complete.'}
        message = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'model': request.get('model', 'fixture'),
                   'content': [block], 'stop_reason': 'tool_use' if use_tool else 'end_turn',
                   'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 20}}
        self.send_response(200)
        if not request.get('stream'):
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(message).encode())
            return
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        def event(kind, **data):
            self.wfile.write(('event: ' + kind + '\ndata: ' + json.dumps({'type': kind, **data}) + '\n\n').encode())
            self.wfile.flush()
        event('message_start', message={**message, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 100, 'output_tokens': 0}})
        event('content_block_start', index=0, content_block={**block, 'input': {}} if use_tool else {'type': 'text', 'text': ''})
        event('content_block_delta', index=0, delta={'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if use_tool else {'type': 'text_delta', 'text': block['text']})
        event('content_block_stop', index=0)
        event('message_delta', delta={'stop_reason': message['stop_reason'], 'stop_sequence': None}, usage={'output_tokens': 20})
        event('message_stop')


def run_cli(executable, project, env, scope='once', mode='edit', **inference):
    child = subprocess.Popen(runner.claude_args({'executable': executable, 'mode': mode, **inference}) +
                             ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
                             cwd=project, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, encoding='utf-8')
    events = queue.Queue()
    errors = []
    def read():
        for line in child.stdout:
            try:
                events.put(json.loads(line))
            except ValueError:
                pass
    def read_errors():
        for line in child.stderr:
            errors.append(line)
    threading.Thread(target=read, daemon=True).start()
    threading.Thread(target=read_errors, daemon=True).start()
    def write(message):
        child.stdin.write(json.dumps(message) + '\n')
        child.stdin.flush()
    approvals = []
    try:
        write({'type': 'control_request', 'request_id': 'init', 'request': {'subtype': 'initialize', 'hooks': {}, 'sdkMcpServers': []}})
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                event = events.get(timeout=1)
            except queue.Empty:
                if child.poll() is not None:
                    raise AssertionError('CLI exited: ' + ''.join(errors))
                continue
            if event.get('type') == 'control_response' and event['response']['request_id'] == 'init':
                assert event['response']['subtype'] == 'success', event
                write({'type': 'user', 'message': {'role': 'user', 'content': 'Run the fixture Write tool.'}, 'parent_tool_use_id': None, 'session_id': ''})
            if event.get('type') == 'control_request':
                tool = event['request']
                assert tool['subtype'] == 'can_use_tool' and tool['tool_name'] == 'Write', tool
                approvals.append(tool)
                write({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': event['request_id'],
                       'response': runner.permission_response(tool, {'allow': True, 'scope': scope})}})
            if event.get('type') == 'result':
                assert not event.get('is_error'), event
                child.stdin.close()
                child.wait(timeout=10)
                return approvals
        raise AssertionError('CLI timed out: ' + ''.join(errors))
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()


class TemporaryProject(tempfile.TemporaryDirectory):
    def cleanup(self):
        # On Windows the CLI's short-lived helper processes can briefly keep
        # their working directory open after the main process exits.
        for attempt in range(50):
            try:
                return super().cleanup()
            except PermissionError:
                if attempt == 49:
                    raise
                time.sleep(0.1)


with TemporaryProject(prefix='cloude-permission-protocol-') as directory:
    root = Path(directory)
    project = root / 'project'
    project.mkdir()
    config = root / 'config'
    config.mkdir()
    settings = config / 'settings.json'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    server.project = project
    server.requests = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_'))}
    env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(config),
               ANTHROPIC_BASE_URL='http://127.0.0.1:%s' % server.server_port, ANTHROPIC_API_KEY='fixture-only',
               DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
    marker = project / 'marker.txt'
    local = project / '.claude/settings.local.json'
    def configure(mode='default', **permissions):
        settings.write_text(json.dumps({'disableAllHooks': True, 'permissions': {'defaultMode': mode, **permissions}}))
        marker.unlink(missing_ok=True)
    try:
        configure('acceptEdits')
        run_cli(sys.argv[1], project, {**env, 'CLAUDE_CODE_EFFORT_LEVEL': 'high'}, model='claude-opus-4-6', effort='high')
        assert {'model': 'claude-opus-4-6', 'effort': 'high'} in server.requests, server.requests
        print('PASS selected model and effort reach the model request through the native CLI', flush=True)
        configure('acceptEdits')
        assert run_cli(sys.argv[1], project, env) == []
        assert marker.read_text() == 'fixture'
        print('PASS inherited remote default mode', flush=True)
        configure()
        assert len(run_cli(sys.argv[1], project, env)) == 1
        assert marker.read_text() == 'fixture'
        assert not local.exists() or 'Write' not in json.loads(local.read_text()).get('permissions', {}).get('allow', [])
        print('PASS one-time approval is not persisted', flush=True)
        configure()
        server.tool_calls = 2
        assert len(run_cli(sys.argv[1], project, env, 'project')) == 1
        assert 'Write' in json.loads(local.read_text())['permissions']['allow']
        server.tool_calls = 1
        print('PASS project approval also applies to repeated calls in the active session', flush=True)
        configure()
        assert run_cli(sys.argv[1], project, env) == []
        assert marker.read_text() == 'fixture'
        print('PASS native project rule persists and a fresh CLI session reuses it', flush=True)
        other_project = root / 'other-project'
        other_project.mkdir()
        server.project = other_project
        assert len(run_cli(sys.argv[1], other_project, env)) == 1
        server.project = project
        print('PASS project allow does not leak into another project', flush=True)
        configure(deny=['Write'])
        assert run_cli(sys.argv[1], project, env) == []
        assert not marker.exists()
        print('PASS remote deny still wins over project allow', flush=True)
        configure(ask=['Write'])
        assert len(run_cli(sys.argv[1], project, env)) == 1
        print('PASS remote ask still prompts over project allow', flush=True)
    finally:
        server.shutdown()
        server.server_close()
