"""One local ComfyUI inference, run under the Stage A supervisor's sandbox.

The workbench never submits arbitrary workflow JSON: the pinned StableGen
adapter prepares the workflow in this job. The server has no external network.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
import socket


def assert_port_available(port):
    # A cancelled server can leave TIME_WAIT sockets. Reuse that socket state,
    # while bind + listen still rejects an unrelated live listener.
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        sock.bind(('127.0.0.1',port))
        sock.listen(1)


def request(port, path, value=None):
    data = None if value is None else json.dumps(value).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=data,
                                 headers={'Content-Type':'application/json'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=5) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail=error.read(8192).decode('utf-8',errors='replace')
        raise RuntimeError(f'ComfyUI {path} 返回 {error.code}：{detail}') from error


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--job',type=Path,required=True)
    p.add_argument('--port',type=int,default=8189)
    p.add_argument('--check-only',action='store_true')
    args=p.parse_args()
    runtime,job=args.runtime.resolve(),args.job.resolve()
    mps_checked=False
    if args.check_only:
        import torch
        if not torch.backends.mps.is_available():raise RuntimeError('MPS GPU 后端不可用')
        matrix=torch.ones((64,64),device='mps',dtype=torch.float16)
        product=matrix@matrix
        torch.mps.synchronize()
        if float(product[0,0].cpu())!=64.:raise RuntimeError('MPS 实际矩阵运算失败')
        del matrix,product
        torch.mps.empty_cache()
        mps_checked=True
    base=job/'comfy'
    for folder in ['input','output','temp','custom_nodes','user']:
        (base/folder).mkdir(parents=True,exist_ok=True)
    node=base/'custom_nodes/ComfyUI_IPAdapter_plus'
    if not node.exists():node.symlink_to(runtime/'sources/ipadapter-plus',target_is_directory=True)
    adapter=base/'custom_nodes/FormaDesk'
    if not adapter.exists():adapter.symlink_to(Path(__file__).resolve().parents[2]/'native/image3d/comfy_nodes',target_is_directory=True)
    if not args.check_only:
        for name in ['reference.png','depth.png']:
            shutil.copyfile(job/name,base/'input'/name)
        if (job/'context.png').is_file():shutil.copyfile(job/'context.png',base/'input/context.png')
    # Explicit paths; no first-use model downloads, no shared ComfyUI installation.
    config=job/'extra-model-paths.yaml'
    config.write_text('formadesk:\n  base_path: '+json.dumps(str(runtime/'models/comfy'))+'\n'+
                      ''.join(f'  {key}: {key}\n' for key in ['checkpoints','controlnet','loras','ipadapter','clip_vision']))
    workflow=json.loads((job/'workflow.json').read_text())
    allowed={'CheckpointLoaderSimple','CLIPTextEncode','CLIPSetLastLayer','LoraLoader','LoraLoaderBypassModelOnly',
             'FormaConditioning','FormaDiffusionModel','FormaDecodeVAE','IPAdapterModelLoader','IPAdapterEmbeds',
             'FormaIPModel','FormaDepthModel','FormaMergedLoRA',
             'EmptyLatentImage','KSampler','VAEDecode','SaveImage','LoadImage',
             'IPAdapterUnifiedLoader','IPAdapterAdvanced','IPAdapter','ControlNetLoader','ControlNetApplyAdvanced'}
    for node in workflow['prompt'].values():
        if node['class_type'] not in allowed:
            raise RuntimeError('工作流包含阶段 A 未允许的节点：'+node['class_type'])
    command=[sys.executable,str(runtime/'sources/comfyui/main.py'),
             '--base-directory',str(base),'--extra-model-paths-config',str(config),
             '--listen','127.0.0.1','--port',str(args.port),'--lowvram','--force-fp16',
             '--cpu-vae','--fp32-vae','--cache-none',
             '--use-split-cross-attention',
             '--disable-auto-launch','--disable-api-nodes','--disable-metadata']
    # Refuse to talk to an unrelated server occupying this port.
    assert_port_available(args.port)
    with (job/'comfy-server.log').open('wb') as log:
        child=subprocess.Popen(command,cwd=job,stdout=log,stderr=subprocess.STDOUT)
        started=time.monotonic()
        try:
            while True:
                if child.poll() is not None:raise RuntimeError(f'ComfyUI 启动失败：{child.returncode}')
                if time.monotonic()-started>180:raise RuntimeError('ComfyUI 启动超时')
                try:
                    request(args.port,'/system_stats');break
                except (OSError,ValueError):time.sleep(.5)
            available=request(args.port,'/object_info')
            missing=sorted({n['class_type'] for n in workflow['prompt'].values()}-set(available))
            if missing:raise RuntimeError('ComfyUI 缺少节点：'+', '.join(missing))
            if args.check_only:
                (job/'comfy-environment.json').write_text(json.dumps({
                    'availableNodes':sorted({n['class_type'] for n in workflow['prompt'].values()}),
                    'system':request(args.port,'/system_stats'),'mpsComputeTested':mps_checked,
                    'aiInferenceTested':False},indent=2))
                print('COMFY_ENVIRONMENT_OK',flush=True)
                return
            submitted=request(args.port,'/prompt',{'prompt':workflow['prompt']})
            prompt_id=submitted['prompt_id']
            while True:
                if child.poll() is not None:raise RuntimeError('ComfyUI 推理进程异常退出')
                history=request(args.port,f'/history/{prompt_id}').get(prompt_id)
                if history:
                    (job/'comfy-result.json').write_text(json.dumps(history,ensure_ascii=False,indent=2))
                    if history.get('status',{}).get('status_str')!='success':
                        raise RuntimeError('ComfyUI 推理失败，见 comfy-result.json')
                    images=history['outputs'][workflow['outputNode']]['images']
                    image=images[0]
                    source=(base/'output'/image.get('subfolder','')/image['filename']).resolve()
                    if image.get('type')!='output' or not source.is_relative_to((base/'output').resolve()):
                        raise RuntimeError('ComfyUI 返回了任务目录之外的图片')
                    shutil.copyfile(source,job/'generated-texture.png')
                    break
                time.sleep(.5)
            print(json.dumps({'event':'texture-inference-complete','seconds':time.monotonic()-started,'promptId':prompt_id}))
        finally:
            child.terminate()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill();child.wait()


if __name__=='__main__':main()
