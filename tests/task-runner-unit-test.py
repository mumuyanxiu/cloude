"""Portable regressions for image output, log paging and the real CLI protocol."""
import importlib.util
import io
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[1]
RUNNER = load('task_runner', ROOT / 'electron/task-runner.py')
FIXTURE = load('task_fixture', ROOT / 'tests/task-runner-test.py')


class Output(unittest.TestCase):
    def test_reader_accepts_a_complete_line_larger_than_one_mb(self):
        line = json.dumps({'text': 'X' * (2 * 1024 * 1024)}).encode() + b'\n'
        events = queue.Queue()
        RUNNER.read_output(io.BytesIO(line), 'stdout', events)
        self.assertEqual(events.get_nowait(), ('stdout', line))
        self.assertEqual(events.get_nowait(), ('stdout', None))
        self.assertTrue(events.empty())

    def test_reader_keeps_a_bounded_limit_and_reports_stream_errors(self):
        events = queue.Queue()
        with patch.object(RUNNER, 'MAX_OUTPUT_LINE', 32):
            RUNNER.read_output(io.BytesIO(b'X' * 33), 'stdout', events)
        self.assertEqual(events.get_nowait()[0], 'failure')
        self.assertEqual(events.get_nowait(), ('stdout', None))
        with io.BytesIO() as stream:
            pass
        RUNNER.read_output(stream, 'stderr', events)
        self.assertEqual(events.get_nowait()[0], 'failure')
        self.assertEqual(events.get_nowait(), ('stderr', None))

    def test_binary_copies_are_omitted_without_changing_the_original_event(self):
        event = {'content': [{'type': 'image', 'source': {'type': 'base64', 'data': 'original', 'media_type': 'image/png'}},
                             {'type': 'text', 'text': 'keep this'}],
                 'file': {'base64': 'original', 'filePath': '/project/image.png'}, 'data': 'ordinary data'}
        display = RUNNER.display_event(event)
        self.assertNotEqual(display['content'][0]['source']['data'], 'original')
        self.assertNotEqual(display['file']['base64'], 'original')
        self.assertEqual(display['content'][1]['text'], 'keep this')
        self.assertEqual(display['data'], 'ordinary data')
        self.assertEqual(display['file']['filePath'], '/project/image.png')
        self.assertEqual(event['content'][0]['source']['data'], 'original')

    def test_paging_preserves_large_records_and_waits_for_incomplete_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'events.jsonl'
            records = [{'text': 'first'}, {'text': 'X' * (2 * 1024 * 1024)}, {'text': 'last'}]
            lines = [(json.dumps(row) + '\n').encode() for row in records]
            log.write_bytes(b''.join(lines) + b'{"text":')
            cursor = 0
            for row in records:
                batch, next_cursor = RUNNER.read_events(log, cursor)
                self.assertEqual(batch, [row])
                self.assertGreater(next_cursor, cursor)
                cursor = next_cursor
            self.assertEqual(RUNNER.read_events(log, cursor), ([], cursor))
            with log.open('ab') as stream:
                stream.write(b'"finished"}\n')
            self.assertEqual(RUNNER.read_events(log, cursor)[0], [{'text': 'finished'}])

    def test_oversized_saved_record_reports_an_error_instead_of_stalling(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'events.jsonl'
            log.write_bytes(b'X' * 33)
            with patch.object(RUNNER, 'MAX_EVENT_LINE', 32):
                with self.assertRaisesRegex(ValueError, '16 MB'):
                    RUNNER.read_events(log, 0)


class Protocol(unittest.TestCase):
    def run_worker(self, prompt):
        temporary = tempfile.TemporaryDirectory(prefix='cloude-output-test-')
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name)
        (folder / 'responses').mkdir()
        cli = folder / 'fake-claude.py'
        cli.write_text(FIXTURE.FAKE, encoding='utf-8')
        RUNNER.atomic_json(folder / 'config.json', {'executable': str(cli), 'projectPath': str(folder),
                                                  'prompt': prompt, 'mode': 'edit', 'allowCommands': False})
        RUNNER.atomic_json(folder / 'status.json', {'state': 'starting', 'createdAt': 0})
        real_popen = subprocess.Popen

        def launch(_args, **kwargs):
            child = real_popen([sys.executable, str(cli)], **kwargs)
            for stream in (child.stdin, child.stdout, child.stderr):
                self.addCleanup(stream.close)
            return child

        def terminate(child):
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)

        with patch.object(RUNNER.subprocess, 'Popen', side_effect=launch), patch.object(RUNNER, 'terminate', terminate):
            RUNNER.worker(folder)
        status = RUNNER.read_json(folder / 'status.json')
        self.assertEqual(status['state'], 'completed', status)
        self.assertEqual(status['exitCode'], 0)
        records, cursor = [], 0
        while cursor < (folder / 'events.jsonl').stat().st_size:
            batch, next_cursor = RUNNER.read_events(folder / 'events.jsonl', cursor)
            self.assertGreater(next_cursor, cursor)
            records.extend(batch)
            cursor = next_cursor
        self.assertTrue(any(row.get('event', {}).get('type') == 'result' for row in records))
        return folder, records

    def test_real_image_tool_output_finishes_and_stays_small_in_the_log(self):
        folder, records = self.run_worker('image')
        self.assertLess((folder / 'events.jsonl').stat().st_size, 4096)
        image = next(row['event'] for row in records if row.get('event', {}).get('type') == 'user')
        self.assertEqual(image['message']['content'][0]['tool_use_id'], 'read-image')

    def test_real_text_larger_than_the_old_ssh_capture_limit_is_recovered_intact(self):
        _folder, records = self.run_worker('long-text')
        texts = [block['text'] for row in records for block in row.get('event', {}).get('message', {}).get('content', [])
                 if block.get('type') == 'text']
        self.assertIn('large text: ' + 'X' * (5 * 1024 * 1024), texts)


if __name__ == '__main__':
    unittest.main(verbosity=2)
