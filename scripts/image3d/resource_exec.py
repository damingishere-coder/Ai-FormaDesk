#!/usr/bin/env python3
"""Hold the inference lease for existing trusted Blender/render subprocesses."""
import argparse
import fcntl
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=Path, required=True)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command:
    parser.error('需要受信任的执行命令')
args.runtime.mkdir(parents=True, exist_ok=True)
with (args.runtime / 'inference.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print('FORMA_RESOURCE_ACQUIRED', flush=True)
    # Inherit the host's private process group so cancel/recovery kills the lease
    # holder and its complete Blender tree together. flock releases on death.
    sys.exit(subprocess.call(command))
