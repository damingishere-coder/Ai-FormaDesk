"""Real Blender evidence: region invariants and recovery of a known shape error."""
import json
from pathlib import Path
import sys
import numpy as np
import bpy
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import photo_fit_geometry as fit
import photo_fit_worker as worker

directory = Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=.4)
obj = fit.identify(bpy.context.object, 'known-shape')
original = fit.coordinates(obj).copy()
other = obj.copy()
other.data = obj.data  # Deliberately share mesh to exercise isolation.
other.location.x = 1.3
other['forma_id'] = 'untouched-shared-data'
bpy.context.scene.collection.objects.link(other)
other.hide_render = True
other_before = fit.coordinates(other).copy()
box = worker.bounds([obj])
op = {'objectId': obj['forma_id'], 'center': [.5,.5,.8], 'radius': [.55,.55,.5],
      'translation': [.08,0,0], 'scale': [1,1,1]}
snapshot = worker.inventory([obj])[0]
report = fit.apply_local_operations([obj], [op], box)
after = worker.inventory([obj])[0]
assert report[0]['changedVertices'] > 0 and report[0]['outsideUnchanged']
assert np.array_equal(other_before, fit.coordinates(other))
for key in ('objectId','topologyHash','uvHash','transformHash','materials'):
    assert snapshot[key] == after[key], key
checks = [{'name':'local deformation preserves outside/UV/topology/transform/shared objects', 'passed': True}]
for bad in [dict(op, translation=[.5,0,0]), dict(op, objectId='missing'), dict(op, radius=[float('nan'),.5,.5])]:
    try:
        fit.apply_local_operations([obj], [bad], box)
        raise AssertionError('Unsafe operation accepted')
    except ValueError:
        pass
checks.append({'name':'invalid range, NaN and missing object rejected', 'passed': True})

# Render a reference from known geometry; distort its X proportion deliberately.
obj.data.vertices.foreach_set('co', original.ravel())
obj.data.update()
camera = worker.setup([obj])
camera.location = (0,-2,.25)
camera.rotation_euler = (-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type, camera.data.lens = 'PERSP', 50
bpy.context.view_layer.update()
fixed = worker.camera_record(camera)
anchors=worker.visible_anchors(camera,box)
assert len(anchors)>4 and all(a['objectId']==obj['forma_id'] for a in anchors)
checks.append({'name':'visible anchors raycast onto the intended mesh', 'passed':True,'anchors':len(anchors)})
reference = worker.render(directory, 'reference.png')
wrong = original.copy(); wrong[:,0] *= .7
obj.data.vertices.foreach_set('co', wrong.ravel()); obj.data.update()
before = worker.measure(directory, reference, worker.render(directory, 'before.png'), {})
trials = []
for factor in (1.15, 1.3, 1/.7):
    candidate = wrong.copy(); candidate[:,0] *= factor
    obj.data.vertices.foreach_set('co', candidate.ravel()); obj.data.update()
    worker.set_camera(camera, fixed)
    metrics = worker.measure(directory, reference, worker.render(directory, 'candidate.png'), {})
    trials.append({'factor':factor, 'error':metrics['silhouetteError']})
best = min(trials, key=lambda v:v['error'])
assert best['error'] < .01 and best['error'] < before['silhouetteError']-.1, (before,trials)
checks.append({'name':'fixed-camera parameter search recovers known 30 percent width error', 'passed': True,
               'before':before['silhouetteError'], 'best':best, 'trials':trials})

leaf = fit.leaf('thin leaf')
assert len(leaf.data.polygons) == 32
sections = [[(-.1,-.1,z),(.1,-.1,z),(.1,.1,z),(-.1,.1,z)] for z in (0,.2)]
loft = fit.loft('open loft', sections)
assert len(loft.data.polygons)==4  # Open ends are intentionally not hole-filled.
parts = fit.repeat(loft, 3, (.3,0,0))
assert len({p['forma_id'] for p in parts}) == 3
checks.append({'name':'thin surfaces, open loft and repeated independent IDs', 'passed':True})
script_dir=directory/'parameter-probe';script_dir.mkdir()
(script_dir/'generated.py').write_text("import bpy\nPARAMS={'width':0.7}\nbpy.ops.mesh.primitive_cube_add(size=1)\nbpy.context.object.name='Body'\nbpy.context.object.scale.x=PARAMS['width']\n")
(script_dir/'request.json').write_text(json.dumps({'parameters':{'width':.9},'identities':{'Body':'stable-body'}}))
sys.argv=['probe','--','script',str(script_dir)]
worker.main()
assert abs(bpy.data.objects['Body'].scale.x-.9)<1e-6
assert bpy.data.objects['Body']['forma_id']=='stable-body'
assert json.loads((script_dir/'parameters.json').read_text())['width']['value']==.9
(script_dir/'request.json').write_text(json.dumps({'parameters':{'width':2}}))
try:
    worker.main()
    raise AssertionError('Out-of-range parameter accepted')
except ValueError: pass
checks.append({'name':'literal parameter override, stable part ID, out-of-range rejection', 'passed':True})
(directory/'controlled.json').write_text(json.dumps({'passed':True,'checks':checks},indent=2))
print('PHOTO_FIT_CONTROLLED_OK')
