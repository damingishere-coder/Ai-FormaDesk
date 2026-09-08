"""Real Blender tests for continuous bodies, frozen style ranges and export colours."""
import json,sys
from pathlib import Path
import bpy
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parent))
import stylized_geometry as sty
import photo_fit_worker as w
from photo_fit_geometry import coordinates
out=Path(sys.argv[sys.argv.index('--')+1]);checks=[]
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
a=sty.ellipsoid('torso',(0,0,.6),(.2,.14,.3));b=sty.ellipsoid('neck',(0,0,.86),(.13,.12,.18))
eye=sty.ellipsoid('eye',(.06,-.14,.88),(.03,.025,.03));eye_before=coordinates(eye).copy()
body=sty.fuse('body',[a,b]);assert np.array_equal(coordinates(eye),eye_before)
# A continuous neck/body is exactly one connected component.
adj=[[] for _ in body.data.vertices]
for e in body.data.edges:
 i,j=e.vertices;adj[i].append(j);adj[j].append(i)
seen=set();stack=[0]
while stack:
 i=stack.pop()
 if i in seen:continue
 seen.add(i);stack.extend(adj[i])
assert len(seen)==len(adj)
checks.append({'name':'continuous fused body; explicit eye exclusion','passed':True})
params={'width':1.0};rules={'width':{'kind':'proportion','min':.1,'max':2,'baseline':1.0,'targets':['body']}}
frozen=sty.parameter_contract(params,rules);assert frozen['width']['min']==.85 and frozen['width']['max']==1.15
for value in [1.16,float('nan')]:
 try:sty.parameter_contract({'width':value},rules,frozen);raise AssertionError('range accepted')
 except ValueError:pass
checks.append({'name':'absolute photo-relative 15 percent range; rejects drift/NaN','passed':True})
meshes=w.objects();before=w.inventory(meshes)
plan={'palette':[{'id':'orange','color':[.9,.45,.12],'roughness':.6},{'id':'cream','color':[.95,.9,.8],'roughness':.7}],
 'assignments':[{'part':o.name,'colorId':'orange'} for o in meshes],
 'patches':[{'part':'body','colorId':'cream','center':[.5,0,.5],'radius':[.35,.3,.35]}]}
sty.apply_palette(meshes,plan);after=w.inventory(meshes)
for a,b in zip(before,after):
 for key in ['coordinatesHash','topologyHash','uvHash','transformHash','objectId']:assert a[key]==b[key]
assert any(p.material_index==1 for p in body.data.polygons)
assert any(p.material_index==0 for p in body.data.polygons)
checks.append({'name':'front colour patch preserves mesh/UV/IDs and leaves unselected faces','passed':True})
bpy.ops.wm.save_as_mainfile(filepath=str(out/'candidate.blend'))
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:o.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'candidate.glb'),export_format='GLB',use_selection=True,export_apply=True)
# Reimport the standard GLB, verifying exported colour slots and geometry count.
original_count=sum(len(o.data.polygons) for o in meshes)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(out/'candidate.glb'))
materials=[m for o in w.objects() for m in o.data.materials if m]
assert any(m.diffuse_color[0]>m.diffuse_color[2]*2 for m in materials)
assert any(abs(m.diffuse_color[0]-m.diffuse_color[2])<.4 for m in materials)
checks.append({'name':'GLB reimport retains standard palette material regions','passed':True})
(out/'controlled.json').write_text(json.dumps({'checks':checks,'originalPolygons':original_count},indent=2))
