#!/usr/bin/env python3
"""Read-only installation diagnostics; file presence is not visual acceptance."""
import argparse
import json
from pathlib import Path
import platform
import shutil
import subprocess

from setup import LOCK, sha256


def inspect(runtime, verify=False):
    runtime=Path(runtime).resolve()
    result={'platform':platform.platform(),'architecture':platform.machine(),
            'completePipeline':False,'visualAcceptance':'not-inferred-from-installation',
            'sources':{},'weights':[]}
    disk_root=runtime
    while not disk_root.exists():disk_root=disk_root.parent
    disk=shutil.disk_usage(disk_root)
    result['disk']={'freeBytes':disk.free,'reserveBytes':LOCK['reserveBytes'],
                    'hasWorkReserve':disk.free>=LOCK['reserveBytes']}
    for name,spec in LOCK['sources'].items():
        folder=runtime/'sources'/name
        entry={'expectedCommit':spec['commit'],'status':'missing'}
        if folder.is_dir():
            try:
                actual=subprocess.check_output(['git','-C',str(folder),'rev-parse','HEAD'],text=True,stderr=subprocess.DEVNULL).strip()
                dirty=subprocess.check_output(['git','-C',str(folder),'status','--porcelain'],text=True,stderr=subprocess.DEVNULL).strip()
                entry.update(commit=actual,status='verified' if actual==spec['commit'] and not dirty else 'mismatch')
            except subprocess.CalledProcessError:entry['status']='invalid'
        result['sources'][name]=entry
    for spec in LOCK['weights']:
        file=runtime/'models'/spec['path']
        status='missing'
        if file.is_file() and file.resolve()!=file:
            status='invalid-path'
        elif file.is_file():
            status='size-checked' if file.stat().st_size==spec['size'] else 'invalid-size'
            if verify and status=='size-checked':
                status='verified' if sha256(file)==spec['sha256'] else 'invalid-hash'
        result['weights'].append({'name':spec['name'],'path':spec['path'],'status':status,'bytes':spec['size']})
    binary=runtime/'xcode-build/Build/Products/Release/hy3d'
    metal=binary.parent/'mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib'
    result['native']={'shapeExecutable':binary.is_file(),'metalLibrary':metal.is_file(),
                      'foregroundExecutable':(runtime/'bin/foreground').is_file()}
    result['python']={'comfyEnvironment':(runtime/'comfy-venv/bin/python').is_file(),
                      'blenderDependencies':(runtime/'blender-python/PIL').is_dir()}
    acceptable={'verified'} if verify else {'size-checked'}
    def installed(names):return all(w['status'] in acceptable for w in result['weights'] if w['name'] in names)
    sources=lambda names:all(result['sources'][n]['status']=='verified' for n in names)
    result['shape']={'installationReady':bool(binary.is_file() and metal.is_file() and sources(['hunyuan-swift']) and installed({'shape-small'}))}
    result['texture']={'installationReady':bool(result['python']['comfyEnvironment'] and result['python']['blenderDependencies'] and sources(['stablegen','comfyui','ipadapter-plus']) and installed({w['name'] for w in LOCK['weights'] if w['name']!='shape-small'}))}
    result['hashesVerifiedThisCheck']=verify
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--verify',action='store_true',help='Read every complete weight and verify its SHA-256')
    args=p.parse_args()
    print(json.dumps(inspect(args.runtime,args.verify),ensure_ascii=False,indent=2))


if __name__=='__main__':main()
