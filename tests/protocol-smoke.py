"""Optional real-CLI handshake only: no model prompt, login or user configuration."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading

with tempfile.TemporaryDirectory(prefix='cloude-cli-protocol-') as directory:
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_'))}
    env.update(HOME=directory, CLAUDE_CONFIG_DIR=str(Path(directory) / '.claude'), DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1')
    child = subprocess.Popen([sys.argv[1], '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
                             cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    output = queue.Queue()
    def read():
        for line in child.stdout:
            try:
                output.put(json.loads(line))
            except ValueError:
                pass
    threading.Thread(target=read, daemon=True).start()
    try:
        child.stdin.write(json.dumps({'type': 'control_request', 'request_id': 'cloude-probe', 'request': {'subtype': 'initialize', 'hooks': {}, 'sdkMcpServers': []}}) + '\n')
        child.stdin.flush()
        message = output.get(timeout=45)
        while message.get('type') != 'control_response':
            message = output.get(timeout=15)
        assert message['response']['request_id'] == 'cloude-probe'
        assert message['response']['subtype'] == 'success', message['response']
        models = message['response']['response']['models']
        assert isinstance(models, list) and models, 'CLI must advertise model metadata'
        assert all(isinstance(model.get('value'), str) and isinstance(model.get('displayName'), str) for model in models)
        print('PASS actual CLI returns model identifiers and display names: ' + json.dumps([model['value'] for model in models]))
        print('PASS actual Claude CLI initializes the stdio approval protocol; no model request was sent')
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
