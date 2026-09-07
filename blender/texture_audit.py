"""Check geometric UV distortion after a shape edit, in a trusted fresh process.

This is a numeric stretch check, not a visual judgement of the photograph.
Uniform scale does not change the anisotropy of the UV-to-surface map.
"""
import json
from pathlib import Path
import sys
import bpy
import numpy as np


def snapshot(file, target_id):
    bpy.ops.wm.open_mainfile(filepath=str(file), load_ui=False, use_scripts=False)
    target = next((o for o in bpy.context.scene.objects if o.get('forma_id') == target_id), None)
    if target is None: raise ValueError('形体修改丢失目标对象 ID')
    objects = [target, *target.children_recursive]
    result = {}
    deps = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.type != 'MESH': continue
        images = [n.image for m in obj.data.materials if m and m.use_nodes
                  for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
        if not images: continue
        evaluated = obj.evaluated_get(deps); mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            uv = next((u for u in mesh.uv_layers if 'ProjectionUV' not in u.name and u.name != '_SG_ProjectionBuffer'), None)
            if uv is None: raise ValueError('带纹理对象丢失 UV')
            points = np.array([evaluated.matrix_world @ v.co for v in mesh.vertices])
            faces = np.array([t.vertices[:] for t in mesh.loop_triangles], dtype=int)
            loops = np.array([t.loops[:] for t in mesh.loop_triangles], dtype=int)
            coords = np.array([v.uv[:] for v in uv.data])[loops]
            if not len(faces): raise ValueError('带纹理对象没有三角面')
            p = points[faces]; edges = np.stack((p[:,1]-p[:,0],p[:,2]-p[:,0]), axis=2)
            basis = np.stack((coords[:,1]-coords[:,0],coords[:,2]-coords[:,0]), axis=2)
            area = np.linalg.norm(np.cross(edges[:,:,0], edges[:,:,1]), axis=1)*.5
            valid = (np.abs(np.linalg.det(basis)) > 1e-12) & (area > 1e-12)
            jacobian = edges[valid] @ np.linalg.inv(basis[valid])
            singular = np.linalg.svd(jacobian, compute_uv=False)
            ratio = singular[:,0] / np.maximum(singular[:,1],1e-12)
            if not np.isfinite(ratio).all() or not len(ratio): raise ValueError('纹理映射无法计算')
            result[obj.get('forma_id')] = {
                'triangles': len(faces), 'anisotropyP95': float(np.percentile(ratio,95)),
                'areaWeightedAnisotropy': float(np.exp(np.average(np.log(np.maximum(ratio,1)),weights=area[valid]))),
                'degenerateUVFraction': float(area[~valid].sum()/max(area.sum(),1e-12)),
            }
        finally: evaluated.to_mesh_clear()
    return result


def audit(directory, target_id):
    before = snapshot(directory/'base.blend', target_id)
    after = snapshot(directory/'scene.blend', target_id)
    issues = []
    for key, old in before.items():
        current = after.get(key)
        if current is None:
            issues.append('带纹理网格的对象 ID 或图片材质丢失：'+str(key)); continue
        if current['degenerateUVFraction'] > max(.01,old['degenerateUVFraction']+.005):
            issues.append('纹理 UV 出现明显塌缩：'+str(key))
        if (current['areaWeightedAnisotropy'] > max(2,old['areaWeightedAnisotropy']*1.5)
                or current['anisotropyP95'] > max(4,old['anisotropyP95']*2)):
            issues.append('形体修改使纹理显著拉伸，需要重新校准 UV：'+str(key))
    report = {'kind':'geometric-uv-distortion','passed':not issues,'before':before,'after':after,'issues':issues,
              'visualAcceptance':'not-measured','texturedMeshesChecked':len(before)}
    (directory/'texture-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False))
    if issues: raise ValueError('；'.join(issues))
    print('FORMA_TEXTURE_AUDIT_OK')


if __name__ == '__main__':
    args=sys.argv[sys.argv.index('--')+1:]
    audit(Path(args[0]),args[1])
