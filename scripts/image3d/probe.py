#!/usr/bin/env python3
"""Reproducible Stage A gate. A successful sub-probe is never full acceptance."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

from runtime import Runtime, atomic_json
from setup import LOCK, ROOT, sha256, space
from validate import glb

BLENDER=Path('/Applications/Blender 4.5 LTS.app/Contents/MacOS/Blender')


def verify(runtime, names):
    evidence=[]
    for spec in LOCK['weights']:
        if spec['name'] not in names:continue
        file=runtime/'models'/spec['path']
        if not file.is_file():raise RuntimeError('尚未安装并校验权重：'+spec['name'])
        if file.resolve()!=file:raise RuntimeError('模型权重路径不允许符号链接：'+spec['name'])
        if file.stat().st_size!=spec['size'] or sha256(file)!=spec['sha256']:
            raise RuntimeError('权重校验失败，拒绝推理：'+spec['name'])
        evidence.append(spec)
    return evidence


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,default=ROOT/'data/image3d-runtime')
    p.add_argument('--job',type=Path,required=True)
    p.add_argument('--case',choices=['foreground','projection','prepare','workflow','environment','shape','texture','full'],required=True)
    p.add_argument('--image',type=Path)
    p.add_argument('--blend',type=Path)
    p.add_argument('--glb',type=Path)
    p.add_argument('--budget',type=int,default=1800)
    p.add_argument('--atlas',type=int,choices=[256,512,1024,2048],default=512)
    p.add_argument('--prompt',default='a blue ceramic vase, realistic surface, single object')
    args=p.parse_args()
    if not 1<=len(args.prompt)<=2000:p.error('纹理描述需要 1 至 2000 个字符')
    runtime,job=args.runtime.resolve(),args.job.resolve()
    job.mkdir(parents=True,exist_ok=True)
    if (job/'run.json').exists():
        raise RuntimeError('探针目录已有报告；请使用新目录以保留历史证据')
    space(job,0)
    all_weights={w['name'] for w in LOCK['weights']}
    selected={'shape':{'shape-small'},'full':all_weights,
              'texture':all_weights-{'shape-small'}}.get(args.case,set())
    weights=verify(runtime,selected)
    sources={}
    texture_sources={'stablegen','comfyui','ipadapter-plus'}
    needed={'shape':{'hunyuan-swift'},'projection':{'stablegen'},'workflow':{'stablegen'},
            'environment':texture_sources,'texture':texture_sources,
            'full':set(LOCK['sources'])}.get(args.case,set())
    for name in needed:
        folder=runtime/'sources'/name
        commit=subprocess.check_output(['git','-C',str(folder),'rev-parse','HEAD'],text=True).strip()
        if commit!=LOCK['sources'][name]['commit']:raise RuntimeError('源码版本不符：'+name)
        if subprocess.check_output(['git','-C',str(folder),'status','--porcelain'],text=True).strip():
            raise RuntimeError('源码有未记录改动：'+name)
        sources[name]=commit
    if args.case not in ['workflow','environment']:
        if not args.image:p.error('需要 --image')
        shutil.copyfile(args.image,job/'reference.png')
    r=Runtime(runtime,job,args.budget)
    r.report.update({'case':args.case,'sources':sources,'weights':weights,
                     'parameters':{**LOCK['defaults'],'budgetSeconds':r.budget,
                                   'texture':{**LOCK['defaults']['texture'],'atlas':args.atlas}},
                     'visualAcceptance':'pending','categories':'experimental'})
    r.report['texturePrompt']=args.prompt
    if (job/'reference.png').exists():
        r.report['input']={'file':'reference.png','sha256':sha256(job/'reference.png'),
                           'bytes':(job/'reference.png').stat().st_size}
    r.save()
    script=Path(__file__).with_name('blender_stage.py').resolve()
    app=BLENDER.parents[2]
    read=[app,script.parent,runtime/'sources/stablegen',runtime/'blender-python']
    blender=[BLENDER,'--background','--factory-startup','--disable-autoexec','--threads','4',
             '--python-exit-code','1','--python',script,'--','--runtime',runtime,'--job',job]
    def stage(name,command,roots,**kwargs):
        print(json.dumps({'stage':name,'status':'running'},ensure_ascii=False),flush=True)
        result=r.stage(name,command,roots,**kwargs)
        print(json.dumps(result,ensure_ascii=False),flush=True)
    try:
        with r.acquired():
            if args.case=='foreground':
                stage('foreground',[runtime/'bin/foreground',job/'reference.png',job/'foreground'],[runtime/'bin'])
            if args.case in ['shape','full']:
                binary=runtime/'xcode-build/Build/Products/Release/hy3d'
                metal=binary.parent/'mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib'
                if not binary.is_file() or not metal.is_file():
                    raise RuntimeError('缺少 Xcode Release 程序或 Metal 着色器；请先完成构建')
                r.report['shapeRuntime']={'binarySha256':sha256(binary),'metalSha256':sha256(metal)}
                stage('shape',[binary,'shape',job/'reference.png','-o',job/'shape.glb',
                               '--weights',runtime/'models/shape-small','--steps','30','--octree','256','--seed','42'],
                      [binary.resolve().parent,runtime/'models/shape-small'],gpu=True)
                r.report['shapeCandidate']=glb(job/'shape.glb',triangle_limit=2_000_000)
                r.save()
            if args.case in ['prepare','texture','full']:
                if args.case in ['prepare','texture']:
                    if not args.glb:p.error('准备探针需要 --glb')
                    shutil.copyfile(args.glb,job/'shape.glb')
                    r.report['shapeCandidate']=glb(job/'shape.glb',triangle_limit=2_000_000)
                    r.report['shapeSource']='supplied-mesh'
                stage('prepare',[*blender,'--mode','prepare','--glb',job/'shape.glb'],read)
                r.report['shapePreview']=glb(job/'shape-preview.glb')
                r.save()
            if args.case in ['workflow','environment','texture','full']:
                stage('workflow',[*blender,'--mode','workflow','--prompt',args.prompt],read)
            if args.case in ['environment','texture','full']:
                python=runtime/'comfy-venv/bin/python'
                texture_script=Path(__file__).with_name('texture.py').resolve()
                stage('texture',[python,texture_script,'--runtime',runtime,'--job',job,
                                 *(['--check-only'] if args.case=='environment' else [])],
                      [Path(sys.base_prefix),runtime/'comfy-venv',runtime/'sources/comfyui',
                       runtime/'sources/ipadapter-plus',runtime/'models/comfy',script.parent],port=8189,gpu=True)
            if args.case in ['projection','texture','full']:
                if args.case=='projection':
                    if not args.blend:p.error('投射探针需要 --blend')
                    shutil.copyfile(args.blend,job/'geometry.blend')
                texture=job/('reference.png' if args.case=='projection' else 'generated-texture.png')
                stage('projection',[*blender,'--blend',job/'geometry.blend','--texture',texture,'--atlas',str(args.atlas)],read)
                r.report['texturedCandidate']=glb(job/'textured.glb',require_texture=True)
            r.report.update({'status':'subprobe-passed' if args.case!='full' else 'backend-passed',
                             'completeBackendPipeline':args.case=='full',
                             'completePipeline':False,'visualAcceptance':'pending'})
            r.save()
    except Exception as error:
        r.report['error']=str(error)
        if (r.report.get('shapeCandidate') or r.report.get('shapePreview')) and r.report.get('status') not in ['cancelled']:
            r.report['status']='partial'
        r.save()
        raise
    print(json.dumps(r.report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
