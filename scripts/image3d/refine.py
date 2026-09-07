#!/usr/bin/env python3
"""Isolated single-view texture edit; shares the workbench inference lease."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from probe import BLENDER,verify
from runtime import Runtime
from setup import ROOT,LOCK,sha256,space


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime',type=Path,required=True);parser.add_argument('--job',type=Path,required=True)
    parser.add_argument('--prompt',required=True);parser.add_argument('--budget',type=int,default=1800)
    args=parser.parse_args();runtime=args.runtime.resolve();job=args.job.resolve()
    if not 1<=len(args.prompt)<=2000:raise ValueError('纹理描述需要 1 至 2000 个字符')
    if (job/'run.json').exists():raise ValueError('候选目录已有记录，拒绝覆盖')
    preflight_started=time.monotonic()
    space(job,0)
    weights=verify(runtime,{w['name'] for w in LOCK['weights'] if w['name']!='shape-small'},preflight_started+min(1800,max(1,args.budget)))
    sources={}
    for name in ['stablegen','comfyui','ipadapter-plus']:
        folder=runtime/'sources'/name;commit=subprocess.check_output(['git','-C',str(folder),'rev-parse','HEAD'],text=True).strip()
        if commit!=LOCK['sources'][name]['commit'] or subprocess.check_output(['git','-C',str(folder),'status','--porcelain'],text=True).strip():raise ValueError('依赖不符合锁定清单：'+name)
        sources[name]=commit
    r=Runtime(runtime,job,args.budget,memory_limit_bytes=12*1024**3)
    r.report.update(case='surface-refine',sources=sources,weights=weights,texturePrompt=args.prompt,parameters=LOCK['defaults']['texture'],
        sourceBlendSha256=sha256(job/'base.blend'),requestSha256=sha256(job/'request.json'),maskSha256=sha256(job/'selection.png'),adapterSha256=sha256(Path(__file__).with_name('refine_stage.py')))
    r.report['runtimeAdapters']={name:sha256(ROOT/name) for name in ['native/image3d/comfy_nodes/__init__.py',
        'native/image3d/comfy_nodes/merged_lora.py','scripts/image3d/blender_stage.py','scripts/image3d/texture.py']}
    r.report['supervisorSha256']=sha256(Path(__file__))
    r.save();script=ROOT/'scripts/image3d'
    def blender(stage,adapter,arguments):
        r.stage(stage,[BLENDER,'--background','--factory-startup','--disable-autoexec','--threads','4','--python-exit-code','1','--python',script/adapter,'--','--runtime',runtime,'--job',job,*arguments],
            [BLENDER.parents[2],script,runtime/'sources/stablegen',runtime/'blender-python'])
    try:
        preflight=time.monotonic()-preflight_started
        r.report['preflightSeconds']=preflight;r.budget-=preflight;r.save()
        if r.budget<=0:raise RuntimeError('权重与运行环境校验已达到处理预算，未开始推理')
        with r.acquired():
            blender('prepare-refine','refine_stage.py',['--mode','prepare'])
            blender('workflow','blender_stage.py',['--mode','workflow','--prompt',args.prompt])
            r.stage('texture',[runtime/'comfy-venv/bin/python',script/'texture.py','--runtime',runtime,'--job',job],
                [Path(sys.base_prefix),runtime/'comfy-venv',runtime/'sources/comfyui',runtime/'sources/ipadapter-plus',runtime/'models/comfy',script,ROOT/'native/image3d/comfy_nodes'],
                port=8189,gpu=True,extra_env={'PYTORCH_MPS_HIGH_WATERMARK_RATIO':'1.0','PYTORCH_MPS_LOW_WATERMARK_RATIO':'0.65'})
            blender('project-refine','refine_stage.py',['--mode','apply'])
            if 'storedCameraIndex' in json.loads((job/'request.json').read_text()):
                blender('review-refine','refine_stage.py',['--mode','review'])
            r.report.update(status='backend-passed',result=json.loads((job/'refine-report.json').read_text()),executionSeconds=preflight+r.budget-r.remaining());r.save()
    except Exception as error:
        r.report['error']=str(error)
        r.report['executionSeconds']=preflight+(r.budget-r.remaining() if r.started is not None else 0)
        if r.report.get('status')=='queued':r.report['status']='failed'
        r.save();raise
    print('FORMA_LOCAL_REFINE_OK')


if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr);sys.exit(1)
