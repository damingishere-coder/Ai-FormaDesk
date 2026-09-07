"""Local inference process boundary. Installation and inference are separate.

This is the Stage A CLI supervisor, not yet the workbench/video scheduler.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from metrics import MemorySampler


class StageFailure(RuntimeError):
    pass


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    temporary.replace(path)


def profile(job, read_paths, port=None, metal_cache=None):
    roots = ['/System', '/usr/lib', '/usr/share', '/Library/Apple', '/Library/Fonts',
             '/private/var/db/timezone', *map(str, read_paths)]
    rules = ['(version 1)', '(deny default)',
             '(allow process-exec process-fork signal sysctl-read mach-lookup iokit-open)',
             '(allow ipc-posix-shm ipc-posix-sem file-read-metadata)',
             '(allow file-read* (literal "/"))',
             '(allow file-read* (literal "/private/etc/apache2/mime.types"))',
             '(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null") (literal "/dev/zero"))',
             '(allow file-write* (literal "/dev/null"))']
    for root in roots:
        rules.append(f'(allow file-read* file-map-executable (subpath {json.dumps(str(Path(root).resolve()))}))')
    rules.append(f'(allow file-read* file-write* (subpath {json.dumps(str(job.resolve()))}))')
    if metal_cache is not None:
        rules.append(f'(allow file-read* file-write* (subpath {json.dumps(str(metal_cache))}))')
        # MTLCompilerService is a separate sandboxed system process; issue
        # access only to its compiler cache, never to models or user files.
        rules.append('(allow file-issue-extension (require-all '
                     '(extension-class "com.apple.app-sandbox.read-write") '
                     '(require-not (vnode-type SYMLINK)) '
                     f'(subpath {json.dumps(str(metal_cache))})))')
    if port is not None:
        if not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError('无效的本机端口')
        # A dedicated inference server: only this loopback endpoint is allowed.
        endpoint = json.dumps(f'localhost:{port}')
        rules.append(f'(allow network* (local ip {endpoint}) (remote ip {endpoint}))')
    return '\n'.join(rules) + '\n'


def stop_group(child):
    # All inference writes are disposable candidates. Terminate the complete
    # private process group, including descendants that ignore SIGTERM.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    child.wait()


class Runtime:
    def __init__(self, directory, job, budget=1800, memory_limit_bytes=11*1024**3):
        self.directory = Path(directory).resolve()
        self.job = Path(job).resolve()
        self.job.mkdir(parents=True, exist_ok=True)
        self.budget = min(1800, max(1, budget))
        self.memory_limit_bytes = memory_limit_bytes
        self.started = None
        self.cancelled = False
        self.report = {'status': 'queued', 'stages': [], 'completePipeline': False}
        self.child = None

    def save(self):
        atomic_json(self.job / 'run.json', self.report)

    def cancel(self, *_):
        self.cancelled = True

    @contextmanager
    def acquired(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / 'inference.lock').open('a') as lock:
            previous = {s: signal.signal(s, self.cancel) for s in (signal.SIGTERM, signal.SIGINT)}
            try:
                while True:
                    if self.cancelled:
                        raise StageFailure('任务已取消')
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(.2)
                self.started = time.monotonic()  # Queue time is excluded.
                self.report['status'] = 'running'
                self.save()
                yield self
            except BaseException:
                self.report['status'] = ('cancelled' if self.cancelled else
                                         'timed-out' if self.started is not None and self.remaining() <= 0 else 'failed')
                self.save()
                raise
            finally:
                if self.child is not None:
                    stop_group(self.child)
                for s, handler in previous.items():
                    signal.signal(s, handler)
                fcntl.flock(lock, fcntl.LOCK_UN)

    def remaining(self):
        if self.started is None:
            raise StageFailure('必须先获取推理资源锁')
        return self.budget - (time.monotonic() - self.started)

    def stage(self, name, command, read_paths=(), port=None, extra_env=None, gpu=False):
        if not re.fullmatch(r'[a-z0-9-]+', name):
            raise ValueError('无效阶段名称')
        if self.cancelled or self.remaining() <= 0:
            raise StageFailure('任务已取消或超时')
        folder = self.job / name
        folder.mkdir(exist_ok=True)
        tmp = folder / 'tmp'
        tmp.mkdir(exist_ok=True)
        policy = folder / 'sandbox.sb'
        metal_cache = None
        if gpu:
            # Metal's runtime compiler uses the Darwin per-user cache rather
            # than HOME/TMPDIR. Permit only its compiler subdirectory.
            cache = subprocess.check_output(['/usr/bin/getconf', 'DARWIN_USER_CACHE_DIR'], text=True).strip()
            metal_cache = (Path(cache) / 'com.apple.metalfe').resolve()
        policy.write_text(profile(self.job, read_paths, port, metal_cache))
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.job), 'TMPDIR': str(tmp) + '/',
               'LANG': 'en_US.UTF-8', 'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
               'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
               'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
               'HF_HOME': str(self.job / 'hf-cache'), 'XDG_CACHE_HOME': str(self.job / 'cache'),
               'BLENDER_USER_RESOURCES': str(self.job / 'blender-resources')}
        if extra_env:
            env.update(extra_env)
        metrics = folder / 'resource.txt'
        launch = ['/usr/bin/time', '-l', '-o', str(metrics), '/usr/bin/sandbox-exec', '-f', str(policy), *map(str, command)]
        launch = [sys.executable, str(Path(__file__).with_name('watchdog.py')), str(os.getpid()), str(self.remaining()), *launch]
        record = {'stage': name, 'status': 'running', 'startedAt': time.time()}
        self.report['stages'].append(record)
        self.save()
        start = time.monotonic()
        memory = MemorySampler()
        sampled_at = 0
        with (folder / 'stdout.log').open('wb') as out, (folder / 'stderr.log').open('wb') as err:
            self.child = subprocess.Popen(launch, cwd=self.job, env=env, stdout=out, stderr=err, start_new_session=True)
            record['processGroupId'] = self.child.pid
            self.save()
            try:
                while self.child.poll() is None:
                    if time.monotonic()-sampled_at >= 1:
                        memory.sample(self.child.pid)
                        sampled_at = time.monotonic()
                        if memory.group_peak > self.memory_limit_bytes:
                            record['status'] = 'memory-limit'
                            stop_group(self.child)
                            raise StageFailure(f'推理内存占用超过 {self.memory_limit_bytes/1024**3:.1f} GiB 上限，已停止并保留候选')
                    if self.cancelled or self.remaining() <= 0:
                        record['status'] = 'cancelled' if self.cancelled else 'timed-out'
                        stop_group(self.child)
                        raise StageFailure('任务已取消' if self.cancelled else f'达到 {self.budget} 秒处理预算')
                    time.sleep(.2)
                record['exitCode'] = self.child.returncode
                if self.child.returncode:
                    if self.remaining() <= 0:
                        record['status'] = 'timed-out'
                        raise StageFailure(f'达到 {self.budget} 秒处理预算')
                    record['status'] = 'failed'
                    raise StageFailure(f'{name} 失败，退出码 {self.child.returncode}；见该阶段日志')
                record['status'] = 'passed'
            finally:
                if self.child.poll() is None:
                    stop_group(self.child)
                self.child = None
                record['seconds'] = time.monotonic() - start
                record['memory'] = memory.report()
                record['memory']['limitBytes'] = self.memory_limit_bytes
                if metrics.exists():
                    match = re.search(r'(\d+)\s+maximum resident set size', metrics.read_text())
                    if match:
                        record['peakRssBytes'] = int(match.group(1))
                self.save()
        return record
