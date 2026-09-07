#!/usr/bin/env python3
"""Verify cancellation during real denoising, including process-group cleanup."""
import argparse
import ctypes
import json
from pathlib import Path
import signal
import subprocess
import sys
import time

from metrics import MemorySampler
from runtime import atomic_json


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--job', type=Path, required=True)
    p.add_argument('--image', type=Path, required=True)
    args=p.parse_args()
    job=args.job.resolve()
    if job.exists():raise RuntimeError('请使用新的取消验证目录')
    job.mkdir(parents=True)
    probe=Path(__file__).with_name('probe.py')
    command=[sys.executable,str(probe),'--runtime',str(args.runtime.resolve()),'--job',str(job),
             '--case','shape','--image',str(args.image.resolve())]
    with (job/'supervisor.log').open('wb') as log:
        child=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
        started=time.monotonic()
        try:
            while child.poll() is None:
                stdout=job/'shape/stdout.log'
                if stdout.exists() and 'Denoising (2/30)' in stdout.read_text():break
                if time.monotonic()-started>180:raise RuntimeError('未及时进入真实推理')
                time.sleep(.25)
            if child.poll() is not None:raise RuntimeError('推理在发出取消之前已退出')
            cancelled=time.monotonic()
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=15)
            report=json.loads((job/'run.json').read_text())
            group=report['stages'][0]['processGroupId']
            sampler=MemorySampler()
            if sampler.lib is None:raise RuntimeError('无法确认进程组已退出')
            # macOS killpg(0) may report EPERM briefly for a reaping process
            # group. Inspect the group's PID inventory instead of treating
            # that transient permission result as a surviving inference.
            members=(ctypes.c_int*256)()
            while sampler.lib.proc_listpgrppids(group,members,ctypes.sizeof(members))>0:
                if time.monotonic()-cancelled>15:raise RuntimeError('取消后仍有后台进程')
                time.sleep(.1)
            result={'status':report['status'],'exitCode':child.returncode,
                    'cancelSeconds':time.monotonic()-cancelled,'groupStillExists':False,
                    'startedRealDenoising':True,'workbenchVersionTouched':False}
            atomic_json(job/'cancellation-report.json',result)
            if report['status']!='cancelled':raise RuntimeError('取消状态记录不正确')
            print(json.dumps(result,ensure_ascii=False))
        finally:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                child.wait(timeout=15)


if __name__=='__main__':main()
