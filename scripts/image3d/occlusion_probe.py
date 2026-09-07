#!/usr/bin/env python3
"""Real Blender test for occlusion, shared assets, and overlapping UV rejection."""
import argparse
import json
from pathlib import Path
from PIL import Image
from probe import BLENDER
from runtime import Runtime,StageFailure
from setup import ROOT

p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--job',type=Path,required=True);args=p.parse_args()
runtime=args.runtime.resolve();job=args.job.resolve();job.mkdir(exist_ok=False)
Image.new('RGBA',(128,128),(30,40,50,255)).save(job/'fixture-atlas.png')
Image.new('RGBA',(512,512),(200,60,90,255)).save(job/'generated-texture.png')
Image.new('L',(512,512),255).save(job/'selection.png')
(job/'request.json').write_text(json.dumps({'objectId':'00000000-0000-4000-8000-000000000001','camera':{'position':[0,3,0],'target':[0,0,0],'up':[0,0,-1],'fov':45,'aspect':1}}))
fixture=job/'fixture.py';fixture.write_text('''import bpy,sys\nfrom pathlib import Path\njob=Path(sys.argv[-1]);bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)\nimage=bpy.data.images.load(str(job/'fixture-atlas.png'));image.pack()\nmat=bpy.data.materials.new('shared');mat.use_nodes=True;node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=image;mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])\ndef plane(name,verts):\n m=bpy.data.meshes.new(name);m.from_pydata(verts,[],[(0,1,2,3)]);m.uv_layers.new(name='UVMap')\n for d,v in zip(m.uv_layers.active.data,[(0,0),(1,0),(1,1),(0,1)]):d.uv=v\n o=bpy.data.objects.new(name,m);bpy.context.scene.collection.objects.link(o);o.data.materials.append(mat);return o\ntarget=plane('Target',[(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0)]);target['forma_id']='00000000-0000-4000-8000-000000000001'\nother=target.copy();bpy.context.scene.collection.objects.link(other);other.name='Shared duplicate';other.location.x=4;other['forma_id']='00000000-0000-4000-8000-000000000002'\nplane('Occluder',[(-1.1,-1.1,.1),(0,-1.1,.1),(0,1.1,.1),(-1.1,1.1,.1)])\nbpy.context.preferences.filepaths.save_version=0;bpy.ops.wm.save_as_mainfile(filepath=str(job/'base.blend'),check_existing=False)\n''')
audit=job/'audit.py';audit.write_text('''import bpy,sys,json\nfrom pathlib import Path\nsys.path.append(sys.argv[-2]);import numpy as np\nfrom PIL import Image\njob=Path(sys.argv[-1]);original=np.array(Image.open(job/'original-atlas.png'));after=np.array(Image.open(job/'refined-atlas.png'))\nassert np.array_equal(original[:,:60],after[:,:60]),'Paint penetrated front occluder'\nassert np.all(after[10:118,75:118,:3]==[200,60,90]),'Visible target was not painted'\nbpy.ops.wm.open_mainfile(filepath=str(job/'refined.blend'),load_ui=False,use_scripts=False)\nother=bpy.data.objects['Shared duplicate'];image=next(n.image for n in other.active_material.node_tree.nodes if n.type=='TEX_IMAGE')\nassert bytes(image.packed_file.data)==(job/'fixture-atlas.png').read_bytes(),'Shared duplicate was recolored'\nassert other.data!=bpy.data.objects['Target'].data,'Shared mesh was not isolated'\n(job/'occlusion-report.json').write_text(json.dumps({'occludedPixelsUnchanged':True,'visiblePixelsChanged':True,'sharedDuplicateUnchanged':True},indent=2))\nprint('OCCLUSION_AND_SHARING_OK')\n''')
r=Runtime(runtime,job)
with r.acquired():
 reads=[BLENDER.parents[2],ROOT/'scripts/image3d',runtime/'blender-python']
 def stage(name,script,arguments):
  r.stage(name,[BLENDER,'--background','--factory-startup','--disable-autoexec','--threads','4','--python-exit-code','1','--python',script,'--',*arguments],reads)
 stage('fixture',fixture,[job])
 for mode in ['prepare','apply']:stage(mode,ROOT/'scripts/image3d/refine_stage.py',['--runtime',runtime,'--job',job,'--mode',mode])
 stage('audit',audit,[runtime/'blender-python',job])
 overlap=job/'overlap.py';overlap.write_text('''import bpy,sys\nfrom pathlib import Path\njob=Path(sys.argv[-1]);bpy.ops.wm.open_mainfile(filepath=str(job/'base.blend'),load_ui=False,use_scripts=False)\no=bpy.data.objects['Target'];m=bpy.data.meshes.new('Overlapping UV');m.from_pydata([(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0),(-1,-1,-.2),(1,-1,-.2),(1,1,-.2),(-1,1,-.2)],[],[(0,1,2,3),(4,5,6,7)]);m.uv_layers.new(name='UVMap')\nfor d,v in zip(m.uv_layers.active.data,[(0,0),(1,0),(1,1),(0,1)]*2):d.uv=v\nm.materials.append(o.active_material);o.data=m;bpy.ops.wm.save_as_mainfile(filepath=str(job/'base.blend'),check_existing=False)\n''')
 stage('overlap-fixture',overlap,[job])
 before=(job/'refined.blend').read_bytes()
 try:stage('overlap-rejected',ROOT/'scripts/image3d/refine_stage.py',['--runtime',runtime,'--job',job,'--mode','apply'])
 except StageFailure:
  assert '重叠 UV' in (job/'overlap-rejected/stderr.log').read_text()
  assert before==(job/'refined.blend').read_bytes(),'Failed overlap edit overwrote previous result'
 else:raise AssertionError('Overlapping UV was accepted')
 r.report.update(status='passed',overlapRejected=True);r.save()
print('OCCLUSION_PROBE_OK')
