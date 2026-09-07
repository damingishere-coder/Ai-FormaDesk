#!/usr/bin/env python3
"""Bind the Stage A backend and browser evidence to the same output file."""
import argparse
import json
from pathlib import Path
import time

from setup import sha256
from runtime import atomic_json
from validate import glb


def accept(job):
    job = Path(job).resolve()
    run = json.loads((job / 'run.json').read_text())
    browser = json.loads((job / 'browser-report.json').read_text())
    if run.get('case') != 'full' or run.get('status') != 'backend-passed':
        raise ValueError('需要同一次完整后台运行，子探针不能代替完整链路')
    stages = run.get('stages', [])
    if [s['stage'] for s in stages] != ['shape', 'prepare', 'workflow', 'texture', 'projection']:
        raise ValueError('完整链路缺少必要阶段')
    if any(s.get('status') != 'passed' or s.get('exitCode') != 0 for s in stages):
        raise ValueError('后台阶段未全部通过')
    if run.get('input', {}).get('sha256') != sha256(job / 'reference.png'):
        raise ValueError('输入图片与运行记录不符')
    output = glb(job / 'textured.glb', require_texture=True)
    digest = sha256(job / 'textured.glb')
    if (browser.get('valid') is False or browser.get('glbSha256') != digest
            or not browser.get('loaded') or not browser.get('rotationThisRun')
            or browser.get('errors') or browser.get('pageErrors')
            or browser.get('triangles') != output['triangles']
            or not browser.get('textures')):
        raise ValueError('浏览器结果没有验证当前 GLB 的加载、纹理和实际旋转')
    image = job / 'generated-texture.png'
    if not image.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('没有真实纹理推理输出')
    result = {
        'compatibilityPassed': True, 'checkedAt': time.time(),
        'scope': 'single-view shape + AI texture + StableGen bake + browser GLB',
        'job': job.name, 'inputSha256': run['input']['sha256'],
        'glbSha256': digest, 'textureSha256': sha256(image),
        'runReportSha256': sha256(job / 'run.json'),
        'browserReportSha256': sha256(job / 'browser-report.json'),
        'executionSeconds': sum(s['seconds'] for s in stages),
        'sampledPeakGroupFootprintBytes': max(
            s['memory']['sampledPeakGroupFootprintBytes'] for s in stages),
        'textureRuntime': run['textureRuntime'],
        'visualAcceptance': 'pending-user-review', 'acceptedCategories': [],
        'limitations': ['单视角未覆盖背面', '固定相机尚未匹配原照',
                        '技术兼容性不代表照片还原精度或跨类别验收'],
    }
    atomic_json(job / 'acceptance.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    print(json.dumps(accept(parser.parse_args().job), ensure_ascii=False, indent=2))
