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

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=Path, required=True)
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
    while child.poll() is None:
        check_owner();time.sleep(.2)
    sys.exit(child.returncode if child.returncode>=0 else 128-child.returncode)
