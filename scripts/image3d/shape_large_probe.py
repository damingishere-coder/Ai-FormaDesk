"""Explicit optional large-shape benchmark. Does not change workbench defaults."""
import argparse
import fcntl
import json
from pathlib import Path
import shutil
import subprocess
import sys
import signal

import setup
from runtime import Runtime
from validate import glb

ROOT=Path(__file__).resolve().parents[2]
LOCK=json.loads((ROOT/'image3d/shape-large.lock.json').read_text())


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--runtime',type=Path,required=True)
    parser.add_argument('--install',action='store_true')
    parser.add_argument('--image',type=Path)
    parser.add_argument('--job',type=Path)
    args=parser.parse_args()
    runtime=args.runtime.resolve()
    if args.install:
        setup.LOCK=LOCK
        with (runtime/'installation.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            setup.download(runtime,['shape-large'],workers=8)
        return
    if not args.image or not args.job: parser.error('推理需要 --image 和独立 --job')
    job=args.job.resolve();job.mkdir(parents=True,exist_ok=False)
    setup.space(runtime,0)
    for weight in LOCK['weights']:
        file=runtime/'models'/weight['path']
        if not file.is_file() or file.stat().st_size!=weight['size'] or setup.sha256(file)!=weight['sha256']:
            raise ValueError('形体大模型缺失或校验失败；请先单独安装')
    source=runtime/'sources/hunyuan-swift'
    commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if commit!=LOCK['sourceCommit'] or subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():
        raise ValueError('形体引擎源码不符合固定提交')
    binary=runtime/'xcode-build/Build/Products/Release/hy3d'
    metal=binary.parent/'mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib'
    shutil.copyfile(args.image,job/'reference.png')
    runner=Runtime(runtime,job,1800,memory_limit_bytes=12*1024**3)
    runner.report.update({'lock':LOCK,'binarySha256':setup.sha256(binary),'metalSha256':setup.sha256(metal),
                         'inputSha256':setup.sha256(job/'reference.png'),'visualAcceptance':'pending'})
    with runner.acquired():
        runner.stage('shape-large',[binary,'shape',job/'reference.png','-o',job/'shape.glb','--weights',runtime/'models/shape-large',
                     '--steps','8','--octree','256','--seed','42'],[binary.parent,runtime/'models/shape-large'],gpu=True)
        runner.report['shapeCandidate']=glb(job/'shape.glb',triangle_limit=2_000_000)
        runner.report['status']='shape-only-passed'
        runner.save()


if __name__=='__main__':
    def interrupted(*_): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,interrupted)
    try: main()
    except KeyboardInterrupt:
        print('安装已停止，已完成分片保留，未切换默认模型',file=sys.stderr)
        sys.exit(130)
