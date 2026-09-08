#!/usr/bin/env python3
"""Hold the inference lease for existing trusted Blender/render subprocesses."""
import argparse
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import signal
import time
import json
from metrics import MemorySampler

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=Path, required=True)
parser.add_argument('--metrics', type=Path)
parser.add_argument('--max-footprint-mb', type=int, default=0)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command:
    parser.error('需要受信任的执行命令')
args.runtime.mkdir(parents=True, exist_ok=True)
owner=os.getppid()
if os.getpgrp()!=os.getpid():raise RuntimeError('资源执行器需要独立进程组')
def check_owner():
    if owner<=1 or os.getppid()!=owner:os.killpg(os.getpgrp(),signal.SIGKILL)
with (args.runtime / 'inference.lock').open('a') as lock:
    while True:
        check_owner()
        try:fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB);break
        except BlockingIOError:time.sleep(.2)
    print('FORMA_RESOURCE_ACQUIRED', flush=True)
    # Inherit the host's private process group so cancel/recovery kills the lease
    # holder and its complete Blender tree together. flock releases on death.
    child=subprocess.Popen(command)
    sampler = MemorySampler() if args.metrics else None
    while child.poll() is None:
        check_owner()
        if sampler:
            sampler.sample(os.getpgrp())
            report = sampler.report()
            exceeded = args.max_footprint_mb > 0 and sampler.group_peak > args.max_footprint_mb*1024*1024
            report['limitExceeded'] = exceeded
            temporary = args.metrics.with_suffix('.tmp')
            temporary.write_text(json.dumps(report))
            temporary.replace(args.metrics)
            if exceeded:
                print('PhotoFit 超过进程组内存上限，已停止', file=sys.stderr, flush=True)
                os.killpg(os.getpgrp(), signal.SIGKILL)
        time.sleep(1 if sampler else .2)
    sys.exit(child.returncode if child.returncode>=0 else 128-child.returncode)
