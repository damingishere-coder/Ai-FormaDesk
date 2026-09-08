"""Static local report: all fixed samples, including failed trials; no category promotion."""
import json,html,shutil,argparse
from pathlib import Path

def build(batch,output,viewer=None):
 output.mkdir(parents=True,exist_ok=False);cards=[];rows=[]
 for i,f in enumerate(sorted(batch.glob('*/experiment.json'))):
  x=json.loads(f.read_text());folder=output/str(i);folder.mkdir();views=[]
  def pic(p,name,label):
   if not p.is_file():return ''
   shutil.copyfile(p,folder/name)
   return f'<figure><img loading="lazy" src="{i}/{name}" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>'
  initial=x.get('initial') or {};best=x.get('best') or {};colored=x.get('colored') or {}
  views.append(pic(f.parent/'reference.png','reference.png','原照主体'))
  views.append(pic(Path(initial.get('directory','/nonexistent'))/'front.png','initial.png','初始灰模'))
  finaldir=Path(colored.get('directory',best.get('directory','/nonexistent')))
  views.append(pic(finaldir/('color-front.png' if colored else 'front.png'),'final.png','最终彩色候选' if colored else '部分完成灰模'))
  sides=''.join(pic(finaldir/(( 'color-' if colored else '')+n+'.png'),n+'.png',label) for n,label in [('left','左侧'),('right','右侧'),('back','背面')])
  diagnostics=''.join(pic(finaldir/(n+'.png'),n+'.png',label) for n,label in [('front','最终灰模'),('overlay','原照轮廓叠加，仅辅助'),('difference','差异，非风格评分')])
  review=x.get('finalReview') or x.get('bestReview') or x.get('initialReview') or {}
  issues=''.join('<li>'+html.escape(v)+'</li>' for v in review.get('issues',[]))
  feats=x.get('features',{});featuretext='、'.join(f['name'] for f in feats.get('preserve',[]))
  rounds=[]
  for r in x.get('corrections',[]):
   trials='；'.join(str(t['strength'])+': '+t.get('error',t.get('reason',t.get('review',{}).get('summary',''))) for t in r.get('trials',[]))
   rounds.append('<li>'+html.escape(r['proposal']['summary']+'；'+('保留改善候选' if r.get('accepted') else r.get('reason','未采用')))+'<details><summary>本轮两种力度的真实结果</summary>'+html.escape(trials)+'</details></li>')
  downloads=[]
  shutil.copyfile(f,folder/'audit.json');downloads.append(f'<a href="{i}/audit.json" download>完整检查记录</a>')
  for name,label in [('preview.glb','GLB'),('candidate.blend','Blender')]:
   if (finaldir/name).is_file():shutil.copyfile(finaldir/name,folder/name);downloads.append(f'<a href="{i}/{name}" download>{label} 下载</a>')
  for source in [best.get('sourceScript'),x.get('geometryBest',{}).get('sourceScript')]:
   if source and Path(source).is_file():shutil.copyfile(source,folder/'model.py');downloads.append(f'<a href="{i}/model.py" download>参数化脚本</a>');break
  category=f.parent.name.split('-')[0];title={'cat':'猫咪','chair':'椅子','building':'建筑','plant':'盆栽'}.get(category,category)
  passed=bool(x.get('automaticPassed'));rows.append({'sample':title,'passed':passed,'userAcceptance':'pending','glb':f'{i}/preview.glb' if (folder/'preview.glb').is_file() else None})
  duration=(x.get('budgetMs',0)-x.get('remainingMs',0))/60000
  calibration='<p>本次仅校准检查照明，模型与色板未修改。上面的时间是校准任务时间；原生成记录另行保留。</p>' if x.get('calibration') else ''
  cards.append(f'<article><h2>{title}</h2><p>模型自动检查：{"通过，待用户认可" if passed else "未通过 / 部分完成"} · 有效时间 {duration:.1f} 分钟</p>{calibration}<p>保留特征：{html.escape(featuretext)}</p><div class="grid">{"".join(views)}</div><details><summary>侧面与背面</summary><div class="grid">{sides}</div></details><details><summary>几何与轮廓辅助检查</summary><div class="grid">{diagnostics}</div></details><p>{html.escape(review.get("summary",""))}</p><ul>{issues}</ul><ol>{"".join(rounds)}</ol><p>{html.escape(x.get("error",""))}</p><nav>{" · ".join(downloads)}</nav></article>')
 passed=sum(r['passed'] for r in rows)
 doc='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>风格化 V2.1 · 真实样本</title><style>body{font:16px system-ui;margin:24px;background:#f5f4ef;color:#252722}main{max-width:1440px;margin:auto}article{padding:24px;background:#fff;border-radius:18px;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}figure{margin:0}img{width:100%;background:#e9e8e3;border-radius:10px}figcaption{font-size:13px;padding:8px 0}p,li{line-height:1.7}summary{padding:12px 0;cursor:pointer}a{color:#326450}details{overflow-wrap:anywhere}@media(max-width:650px){.grid{grid-template-columns:1fr}body{margin:12px}article{padding:14px}}</style><main><h1>圆润简化 · 保留辨识特征</h1>'''+f'<p><strong>四个固定样本，自动检查通过 {passed}/4，用户认可待确认。</strong>所有结果来自真实 Blender 执行。这里展示实验候选，未覆盖作品；自动检查不代表最终风格质量。</p>'+''.join(cards)+'</main></html>'
 if viewer:
  shutil.copyfile(viewer,output/'viewer.js')
  widget='<section><label>旋转检查 <select id="viewer-select"></select></label><p id="viewer-status"></p><div id="viewer" style="height:440px;width:100%"></div></section><script type="module" src="viewer.js"></script>'
  doc=doc.replace('<article>',widget+'<article>',1)
 (output/'index.html').write_text(doc);(output/'summary.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('batch',type=Path);p.add_argument('output',type=Path);p.add_argument('--viewer',type=Path);a=p.parse_args();build(a.batch,a.output,a.viewer)
