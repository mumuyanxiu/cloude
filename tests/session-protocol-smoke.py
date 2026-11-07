"""Real Claude CLI, two supervised turns, loopback model only (no paid API).

Run on Linux/macOS: python3 tests/session-protocol-smoke.py /path/to/claude
All settings, history and task files live in a temporary HOME.
"""
import json
import difflib
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

SOURCE = (Path(__file__).resolve().parents[1] / 'electron/task-runner.py').read_text(encoding='utf-8')


def without_cache_markers(value):
    # Claude moves the cache breakpoint to the newest message each turn.
    if isinstance(value, list):
        return [without_cache_markers(item) for item in value]
    if isinstance(value, dict):
        result = {key: without_cache_markers(item) for key, item in value.items() if key != 'cache_control'}
        # A text-only message may use string shorthand once it no longer
        # carries a cache marker. Compare its actual text, not serialization.
        if 'role' in result and isinstance(result.get('content'), str):
            result['content'] = [{'type': 'text', 'text': result['content']}]
        return result
    return value


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'count_tokens' in self.path:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"input_tokens":100}')
            return
        self.server.requests.append(request)
        message = {'id': 'msg_fixture_%s' % len(self.server.requests), 'type': 'message', 'role': 'assistant',
                   'model': request['model'], 'content': [{'type': 'text', 'text': 'Fixture complete.'}],
                   'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 20}}
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
        event('content_block_start', index=0, content_block={'type': 'text', 'text': ''})
        event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'Fixture complete.'})
        event('content_block_stop', index=0)
        event('message_delta', delta={'stop_reason': 'end_turn', 'stop_sequence': None}, usage={'output_tokens': 20})
        event('message_stop')


def main(executable):
    if os.name != 'posix':
        raise SystemExit('This integration test needs Linux/macOS, like the remote supervisor.')
    executable = str(Path(executable).resolve())
    with tempfile.TemporaryDirectory(prefix='cloude-session-protocol-') as directory:
        root = Path(directory)
        project = root / 'project'
        project.mkdir()
        config = root / 'config'
        config.mkdir()
        (config / 'settings.json').write_text(json.dumps({'disableAllHooks': True, 'autoMemoryEnabled': False}))
        instructions = project / 'CLAUDE.md'
        instructions.write_text('Fixture instruction: keep this initial context unchanged.\n')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        server.requests = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_'))}
        env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(config),
                   ANTHROPIC_BASE_URL='http://127.0.0.1:%s' % server.server_port, ANTHROPIC_API_KEY='fixture-only',
                   DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')

        def call(action, job='first', **extra):
            data = {'action': action, 'jobId': job, 'projectPath': str(project), **extra}
            result = subprocess.run([sys.executable, '-c', SOURCE], input=json.dumps(data), text=True,
                                    capture_output=True, env=env, timeout=15)
            assert result.returncode == 0, result.stdout + result.stderr
            return json.loads(result.stdout)

        def start(job, prompt, **extra):
            return call('start', job, prompt=prompt, mode='edit', model='sonnet', executable=executable,
                        conversationId='fixture-conversation', runnerSource=SOURCE, **extra)

        def completed(job):
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                result = call('poll', job)
                if result['task']['state'] == 'completed':
                    return result
                assert result['task']['state'] not in ('failed', 'interrupted'), result
                time.sleep(0.15)
            raise AssertionError('Real CLI did not finish: ' + json.dumps(result))

        try:
            start('first', 'First fixture turn. Reply briefly.')
            first = completed('first')
            assert len(server.requests) == 1, 'Expected exactly one main request for first turn'
            instructions.write_text('A new instruction on disk must not rebuild the live conversation prefix.\n')
            accepted = start('second', 'Second fixture turn. Reply briefly.', sessionId=first['task']['sessionId'])
            assert accepted['task']['processReused'] is True
            second = completed('second')
            assert first['task']['pid'] == second['task']['pid']
            assert len(server.requests) == 2, 'Each user turn must be sent exactly once'
            before, after = server.requests
            assert before['system'] == after['system'], 'System prompt changed between turns'
            assert before['tools'] == after['tools'], 'Tool catalog changed between turns'
            old_prefix = without_cache_markers(before['messages'])
            new_prefix = without_cache_markers(after['messages'][:len(before['messages'])])
            assert old_prefix == new_prefix, 'Earlier message prefix was rewritten:\n' + '\n'.join(difflib.unified_diff(
                json.dumps(old_prefix, indent=2).splitlines(), json.dumps(new_prefix, indent=2).splitlines()))[:6000]
            assert len(after['messages']) == len(before['messages']) + 2, 'History was duplicated'
            assert call('poll', 'first', cursor=first['cursor'])['events'] == [], 'New turn leaked into old task log'
            assert start('second', 'Must never be sent.', sessionId=first['task']['sessionId'])['existing'] is True
            time.sleep(0.3)
            assert len(server.requests) == 2, 'Retry submitted a duplicate prompt'
            print('PASS real CLI: one live process, two user turns, two model requests, stable system/tools/history prefix', flush=True)
            # Verify the production quota query routes to a local CLI command,
            # even with an API fixture configured, rather than a model prompt.
            usage = subprocess.run([executable, '-p', '/usage', '--output-format', 'stream-json', '--verbose',
                                    '--no-session-persistence', '--max-turns', '1', '--tools', '',
                                    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
                                   cwd=root, env=env, text=True, capture_output=True, timeout=30)
            assert len(server.requests) == 2, '/usage unexpectedly made a model request'
            usage_events = [json.loads(line) for line in usage.stdout.splitlines() if line.startswith('{')]
            usage_result = next(e for e in usage_events if e.get('type') == 'result')
            assert usage.returncode == 0 and usage_result.get('local_command') == 'usage', usage_result
            assert usage_result['num_turns'] == 0 and usage_result['total_cost_usd'] == 0, usage_result
            # API-key fixtures have no subscription bars; no quota is invented.
            print('PASS real CLI: /usage is a local command with zero model requests and zero inference cost', flush=True)
        finally:
            for job in ('first', 'second'):
                try:
                    call('stop', job)
                except Exception:
                    pass
            workers = list((root / '.cloude-tasks').glob('*/*/worker.json'))
            for p in workers:
                p.with_name('retire').touch()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and any(json.loads(p.read_text())['state'] != 'closed' for p in workers):
                time.sleep(0.1)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main(sys.argv[1])
