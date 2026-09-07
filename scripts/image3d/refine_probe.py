#!/usr/bin/env python3
"""Real Blender projection invariant test; synthetic paint, no AI quality claim."""
import argparse
import json
from pathlib import Path
import shutil
from PIL import Image,ImageDraw
from runtime import Runtime
from probe import BLENDER
from setup import ROOT

parser=argparse.ArgumentParser();parser.add_argument('--runtime',type=Path,required=True);parser.add_argument('--job',type=Path,required=True);parser.add_argument('--source',type=Path,required=True)
args=parser.parse_args();runtime=args.runtime.resolve();job=args.job.resolve();job.mkdir(exist_ok=False)
shutil.copyfile(args.source/'scene.blend',job/'base.blend')
scene=json.loads((args.source/'scene.json').read_text());obj=next(o for o in scene['objects'] if o['type']=='MESH' and o.get('subjectId'))
(job/'request.json').write_text(json.dumps({'objectId':obj['id'],'camera':{'position':[1.1,.6,1.5],'target':[0,0,0],'up':[0,1,0],'fov':45,'aspect':1.5}}))
mask=Image.new('L',(768,512));ImageDraw.Draw(mask).rectangle((250,120,490,360),fill=255);mask.save(job/'selection.png')
Image.new('RGBA',(512,512),(30,150,90,255)).save(job/'generated-texture.png')
audit=job/'audit.py';audit.write_text('''import bpy,sys,json,hashlib\nfrom pathlib import Path\njob=Path(sys.argv[-1])\ndef digest(name):\n bpy.ops.wm.open_mainfile(filepath=str(job/name),load_ui=False,use_scripts=False)\n values=[]\n for o in bpy.context.scene.objects:\n  entry=[o.get('forma_id'),o.name,o.type,list(o.matrix_world),o.parent.get('forma_id') if o.parent else None]\n  entry[3]=[list(row) for row in entry[3]]\n  if o.type=='MESH':\n   m=o.data;entry.extend([[list(v.co) for v in m.vertices],[list(p.vertices) for p in m.polygons],[[list(d.uv) for d in u.data] for u in m.uv_layers]])\n  values.append(entry)\n return hashlib.sha256(json.dumps(values,sort_keys=True).encode()).hexdigest()\nbefore=digest('base.blend');after=digest('refined.blend')\nassert before==after,(before,after)\n(job/'geometry-audit.json').write_text(json.dumps({'sameGeometryUVsIDsParentsTransforms':True,'before':before,'after':after},indent=2))\nprint('GEOMETRY_INVARIANTS_OK')\n''')
r=Runtime(runtime,job)
with r.acquired():
 for mode in ['prepare','apply']:
  r.stage(mode,[BLENDER,'--background','--factory-startup','--disable-autoexec','--threads','4','--python-exit-code','1','--python',ROOT/'scripts/image3d/refine_stage.py','--','--runtime',runtime,'--job',job,'--mode',mode],
   [BLENDER.parents[2],ROOT/'scripts/image3d',runtime/'blender-python'])
 r.stage('audit',[BLENDER,'--background','--factory-startup','--disable-autoexec','--threads','4','--python-exit-code','1','--python',audit,'--',job],[BLENDER.parents[2]])
 r.report['status']='passed';r.save()
print('REFINE_PROJECTION_PROBE_OK')
