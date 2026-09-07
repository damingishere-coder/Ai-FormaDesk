#!/usr/bin/env python3
"""Repair ONLY an interrupted, verified SwiftPM 6.3 checkout registration.

SwiftPM can leave complete checkouts unregistered after a submodule transport
error, then discard them and clone again. First finish pinned submodule checkout
with `git -c http.version=HTTP/1.1 submodule update --init --recursive --depth 1`.
This helper checks all actual Git revisions before registering the existing
files. It never changes source, dependency resolution, or verification results.
An unknown cache schema fails closed. Keep a copy of the previous cache record.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
from setup import ROOT
from runtime import atomic_json


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True)
    args=p.parse_args()
    root=args.runtime.resolve()
    source=root/'sources/hunyuan-swift'
    lock=json.loads((ROOT/'image3d/swift-dependencies.lock.json').read_text())
    resolved=json.loads((source/'Package.resolved').read_text())
    pins={x['identity']:x['state'] for x in resolved['pins']}
    checkouts=source/'.build/checkouts'
    entries=[]
    for item in lock['dependencies']:
        if pins.get(item['identity'])!={'revision':item['revision'],'version':item['version']}:
            raise RuntimeError('Swift 解析结果与已检查版本不符')
        entries.append((checkouts/item['identity'],item['revision']))
    entries.extend((checkouts/item['path'],item['revision']) for item in lock['submodules'])
    for path,revision in entries:
        actual=subprocess.check_output(['git','-C',str(path),'rev-parse','HEAD'],text=True).strip()
        dirty=subprocess.check_output(['git','-C',str(path),'status','--porcelain'],text=True).strip()
        if actual!=revision or dirty:raise RuntimeError('依赖未完整检出或包含修改：'+str(path))
    file=source/'.build/workspace-state.json'
    state=json.loads(file.read_text())
    if state['version']!=lock['swiftPackageManagerStateVersion']:
        raise RuntimeError('未支持的 SwiftPM 缓存结构；未修改')
    existing={x['packageRef']['identity']:x for x in state['object']['dependencies']}
    for item in lock['dependencies']:
        if item['identity'] in existing:
            actual=existing[item['identity']]['state']
            if actual!={'checkoutState':{'revision':item['revision'],'version':item['version']},'name':'sourceControlCheckout'}:
                raise RuntimeError('已有依赖注册与锁定状态不一致；未覆盖')
            continue
        state['object']['dependencies'].append({
            'basedOn':None,'packageRef':{'identity':item['identity'],'kind':'remoteSourceControl','location':item['url'],'name':item['identity']},
            'state':{'checkoutState':{'revision':item['revision'],'version':item['version']},'name':'sourceControlCheckout'},
            'subpath':item['identity']})
    backup=file.with_suffix('.before-image3d-repair.json')
    if not backup.exists():shutil.copyfile(file,backup)
    atomic_json(file,state)
    print('Verified checkout registration repaired; source commits unchanged.')


if __name__=='__main__':main()
