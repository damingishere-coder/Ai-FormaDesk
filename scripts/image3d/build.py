#!/usr/bin/env python3
"""Build the pinned native tools, including MLX Metal resources, outside inference."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

from setup import ROOT, LOCK, sha256, space
from runtime import atomic_json


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    source = runtime / 'sources/hunyuan-swift'
    if git(source, 'rev-parse', 'HEAD') != LOCK['sources']['hunyuan-swift']['commit'] or git(source, 'status', '--porcelain'):
        raise RuntimeError('Hunyuan 源码不符合锁定提交或包含修改')
    pins = json.loads((ROOT / 'image3d/swift-dependencies.lock.json').read_text())
    resolved = json.loads((source / 'Package.resolved').read_text())
    actual = {p['identity']: p['state'] for p in resolved['pins']}
    for pin in pins['dependencies']:
        if actual.get(pin['identity']) != {'revision': pin['revision'], 'version': pin['version']}:
            raise RuntimeError('Swift Package.resolved 与锁定清单不符')
    space(runtime, 2 * 1024**3)
    report = {'startedAt': time.time(), 'status': 'building', 'sourceCommit': git(source, 'rev-parse', 'HEAD')}
    evidence = runtime / 'evidence'
    evidence.mkdir(exist_ok=True)
    report['metalCompiler'] = subprocess.check_output(['xcrun', 'metal', '--version'], text=True)
    report['swiftCompiler'] = subprocess.check_output(['swift', '--version'], text=True)
    command = ['xcodebuild', 'build', '-scheme', 'hy3d', '-configuration', 'Release', '-jobs', '4',
               '-destination', 'platform=macOS', '-derivedDataPath', str(runtime/'xcode-build'),
               '-clonedSourcePackagesDirPath', str(source/'.build'), '-disableAutomaticPackageResolution',
               '-skipPackageUpdates', 'CODE_SIGNING_ALLOWED=NO', 'COMPILER_INDEX_STORE_ENABLE=NO']
    report['command'] = command
    atomic_json(evidence/'native-build.json', report)
    try:
        with (evidence/'native-build.log').open('wb') as log:
            subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT, check=True)
        checkouts = source/'.build/checkouts'
        dependencies = [(checkouts/p['identity'], p['revision']) for p in pins['dependencies']]
        dependencies += [(checkouts/p['path'], p['revision']) for p in pins['submodules']]
        for path, revision in dependencies:
            if git(path, 'rev-parse', 'HEAD') != revision or git(path, 'status', '--porcelain'):
                raise RuntimeError('实际 Swift 依赖或子模块未通过校验：'+str(path))
        binary = runtime/'xcode-build/Build/Products/Release/hy3d'
        metal = binary.parent/'mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib'
        bin_dir = runtime/'bin'
        bin_dir.mkdir(exist_ok=True)
        subprocess.run(['swiftc', '-O', str(ROOT/'native/image3d/Foreground.swift'),
                        '-o', str(bin_dir/'foreground')], check=True)
        report.update(status='built', artifacts={str(p.relative_to(runtime)): sha256(p)
                                                for p in [binary, metal, bin_dir/'foreground']})
    except Exception as error:
        report.update(status='failed', error=str(error))
        raise
    finally:
        report['seconds'] = time.time()-report['startedAt']
        atomic_json(evidence/'native-build.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
