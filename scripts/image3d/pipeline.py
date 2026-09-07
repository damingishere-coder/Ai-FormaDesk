#!/usr/bin/env python3
"""Four-view local pipeline; reference-photo projection precedes inferred views."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

from probe import BLENDER, verify
from runtime import Runtime
from setup import ROOT, LOCK, sha256, space
from validate import glb


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--job',type=Path,required=True)
    p.add_argument('--image',type=Path,required=True)
    p.add_argument('--prompt',required=True)
    p.add_argument('--shape',type=Path,help='Reuse geometry for a texture-only subprobe')
    p.add_argument('--budget',type=int,default=1800)
    p.add_argument('--quality-handshake',action='store_true',help='Wait for the workbench to review the shape before texturing')
    args=p.parse_args()
    if not 1<=len(args.prompt)<=2000:raise ValueError('纹理描述需要 1 至 2000 个字符')
    runtime,job=args.runtime.resolve(),args.job.resolve()
    job.mkdir(parents=True,exist_ok=True)
    if (job/'run.json').exists():raise ValueError('任务目录已有记录，拒绝覆盖')
    space(job,0)
    weights=verify(runtime,{w['name'] for w in LOCK['weights']})
    sources={}
    for name,spec in LOCK['sources'].items():
        folder=runtime/'sources'/name
        commit=subprocess.check_output(['git','-C',str(folder),'rev-parse','HEAD'],text=True).strip()
        if commit!=spec['commit'] or subprocess.check_output(['git','-C',str(folder),'status','--porcelain'],text=True).strip():
            raise ValueError('上游源码版本或工作区状态不符合锁定清单：'+name)
        sources[name]=commit
    shutil.copyfile(args.image,job/'reference.png')
    r=Runtime(runtime,job,args.budget,memory_limit_bytes=12*1024**3)
    r.report.update({'case':'multiview-subprobe' if args.shape else 'multiview',
        'input':{'sha256':sha256(job/'reference.png')},'sources':sources,'weights':weights,
        'parameters':{**LOCK['defaults'],'budgetSeconds':r.budget,'views':['reference','left','right','back']},
        'visualAcceptance':'pending','categories':'experimental','texturePrompt':args.prompt,
        'adapterSha256':sha256(ROOT/'native/image3d/comfy_nodes/__init__.py'),
        'mergedLoraSha256':sha256(ROOT/'native/image3d/comfy_nodes/merged_lora.py'),
        'multiviewAdapterSha256':sha256(Path(__file__).with_name('multiview_stage.py')),
        'workflowAdapterSha256':sha256(Path(__file__).with_name('blender_stage.py'))})
    r.save()
    script=Path(__file__).parent.resolve()
    read=[BLENDER.parents[2],script,runtime/'sources/stablegen',runtime/'blender-python']
    def blender(name, adapter, arguments, target=job):
        return r.stage(name,[BLENDER,'--background','--factory-startup','--disable-autoexec','--threads','4',
            '--python-exit-code','1','--python',script/adapter,'--','--runtime',runtime,'--job',target,*arguments],read)
    def prepare(attempt, source):
        blender('prepare' if attempt==0 else 'prepare-retry','blender_stage.py',['--mode','prepare','--glb',source])
        if args.quality_handshake:
            blender(f'fit-review-{attempt}','multiview_stage.py',['--mode','fit-review'])
            r.report['cameraFit']=json.loads((job/'camera-fit.json').read_text())
        candidate=f'shape-candidate-{attempt}.glb'
        shutil.copyfile(job/'shape-preview.glb',job/candidate)
        for side in ['front','left','right','back']:
            shutil.copyfile(job/f'shape-{side}.png',job/f'shape-{attempt}-{side}.png')
        shutil.copyfile(job/'geometry.blend',job/f'geometry-{attempt}.blend')
        r.report.update(shapePreview=glb(job/candidate),shapePreviewFile=candidate);r.save()
    def review(attempt):
        if not args.quality_handshake:return {'action':'continue'}
        r.report.update(shapeReviewPending=attempt,shapeReviewRemainingSeconds=r.remaining());r.save()
        decision=job/f'shape-decision-{attempt}.json'
        while not decision.is_file():
            if r.cancelled or r.remaining()<=0:raise RuntimeError('形体检查已取消或达到处理预算')
            time.sleep(.2)
        result=json.loads(decision.read_text())
        if result.get('action') not in ['continue','regenerate','stop']:raise ValueError('无效的形体检查决定')
        r.report.setdefault('shapeReviews',[]).append(result)
        r.report.pop('shapeReviewPending',None);r.save()
        return result
    try:
        with r.acquired():
            if args.shape:
                shutil.copyfile(args.shape,job/'shape.glb')
                r.report['geometrySource']={'kind':'supplied','sha256':sha256(job/'shape.glb')}
            else:
                binary=runtime/'xcode-build/Build/Products/Release/hy3d'
                r.report['shapeRuntime']={'binarySha256':sha256(binary),
                    'metalSha256':sha256(binary.parent/'mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib')}
                r.stage('shape',[binary,'shape',job/'reference.png','-o',job/'shape.glb','--weights',runtime/'models/shape-small',
                    '--steps','30','--octree','256','--seed','42'],[binary.parent,runtime/'models/shape-small'],gpu=True)
            r.report['shapeCandidate']=glb(job/'shape.glb',triangle_limit=2_000_000);r.save()
            prepare(0,job/'shape.glb')
            decision=review(0)
            if decision['action']=='regenerate' and not args.shape:
                r.report['shapeCorrectionRounds']=1;r.save()
                r.stage('shape-retry',[binary,'shape',job/'reference.png','-o',job/'shape-retry.glb','--weights',runtime/'models/shape-small',
                    '--steps','30','--octree','256','--seed','43'],[binary.parent,runtime/'models/shape-small'],gpu=True)
                r.report['retryShapeCandidate']=glb(job/'shape-retry.glb',triangle_limit=2_000_000)
                prepare(1,job/'shape-retry.glb');decision=review(1)
            if decision['action']!='continue':
                r.report['shapePreviewFile']='shape-candidate-0.glb';r.report['shapePreview']=glb(job/'shape-candidate-0.glb');r.save()
                raise RuntimeError(decision.get('error') or '形体对照检查未通过，已保留原候选及纠错记录')
            blender('photo-projection','multiview_stage.py',['--mode','initialize'])
            r.report['cameraFit']=json.loads((job/'camera-fit.json').read_text())
            r.report['projectedViews']=1;r.save()
            for index,label in [(1,'left side'),(2,'right side'),(3,'back')]:
                target=job/f'view-{index}'
                blender(f'view-{index}','multiview_stage.py',['--mode','view','--index',str(index)])
                blender(f'workflow-{index}','blender_stage.py',['--mode','workflow','--prompt',f'{args.prompt} View from the {label}.'],target)
                r.stage(f'texture-{index}',[runtime/'comfy-venv/bin/python',script/'texture.py','--runtime',runtime,'--job',target],
                    [Path(sys.base_prefix),runtime/'comfy-venv',runtime/'sources/comfyui',runtime/'sources/ipadapter-plus',
                     runtime/'models/comfy',script,ROOT/'native/image3d/comfy_nodes'],port=8189,gpu=True,
                    extra_env={'PYTORCH_MPS_HIGH_WATERMARK_RATIO':'1.0','PYTORCH_MPS_LOW_WATERMARK_RATIO':'0.65'})
                blender(f'project-{index}','multiview_stage.py',['--mode','project','--index',str(index)])
                r.report['projectedViews']=index+1;r.save()
            blender('bake','multiview_stage.py',['--mode','bake'])
            r.report['texturedCandidate']=glb(job/'textured.glb',require_texture=True)
            r.report['coverage']=json.loads((job/'coverage-3.json').read_text())
            r.report.update(status='backend-passed',completeBackendPipeline=not bool(args.shape))
            r.report['executionSeconds']=r.budget-r.remaining()
            r.save()
    except Exception as error:
        r.report['error']=str(error)
        if r.report.get('shapePreview') and r.report.get('status')!='cancelled':r.report['status']='partial'
        r.save();raise
    print(json.dumps(r.report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr);sys.exit(1)
