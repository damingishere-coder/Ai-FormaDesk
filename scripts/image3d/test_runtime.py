"""Meaningful process-boundary checks; no model downloads or user files."""
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import subprocess
import os
import signal
import time
import ctypes

from runtime import Runtime, StageFailure


@unittest.skipUnless(sys.platform == 'darwin', 'macOS sandbox integration')
class BoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='forma-image3d-test-')
        self.root = Path(self.temporary.name).resolve()
        self.runtime = Runtime(self.root / 'runtime', self.root / 'job', budget=20)
        self.python = Path(sys.executable).resolve()
        self.read_paths = [Path(sys.base_prefix), self.python.parent]

    def tearDown(self):
        self.temporary.cleanup()

    def run_code(self, code, **kwargs):
        with self.runtime.acquired():
            return self.runtime.stage('test', [self.python, '-c', code], self.read_paths, **kwargs)

    def test_private_read_and_weight_write_denied(self):
        outside = self.root / 'outside.txt'
        outside.write_text('synthetic test only')
        models = self.root / 'models'
        models.mkdir()
        weight = models / 'test.bin'
        weight.write_bytes(b'original')
        self.read_paths.append(models)
        code = f'''
from pathlib import Path
import os
assert Path({str(weight)!r}).read_bytes() == b'original'
for f, mode in [({str(outside)!r}, 'r'), ({str(weight)!r}, 'w')]:
 try:
  open(f, mode)
 except PermissionError:
  pass
 else:
  raise AssertionError('sandbox allowed forbidden access')
assert 'OPENAI_API_KEY' not in os.environ
Path('allowed.txt').write_text('ok')
'''
        self.assertEqual(self.run_code(code)['status'], 'passed')
        self.assertEqual(weight.read_bytes(), b'original')

    def test_network_denied(self):
        code = '''
import socket
s=socket.socket(); s.settimeout(2)
try:
 s.connect(('1.1.1.1',80))
except PermissionError:
 pass
else:
 raise AssertionError('network was not rejected by sandbox')
'''
        self.assertEqual(self.run_code(code)['status'], 'passed')

    def test_only_selected_loopback_port(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            server.listen()
            port = server.getsockname()[1]
            code = f'''
import socket
s=socket.create_connection(('127.0.0.1',{port}),timeout=2);s.close()
try:
 socket.create_connection(('127.0.0.1',{port-1}),timeout=2)
except PermissionError:
 pass
else:
 raise AssertionError('unrelated loopback port allowed')
'''
            self.assertEqual(self.run_code(code, port=port)['status'], 'passed')

    def test_timeout_reports_non_success(self):
        self.runtime.budget = 1
        with self.assertRaises(StageFailure):
            self.run_code('import time; time.sleep(30)')
        self.assertEqual(json.loads((self.runtime.job / 'run.json').read_text())['stages'][0]['status'], 'timed-out')

    def test_child_memory_is_sampled(self):
        result=self.run_code('import time; data=bytearray(64*1024*1024); time.sleep(1.5)')
        self.assertGreater(result['memory']['samples'], 0)
        self.assertGreater(result['memory']['sampledPeakGroupFootprintBytes'], 60*1024*1024)

    def test_memory_limit_stops_worker(self):
        self.runtime.memory_limit_bytes=60*1024*1024
        with self.assertRaisesRegex(StageFailure,'内存占用超过'):
            self.run_code('import time; data=bytearray(96*1024*1024); time.sleep(30)')
        self.assertEqual(self.runtime.report['stages'][0]['status'],'memory-limit')

    def test_supervisor_crash_stops_inference_group(self):
        from metrics import MemorySampler
        module=Path(__file__).parent.resolve()
        code=f'''
import sys
from pathlib import Path
sys.path.insert(0,{str(module)!r})
from runtime import Runtime
r=Runtime({str(self.root/'crash-runtime')!r},{str(self.root/'crash-job')!r},30)
with r.acquired():
 r.stage('crash',[sys.executable,'-c','import time; time.sleep(30)'],[Path(sys.base_prefix)])
'''
        parent=subprocess.Popen([sys.executable,'-c',code])
        report=self.root/'crash-job/run.json'
        try:
            deadline=time.monotonic()+10
            while True:
                if report.exists():
                    stages=json.loads(report.read_text()).get('stages',[])
                    if stages and stages[0].get('processGroupId'):
                        group=stages[0]['processGroupId'];break
                if time.monotonic()>deadline:self.fail('Inference did not start')
                time.sleep(.05)
            parent.kill();parent.wait(timeout=5)
            sampler=MemorySampler();members=(ctypes.c_int*256)()
            deadline=time.monotonic()+5
            while sampler.lib.proc_listpgrppids(group,members,ctypes.sizeof(members))>0:
                if time.monotonic()>deadline:self.fail('Orphan inference group survived')
                time.sleep(.05)
        finally:
            if parent.poll() is None:parent.terminate();parent.wait(timeout=5)

    def test_cancel_reaps_process(self):
        timer = threading.Timer(.5, self.runtime.cancel)
        timer.start()
        try:
            with self.assertRaises(StageFailure):
                self.run_code('import time; time.sleep(30)')
            self.assertEqual(self.runtime.report['stages'][0]['status'], 'cancelled')
            self.assertIsNone(self.runtime.child)
        finally:
            timer.cancel()


if __name__ == '__main__':
    unittest.main()
