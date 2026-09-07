#!/usr/bin/env python3
"""Install the dedicated, hash-pinned ComfyUI environment (never during inference)."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys

from setup import ROOT, space


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--cert',type=Path,default=Path('/etc/ssl/cert.pem'))
    p.add_argument('--engine',choices=['comfy','blender'],default='comfy')
    args=p.parse_args()
    if sys.version_info[:2]!=(3,12) or sys.platform!='darwin' or platform.machine()!='arm64':
        raise RuntimeError('此锁定环境需要 macOS Apple Silicon 和 Python 3.12')
    root=args.runtime.resolve()
    root.mkdir(parents=True,exist_ok=True)
    space(root,2*1024**3)
    if args.engine=='blender':
        subprocess.run([sys.executable,'-m','pip','install','--require-hashes','--only-binary=:all:',
                        '--no-deps','--no-compile','--upgrade','--target',str(root/'blender-python'),
                        '--python-version','3.11','--platform','macosx_13_0_arm64',
                        '--implementation','cp','--cert',str(args.cert.resolve()),
                        '-r',str(ROOT/'image3d/blender-python.requirements.txt')],check=True)
        print('Blender 专属补充依赖已安装；需在 Blender 后台探针中验证导入与烘焙。')
        return
    venv=root/'comfy-venv'
    if not venv.exists():
        subprocess.run([sys.executable,'-m','venv',str(venv)],check=True)
    python=venv/'bin/python'
    subprocess.run([str(python),'-m','pip','install','--require-hashes','--only-binary=:all:',
                    '--cert',str(args.cert.resolve()),'-r',str(ROOT/'image3d/comfy-python.requirements.txt')],check=True)
    subprocess.run([str(python),'-m','pip','check'],check=True)
    # Audit installed versions without importing model code or downloading weights.
    installed=json.loads(subprocess.check_output([str(python),'-m','pip','list','--format=json'],text=True))
    normalize=lambda name:name.lower().replace('_','-').replace('.','-')
    actual={normalize(p['name']):p['version'] for p in installed}
    lock=json.loads((ROOT/'image3d/comfy-python.lock.json').read_text())
    for item in lock['packages']:
        if actual.get(normalize(item['name']))!=item['version']:
            raise RuntimeError('安装后版本不符合清单：'+item['name'])
    print('ComfyUI 专属 Python 环境版本校验通过；仍需单独运行真实推理验收。')


if __name__=='__main__':main()
