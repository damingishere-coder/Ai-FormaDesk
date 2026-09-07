"""Run with Blender --background --factory-startup --python ... -- ROOT JOB.

Exercises the real worker and glTF exporter, including repeat edits and modifiers.
"""
import bpy
import json
from pathlib import Path
import runpy
import shutil
import sys
import uuid

root,job=map(Path,sys.argv[sys.argv.index('--')+1:])
job.mkdir(parents=True,exist_ok=True)
worker=root/'blender/worker.py'

def run(mode):
    sys.argv=['worker.py','--',mode,str(job)]
    runpy.run_path(str(worker),run_name='__main__')

def document():
    data=(job/'scene.glb').read_bytes()
    return json.loads(data[20:20+int.from_bytes(data[12:16],'little')])

bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add()
obj=bpy.context.object;oid=str(uuid.uuid4());obj['forma_id']=oid
mat=bpy.data.materials.new('Texture roundtrip');mat.use_nodes=True
obj.data.materials.append(mat)
bsdf=mat.node_tree.nodes.get('Principled BSDF')
image=bpy.data.images.new('Checker',width=2,height=2,alpha=True)
image.pixels=[1,0,0,1,0,1,0,.5,0,0,1,1,1,1,1,.5]
image.pack()
tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
mat.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
mat.node_tree.links.new(tex.outputs['Alpha'],bsdf.inputs['Alpha'])
normal=mat.node_tree.nodes.new('ShaderNodeNormalMap')
mat.node_tree.links.new(tex.outputs['Color'],normal.inputs['Color'])
mat.node_tree.links.new(normal.outputs['Normal'],bsdf.inputs['Normal'])
array=obj.modifiers.new('Evaluated count','ARRAY');array.count=3
bpy.ops.wm.save_as_mainfile(filepath=str(job/'base.blend'),check_existing=False)

for color in ['#80c0ff','#ffffff']:
    (job/'command.json').write_text(json.dumps({'objectId':oid,'operation':'material',
        'material':{'color':color,'roughness':.4,'metalness':.2}}))
    run('command');run('validate')
    doc=document();material=doc['materials'][0];pbr=material['pbrMetallicRoughness']
    assert 'baseColorTexture' in pbr,material
    assert 'normalTexture' in material,material
    assert len(doc['images'])>=1
    actual=pbr.get('baseColorFactor',[1,1,1,1])[:3]
    expected=[int(color[i:i+2],16)/255 for i in (1,3,5)]
    expected=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in expected]
    assert all(abs(a-b)<1e-5 for a,b in zip(actual,expected)),(actual,expected)
    scene=json.loads((job/'scene.json').read_text())
    assert scene['objects'][0]['id']==oid
    assert scene['objects'][0]['material']['color']==color
    assert scene['stats']['vertices']==24,scene['stats']
    assert scene['stats']['triangles']==36,scene['stats']
    # Check the active copy: repeated editing must reuse its factor node.
    active=bpy.context.scene.objects[0].active_material
    assert len([n for n in active.node_tree.nodes if n.get('forma_factor')])==1
    shutil.copyfile(job/'scene.blend',job/'base.blend')

# Explicit pure-color replacement removes only base color's image connection.
(job/'command.json').write_text(json.dumps({'objectId':oid,'operation':'material','replaceTexture':True,
    'material':{'color':'#cc8844','roughness':.4,'metalness':.2}}))
run('command');run('validate')
doc=document();material=doc['materials'][0]
active=bpy.context.scene.objects[0].active_material
bsdf=active.node_tree.nodes.get('Principled BSDF')
assert not bsdf.inputs['Base Color'].is_linked
assert bsdf.inputs['Alpha'].is_linked  # A glTF image may still carry alpha.
assert 'normalTexture' in material
(job/'test-result.json').write_text(json.dumps({'passed':True,'checks':[
    'texture and normal export','linear color factor','stable object id',
    'repeat edit reuses factor','evaluated modifier counts','explicit pure color replacement']}))
print('MATERIAL_ROUNDTRIP_OK')
