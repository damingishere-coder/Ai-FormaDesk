"""Trusted process-group guardian; survives a crashed workbench supervisor."""
import os
import signal
import subprocess
import sys
import time


def main():
    parent=int(sys.argv[1])
    seconds=float(sys.argv[2])
    if parent<=1 or not 0<seconds<=1800 or len(sys.argv)<4:
        raise ValueError('Invalid guardian arguments')
    # Runtime starts this guardian as a new session. Never signal any group
    # unless this process is its leader.
    if os.getpgrp()!=os.getpid():raise RuntimeError('Guardian is not isolated')
    child=subprocess.Popen(sys.argv[3:])
    started=time.monotonic()
    while child.poll() is None:
        if os.getppid()!=parent or time.monotonic()-started>=seconds:
            os.killpg(os.getpgrp(),signal.SIGKILL)
        time.sleep(.2)
    return child.returncode if child.returncode>=0 else 128-child.returncode


if __name__=='__main__':sys.exit(main())
