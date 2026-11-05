"""Linux integration: real detached processes and the CLI stdin/stdout protocol."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'electron/task-runner.py').read_text(encoding='utf-8')
FAKE = '''#!/usr/bin/env python3
import json, os, sys, time
def send(value):
    print(json.dumps(value), flush=True)
init = json.loads(sys.stdin.readline())
assert init['request']['subtype'] == 'initialize'
send({'type':'control_response','response':{'subtype':'success','request_id':init['request_id'],'response':{}}})
user = json.loads(sys.stdin.readline())
prompt = user['message']['content']
send({'type':'system','subtype':'init','session_id':'fixture-session'})
if prompt == 'wait':
    time.sleep(60)
if prompt == 'question':
    send({'type':'control_request','request_id':'question-1','request':{'subtype':'can_use_tool','tool_name':'AskUserQuestion','input':{'questions':[{'question':'Which option?','options':[{'label':'A'},{'label':'B'}]}]}}})
    answer = json.loads(sys.stdin.readline())
    assert answer['response']['response']['updatedInput']['answers']['Which option?'] == 'B'
if prompt == 'permission':
    send({'type':'control_request','request_id':'permission-1','request':{'subtype':'can_use_tool','tool_name':'Bash','input':{'command':'echo test'}}})
    answer = json.loads(sys.stdin.readline())
    assert answer['response']['response']['behavior'] == 'deny'
if prompt == 'fail':
    print('fixture login missing', file=sys.stderr)
    sys.exit(7)
if prompt == 'image':
    data = 'A' * (2 * 1024 * 1024)
    send({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'read-image','content':[{'type':'image','source':{'type':'base64','media_type':'image/png','data':data}}]}]},'tool_use_result':{'type':'image','file':{'base64':data}}})
if prompt == 'long-text':
    send({'type':'assistant','message':{'content':[{'type':'text','text':'large text: ' + 'X' * (5 * 1024 * 1024)}]}})
time.sleep(0.25)
send({'type':'assistant','message':{'content':[{'type':'text','text':'fixture complete'}]}})
send({'type':'result','subtype':'success','session_id':'fixture-session','result':'fixture complete'})
for line in sys.stdin:
    pass
'''


@unittest.skipUnless(os.name == 'posix', 'detached workers require a POSIX remote')
class Tasks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cloude-task-test-')
        self.root = Path(self.temp.name)
        self.project = self.root / 'project with spaces'
        self.project.mkdir()
        self.cli = self.root / 'fake-claude'
        self.cli.write_text(FAKE)
        self.cli.chmod(0o700)
        self.env = {**os.environ, 'HOME': str(self.root)}
        self.jobs = []

    def tearDown(self):
        for job in self.jobs:
            self.request('stop', job)
        time.sleep(0.3)
        self.temp.cleanup()

    def request(self, action, job='job', **extra):
        data = {'action': action, 'jobId': job, 'projectPath': str(self.project), **extra}
        result = subprocess.run(['python3', '-c', SOURCE], input=json.dumps(data), text=True, capture_output=True, env=self.env, timeout=10)
        value = json.loads(result.stdout)
        if result.returncode:
            raise ValueError(value['error'])
        return value

    def start(self, prompt, job='job'):
        self.jobs.append(job)
        return self.request('start', job, prompt=prompt, executable=str(self.cli), mode='edit', allowCommands=False, askCommands=True,
                            conversationId='conversation', title=prompt, runnerSource=SOURCE)

    def wait_state(self, state, job='job'):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = self.request('poll', job, cursor=0)
            if result['task']['state'] == state:
                return result
            time.sleep(0.1)
        self.fail('Expected %s, received %r' % (state, result))

    def test_detached_task_can_be_read_by_a_fresh_client_without_reexecution(self):
        self.start('complete')
        result = self.wait_state('completed')
        self.assertEqual(result['task']['sessionId'], 'fixture-session')
        self.assertEqual(len([e for e in result['events'] if e.get('event', {}).get('type') == 'result']), 1)
        repeated = self.start('must not run again')
        self.assertTrue(repeated['existing'])
        self.assertEqual(self.request('poll', cursor=result['cursor'])['events'], [])
        self.assertEqual(len(self.request('list')['tasks']), 1)

    def test_question_survives_no_attached_client_and_answer_resumes(self):
        self.start('question')
        waiting = self.wait_state('waiting')
        self.assertEqual(waiting['task']['pendingRequests'][0]['request_id'], 'question-1')
        with self.assertRaisesRegex(ValueError, '所有问题'):
            self.request('reply', requestId='question-1', allow=True, answers={})
        self.request('reply', requestId='question-1', allow=True, answers={'Which option?': 'B'})
        self.assertEqual(self.wait_state('completed')['task']['pendingRequests'], [])

    def test_permission_is_not_automatically_approved(self):
        self.start('permission')
        self.wait_state('waiting')
        self.request('reply', requestId='permission-1', allow=False)
        self.wait_state('completed')

    def test_stop_ends_the_real_child_process(self):
        self.start('wait')
        self.wait_state('running')
        self.request('stop')
        self.wait_state('stopped')

    def test_failure_and_bad_identifiers_are_reported(self):
        self.start('fail')
        result = self.wait_state('failed')
        self.assertEqual(result['task']['exitCode'], 7)
        self.assertTrue(any('login missing' in e.get('data', '') for e in result['events']))
        with self.assertRaises(ValueError):
            self.request('poll', '../escape')

    def test_reading_an_image_larger_than_one_mb_completes(self):
        self.start('image')
        result = self.wait_state('completed')
        image = next(e['event'] for e in result['events'] if e.get('event', {}).get('type') == 'user')
        self.assertLess(len(json.dumps(image)), 1000)
        self.assertEqual(image['message']['content'][0]['tool_use_id'], 'read-image')
        self.assertTrue(any(e.get('event', {}).get('type') == 'result' for e in result['events']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
