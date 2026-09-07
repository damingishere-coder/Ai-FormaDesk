#!/usr/bin/env python3
"""Build a local, portable visual report from real category jobs, never approve them."""
import argparse
import html
import json
from pathlib import Path
import shutil

p=argparse.ArgumentParser();p.add_argument('--batch',type=Path,required=True);p.add_argument('--data',type=Path,required=True);p.add_argument('--samples',type=Path,required=True);p.add_argument('--private-photo',type=Path);args=p.parse_args()
report=json.loads((args.batch/'category-report.json').read_text());output=args.batch/'visual-report';output.mkdir(exist_ok=True)
sources={s['file']:s for s in json.loads((Path(__file__).resolve().parents[2]/'image3d/samples.lock.json').read_text())['samples']}
categories={'object':'日常物品','animal':'动物','building':'建筑','person':'人物','plant':'植物'}
statuses={'partial':'部分完成，未通过质检','succeeded':'技术流程完成，待用户视觉验收','failed':'生成失败','cancelled':'已取消','started':'尚未完成','needs-subject-selection':'需要选择主体','probe-failed':'验收流程异常'}
articles=[]
for index,sample in enumerate(report['samples']):
    figures=[]
    source=args.private_photo if sample['file']=='private-cat-reference.png' else args.samples/sample['file']
    job=args.data/'jobs'/sample.get('jobId','missing')/'attempt-0'/'inference'
    candidates=[('原始照片',source)]
    run=json.loads((job/'run.json').read_text()) if (job/'run.json').is_file() else {}
    if (job/'textured.glb').is_file():
        candidates.extend((label,job/f'textured-view-{i}.png') for i,label in enumerate(['正面纹理','左侧纹理','右侧纹理','背面纹理（推测）']))
    else:
        selected=0 if run.get('shapePreviewFile')=='shape-candidate-0.glb' else min(1,len(run.get('shapeReviews',[]))-1)
        selected=max(0,selected)
        for side,label in [('front','正面形体'),('left','左侧形体'),('right','右侧形体'),('back','背面形体（推测）')]:
            f=job/f'shape-{selected}-{side}.png'
            candidates.append((label,f if f.is_file() else job/f'shape-{side}.png'))
    for number,(label,file) in enumerate(candidates):
        if file is None or not file.is_file():continue
        name=f'{index}-{number}{file.suffix}'
        shutil.copyfile(file,output/name)
        figures.append(f'<figure><img src="{name}" loading="lazy" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>')
    summary=sample.get('qualitySummary') or sample.get('error') or '尚未完成'
    checks=run.get('shapeReviews',[])
    details=''.join(f'<li>形体检查 {i+1}：{html.escape(v.get("quality",{}).get("summary",v.get("error","未完成")))}</li>' for i,v in enumerate(checks))
    source=sources.get(sample['file'])
    credit=f'<a href="{html.escape(source["sourcePage"],quote=True)}">原图：{html.escape(source["author"])}</a> · {html.escape(source["license"])}' if source else '用户提供的私人照片，仅用于本机验收'
    seconds=sum(s.get('seconds',0) for s in run.get('stages',[]))
    timing=f'模型及 Blender 阶段合计 {seconds:.1f} 秒，不含 GPT 检查和排队。' if seconds else '耗时正在测量。'
    articles.append(f'<article><h2>{categories[sample["category"]]} · 样本 {index+1}</h2><p class="status">实验性 · {html.escape(statuses.get(sample["status"],sample["status"]))}</p><p>{html.escape(summary)}</p><div class="images">{"".join(figures)}</div><p>{credit}</p><p>输入限制：{html.escape(sample.get("inputLimitations",""))}</p><ul>{details}</ul><p>{timing}</p><small>任务：{html.escape(sample.get("jobId","尚未生成"))}</small></article>')
page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ai-FormaDesk 本机跨类别对照</title><style>body{font:15px/1.7 system-ui;background:#f3f5f2;color:#26352e;margin:0;padding:36px}main{max-width:1440px;margin:auto}h1{font-size:30px}article{background:white;border:1px solid #dbe1d9;border-radius:18px;padding:22px;margin:24px 0}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}figure{margin:0}img{width:100%;height:270px;object-fit:contain;background:#e6eae4}figcaption{padding:8px}.status{color:#866431}small{color:#6a786d}header{max-width:980px}li{margin:8px 0}</style><main><header><h1>照片与本机模型对照</h1><p>以下为真实任务的原图和模型输出。文件生成或自动质检通过，不等于用户认可照片还原质量。所有类别目前仍为实验性；未完成上色时显示灰模，不用灰模代替完整结果。背面和不可见结构属于推测。</p></header>'''+''.join(articles)+'</main></html>'
(output/'index.html').write_text(page)
print(output/'index.html')
