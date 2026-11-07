"""Linux integration: real detached processes and the CLI stdin/stdout protocol."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

SOURCE = (Path(__file__).resolve().parents[1] / 'electron/task-runner.py').read_text(encoding='utf-8')
FAKE = '''#!/usr/bin/env python3
import json, os, sys, time
def send(value):
    print(json.dumps(value), flush=True)
init = json.loads(sys.stdin.readline())
assert init['request']['subtype'] == 'initialize'
send({'type':'control_response','response':{'subtype':'success','request_id':init['request_id'],'response':{}}})
# Duplicate acknowledgements must never submit a second user turn.
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
send({'type':'assistant','message':{'content':[{'type':'text','text':'fixture complete'}]},'fixture_pid':os.getpid(),'fixture_prompt':prompt})
send({'type':'result','subtype':'success','session_id':'fixture-session','result':'fixture complete'})
for line in sys.stdin:
    user = json.loads(line)
    assert user['type'] == 'user' and user['session_id'] == 'fixture-session'
    prompt = user['message']['content']
    if prompt == 'wait':
        time.sleep(60)
    if prompt == 'question':
        send({'type':'control_request','request_id':'followup-question','request':{'subtype':'can_use_tool','tool_name':'AskUserQuestion','input':{'questions':[{'question':'Continue?'}]}}})
        answer = json.loads(sys.stdin.readline())
        assert answer['response']['response']['updatedInput']['answers']['Continue?'] == 'yes'
    send({'type':'assistant','message':{'content':[{'type':'text','text':'followup complete'}]},'fixture_pid':os.getpid(),'fixture_prompt':prompt})
    send({'type':'result','subtype':'success','session_id':'fixture-session','result':'followup complete'})
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
        for p in (self.root / '.cloude-tasks').glob('*/*/worker.json'):
            p.with_name('retire').touch()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if all(json.loads(p.read_text()).get('state') == 'closed' for p in (self.root / '.cloude-tasks').glob('*/*/worker.json')):
                break
            time.sleep(0.1)
        self.temp.cleanup()

    def request(self, action, job='job', **extra):
        data = {'action': action, 'jobId': job, 'projectPath': str(self.project), **extra}
        result = subprocess.run(['python3', '-c', SOURCE], input=json.dumps(data), text=True, capture_output=True, env=self.env, timeout=10)
        value = json.loads(result.stdout)
        if result.returncode:
            raise ValueError(value['error'])
        return value

    def start(self, prompt, job='job', **extra):
        self.jobs.append(job)
        conversation = extra.pop('conversationId', 'conversation')
        return self.request('start', job, prompt=prompt, executable=str(self.cli), mode='edit', allowCommands=False, askCommands=True,
                            conversationId=conversation, title=prompt, runnerSource=SOURCE, **extra)

    def assistant(self, result):
        return [e['event'] for e in result['events'] if e.get('event', {}).get('type') == 'assistant']

    def test_followup_reuses_one_cli_and_separates_per_turn_logs(self):
        self.start('first')
        first = self.wait_state('completed')
        before = self.request('poll', cursor=first['cursor'])
        self.assertEqual(before['events'], [])
        next_task = self.start('second', 'next', sessionId='fixture-session')
        self.assertTrue(next_task['task']['processReused'])
        second = self.wait_state('completed', 'next')
        self.assertEqual(self.assistant(first)[0]['fixture_pid'], self.assistant(second)[0]['fixture_pid'])
        self.assertEqual([e['fixture_prompt'] for e in self.assistant(first)], ['first'])
        self.assertEqual([e['fixture_prompt'] for e in self.assistant(second)], ['second'])
        self.assertEqual(self.request('poll', cursor=first['cursor'])['events'], [])
        self.assertTrue(self.start('duplicate', 'next', sessionId='fixture-session')['existing'])
        self.assertEqual(len(self.assistant(self.request('poll', 'next'))), 1)

    def test_reused_process_keeps_question_and_stop_bound_to_the_current_turn(self):
        self.start('first')
        first = self.wait_state('completed')
        self.start('question', 'question', sessionId='fixture-session')
        self.wait_state('waiting', 'question')
        self.request('stop', 'job')  # A finished job cannot stop a later turn.
        self.request('reply', 'question', requestId='followup-question', allow=True, answers={'Continue?': 'yes'})
        self.wait_state('completed', 'question')
        self.start('wait', 'waiting', sessionId='fixture-session')
        self.wait_state('running', 'waiting')
        self.request('stop', 'waiting')
        self.wait_state('stopped', 'waiting')
        self.assertEqual(self.request('poll')['task']['state'], 'completed')

    def test_changed_options_retire_old_worker_and_cannot_reuse_stale_history(self):
        self.start('first')
        first = self.wait_state('completed')
        self.start('second', 'next', sessionId='fixture-session', model='sonnet')
        second = self.wait_state('completed', 'next')
        self.assertFalse(second['task']['processReused'])
        self.assertNotEqual(self.assistant(first)[0]['fixture_pid'], self.assistant(second)[0]['fixture_pid'])
        self.start('third', 'third', sessionId='fixture-session')
        third = self.wait_state('completed', 'third')
        self.assertFalse(third['task']['processReused'])
        self.assertNotEqual(self.assistant(first)[0]['fixture_pid'], self.assistant(third)[0]['fixture_pid'])

    def test_dead_idle_worker_falls_back_to_resume_without_replaying_old_prompt(self):
        self.start('first')
        first = self.wait_state('completed')
        for p in (self.root / '.cloude-tasks').glob('*/*/worker.json'):
            p.with_name('retire').touch()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if all(json.loads(p.read_text())['state'] == 'closed' for p in (self.root / '.cloude-tasks').glob('*/*/worker.json')):
                break
            time.sleep(0.1)
        self.start('second', 'next', sessionId='fixture-session')
        second = self.wait_state('completed', 'next')
        self.assertFalse(second['task']['processReused'])
        self.assertEqual([e['fixture_prompt'] for e in self.assistant(second)], ['second'])

    def test_concurrent_clients_cannot_submit_two_turns_to_one_session(self):
        self.start('first')
        self.wait_state('completed')
        def send(job):
            try:
                return self.start('wait', job, sessionId='fixture-session')
            except ValueError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, ['next-a', 'next-b']))
        self.assertEqual(sum(isinstance(r, dict) for r in results), 1)
        self.assertTrue(any(isinstance(r, str) and '仍在执行' in r for r in results))
        # Only successfully created jobs can be stopped during cleanup.
        self.jobs = [job for job in self.jobs if any(p.parent.name == job for p in (self.root / '.cloude-tasks').glob('*/*/status.json'))]

    def test_idle_workers_are_bounded_when_new_conversations_start(self):
        for index in range(6):
            job = 'idle-%s' % index
            self.start('complete', job, conversationId=job)
            self.wait_state('completed', job)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            states = [json.loads(p.read_text())['state'] for p in (self.root / '.cloude-tasks').glob('*/*/worker.json')]
            if states.count('idle') <= 4 and states.count('closed') >= 2:
                break
            time.sleep(0.1)
        self.assertLessEqual(states.count('idle'), 4)
        self.assertGreaterEqual(states.count('closed'), 2)

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
