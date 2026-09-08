"""Build a loopback-only review artifact from real PhotoFit experiment records."""
import argparse
import html
import json
from pathlib import Path
import shutil


def build(batch, output):
    output.mkdir(exist_ok=False, parents=True)
    cards=[]
    results=[]
    for index,file in enumerate(sorted(batch.glob('*/experiment.json'))):
        result=json.loads(file.read_text())
        name=file.parent.name
        folder=output/str(index);folder.mkdir()
        def copy_image(source, target):
            if not source.is_file(): return ''
            shutil.copyfile(source,folder/target)
            return f'<img loading="lazy" src="{index}/{target}" alt="{html.escape(target)}">'
        reference=copy_image(file.parent/'reference.png','reference.png')
        initial=result.get('initial') or {}
        best=result.get('best') or {}
        primary=[f'<figure>{reference}<figcaption>参考主体</figcaption></figure>']
        cells=[]
        for label,stage,prefix in [('初始形体',initial,'before'),('最佳候选',best,'after')]:
            for side in ('front','left','right','back'):
                img=copy_image(Path(stage.get('directory','/nonexistent'))/(side+'.png'),prefix+'-'+side+'.png')
                if img:
                    direction={'front':'照片视角','left':'左侧','right':'右侧','back':'背面'}[side]
                    (primary if side=='front' else cells).append(f'<figure>{img}<figcaption>{label} · {direction}</figcaption></figure>')
        delta='尚未完成可比较的形体'
        if initial.get('metrics') and best.get('metrics'):
            a,b=initial['metrics']['silhouetteError'],best['metrics']['silhouetteError']
            delta=f'轮廓误差 {a:.4f} → {b:.4f}；变化 {b-a:+.4f}（越低越好，仅衡量轮廓）'
        rounds=[]
        for round in result.get('corrections',[]):
            text=round['proposal']['summary']+'；'+round.get('reason', '已保留改善候选' if round.get('accepted') else '未采用')
            rounds.append('<li>'+html.escape(text)+'</li>')
        download=''
        diagnostics=[]
        for filename,label in [('overlay.png','轮廓叠加'),('difference.png','差异图：红色多出，绿色缺失')]:
            img=copy_image(Path(best.get('directory','/nonexistent'))/filename,filename)
            if img: diagnostics.append(f'<figure>{img}<figcaption>{label}</figcaption></figure>')
        glb=Path(best.get('directory','/nonexistent'))/'preview.glb'
        if glb.is_file():
            shutil.copyfile(glb,folder/'candidate.glb')
            download=f'<a download href="{index}/candidate.glb">下载候选 GLB</a>'
        category,_,strategy=name.partition('-')
        title={'cat':'猫咪','building':'建筑','chair':'椅子','plant':'盆栽'}.get(category,category)+' · '+{'mesh':'底模局部修形','script':'参数化脚本'}.get(strategy,strategy)
        status={'running':'正在执行','partial':'保留候选','failed':'执行失败','cancelled':'已取消'}.get(result['status'],result['status'])
        mechanism='局部纠错有效，整体质量仍待验收' if result.get('mechanismImproved') else '尚未确认改善'
        cards.append(f'<article><h2>{html.escape(title)}</h2><p>{html.escape(delta)}</p><p>状态：{status} · {mechanism}</p><div class="views">{"".join(primary)}</div><details><summary>查看轮廓差异</summary><div class="views">{"".join(diagnostics)}</div></details><details><summary>检查侧面和背面</summary><div class="views">{"".join(cells)}</div></details><ol>{"".join(rounds)}</ol><p>{html.escape(result.get("error", ""))}</p>{download}</article>')
        results.append({'name':name,'status':result['status'],'mechanismImproved':bool(result.get('mechanismImproved'))})
    document='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PhotoFit V2 · 阶段 A 实测</title><style>body{font:16px system-ui;margin:32px;background:#f5f5f3;color:#222}article{background:white;border-radius:16px;padding:22px;margin:24px 0}.views{display:grid;grid-template-columns:repeat(3,minmax(130px,1fr));gap:12px}figure{margin:0}img{width:100%;background:#ddd;border-radius:8px}figcaption{font-size:13px;margin:6px 0}p,li{line-height:1.7}a{color:#235b97}summary{cursor:pointer;margin:12px 0}@media(max-width:800px){.views{grid-template-columns:repeat(1,1fr)}} </style><h1>GPT＋Blender 照片修形：阶段 A</h1><p>全部来自真实执行。灰模用于检查几何；未上色不代表纹理失败。侧背面只检查合理性。机制改善不等于用户认可或通用图生建模已完成。</p>'''+''.join(cards)+'</html>'
    improved={r['name'].partition('-')[0] for r in results if r['mechanismImproved']}
    gate=f'<p><strong>固定样本改善：{len(improved)}/4；进入下一阶段要求至少 3/4。本页仅为阶段 A 实验，未完成纹理及正式作品接入。</strong></p>'
    document=document.replace('</h1>','</h1>'+gate,1)
    (output/'index.html').write_text(document)
    (output/'summary.json').write_text(json.dumps({'results':results,'acceptedCategories':[]},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('batch',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args();build(args.batch,args.output)
