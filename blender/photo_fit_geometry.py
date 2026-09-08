"""Trusted, bounded modeling primitives. No file, network, or process operations.

Every generated part has a stable forma_id. Local corrections preserve topology,
UVs, object transforms and all vertices outside the declared support region.
"""
import math
import uuid

import bpy
import numpy as np
from mathutils import Vector


def identify(obj, part):
    if not obj.get('forma_id'):
        obj['forma_id'] = str(uuid.uuid4())
    obj['forma_part'] = str(part)[:120]
    return obj


def mesh_part(name, vertices, faces):
    if len(vertices) > 100_000 or not np.isfinite(vertices).all():
        raise ValueError('参数化部件超限或含非有限坐标')
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return identify(obj, name)


def loft(name, sections):
    """Connect ordered, equal-sized 3D rings; preserve an explicitly open end."""
    if not 2 <= len(sections) <= 128:
        raise ValueError('放样截面数量必须为 2..128')
    size = len(sections[0])
    if not 3 <= size <= 256 or any(len(s) != size for s in sections):
        raise ValueError('放样截面须有相同数量的 3..256 个点')
    faces = [(r*size+i, r*size+(i+1)%size, (r+1)*size+(i+1)%size, (r+1)*size+i)
             for r in range(len(sections)-1) for i in range(size)]
    return mesh_part(name, [tuple(p) for s in sections for p in s], faces)


def sweep(name, points, radius=.01, resolution=8):
    if not 2 <= len(points) <= 2048 or not .00001 <= radius <= 1 or not 1 <= resolution <= 16:
        raise ValueError('曲线参数超限')
    if not np.isfinite(points).all():
        raise ValueError('曲线坐标必须有限')
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = resolution
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    spline = curve.splines.new('POLY')
    spline.points.add(len(points)-1)
    for p, value in zip(spline.points, points):
        p.co = (*value, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    return identify(obj, name)


def repeat(obj, count, offset):
    if not 1 <= count <= 100 or not np.isfinite(offset).all():
        raise ValueError('重复参数超限')
    result = [obj]
    for i in range(1, count):
        child = obj.copy()
        child.data = obj.data.copy()
        child['forma_id'] = str(uuid.uuid4())
        child.location = obj.location + Vector(offset)*i
        bpy.context.scene.collection.objects.link(child)
        result.append(child)
    return result


def boolean(obj, cutter, operation='DIFFERENCE'):
    if obj.type != 'MESH' or cutter.type != 'MESH' or obj == cutter:
        raise ValueError('布尔操作需要两个不同的网格')
    if operation not in ('DIFFERENCE', 'UNION', 'INTERSECT'):
        raise ValueError('未知布尔操作')
    if len(obj.data.vertices)+len(cutter.data.vertices) > 100_000:
        raise ValueError('布尔输入超限')
    modifier = obj.modifiers.new('PhotoFit controlled boolean', 'BOOLEAN')
    modifier.operation, modifier.solver, modifier.object = operation, 'EXACT', cutter
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    # Caller owns cutter lifetime and explicitly removes it when appropriate.
    return obj


def leaf(name, length=.12, width=.05, bend=.02):
    if not 0 < width <= length <= 2 or abs(bend) > length:
        raise ValueError('叶片比例超限')
    vertices, faces = [], []
    for i in range(17):
        t = i/16
        w = width*math.sin(math.pi*t)/2
        vertices.extend([(-w, t*length, bend*t*t), (0, t*length, bend*t*t+.04*width*math.sin(math.pi*t)),
                         (w, t*length, bend*t*t)])
    for i in range(16):
        for j in range(2):
            a = i*3+j
            faces.append((a, a+1, a+4, a+3))
    return mesh_part(name, vertices, faces)


def coordinates(obj):
    points = np.empty(len(obj.data.vertices)*3, dtype=np.float64)
    obj.data.vertices.foreach_get('co', points)
    return points.reshape(-1, 3)


def apply_local_operations(objects, operations, bounds, strength=1):
    if len(operations) > 3 or not .0 < strength <= 1:
        raise ValueError('局部修正操作数量或力度超限')
    low, high = np.array(bounds, dtype=float)
    span = np.maximum(high-low, 1e-8)
    if not np.isfinite([low, high]).all() or np.any(high < low):
        raise ValueError('冻结包围盒无效')
    by_id = {o.get('forma_id'): o for o in objects}
    audit = []
    for oid in dict.fromkeys(op['objectId'] for op in operations):
        obj = by_id.get(oid)
        if obj is None or obj.type != 'MESH':
            raise ValueError('目标 ID 不存在或不是网格')
        # Never mutate another object through shared mesh data.
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        original = coordinates(obj)
        matrix = np.array(obj.matrix_world)
        world = original @ matrix[:3, :3].T + matrix[:3, 3]
        normalized = (world-low)/span
        delta = np.zeros_like(normalized)
        support = np.zeros(len(original), dtype=bool)
        edges=None
        for op in [o for o in operations if o['objectId'] == oid]:
            center, radius, translation, scale = (np.array(op[k], dtype=float) for k in ('center', 'radius', 'translation', 'scale'))
            if any(v.shape != (3,) for v in (center, radius, translation, scale)) or not np.isfinite([center, radius, translation, scale]).all():
                raise ValueError('形变参数无效')
            if np.any((center < 0)|(center > 1)) or np.any((radius < .02)|(radius > .65)) or np.any(abs(translation) > .12) or np.any((scale < .65)|(scale > 1.35)):
                raise ValueError('形变参数超出允许范围')
            distance = np.linalg.norm((normalized-center)/radius, axis=1)
            weight = np.clip(1-distance*distance, 0, 1)**2
            support |= distance < 1
            if op.get('operationType','deform')=='smooth':
                iterations=op.get('smoothIterations',3);factor=op.get('smoothFactor',.2)
                if not isinstance(iterations,int) or not 1<=iterations<=5 or not math.isfinite(factor) or not .01<=factor<=.5:
                    raise ValueError('平滑次数或力度超限')
                if edges is None:
                    edges=np.array([e.vertices[:] for e in obj.data.edges],dtype=int)
                if not len(edges): raise ValueError('平滑目标没有边')
                degree=np.bincount(edges.ravel(),minlength=len(original))
                working=normalized.copy()
                for _ in range(iterations):
                    total=np.zeros_like(working)
                    np.add.at(total,edges[:,0],working[edges[:,1]])
                    np.add.at(total,edges[:,1],working[edges[:,0]])
                    average=total/np.maximum(degree[:,None],1)
                    step=(average-working)*(weight*factor*strength)[:,None]
                    step[degree==0]=0
                    working+=step
                delta+=working-normalized
            elif op.get('operationType','deform')=='deform':
                delta += weight[:, None]*(translation+(normalized-center)*(scale-1))*strength
            else: raise ValueError('未知局部操作')
        if np.max(np.linalg.norm(delta, axis=1), initial=0) > .18:
            raise ValueError('累积位移超出主体尺度的 18%')
        inverse = np.linalg.inv(matrix)
        moved = (normalized+delta)*span+low
        local = moved @ inverse[:3, :3].T + inverse[:3, 3]
        # Avoid floating-point roundtrip changes to untouched vertices.
        local[~support] = original[~support]
        obj.data.vertices.foreach_set('co', local.ravel())
        obj.data.update()
        after = coordinates(obj)
        if not np.array_equal(after[~support], original[~support]):
            raise ValueError('选区外坐标发生变化')
        obj.data.calc_loop_triangles()
        faces = np.array([t.vertices[:] for t in obj.data.loop_triangles], dtype=int)
        if not len(faces): raise ValueError('修正目标没有三角面')
        a,b=original[faces],after[faces]
        n0=np.cross(a[:,1]-a[:,0],a[:,2]-a[:,0])
        n1=np.cross(b[:,1]-b[:,0],b[:,2]-b[:,0])
        valid=np.linalg.norm(n0,axis=1)>1e-12
        if np.any(np.einsum('ij,ij->i',n0[valid],n1[valid])<=0):
            raise ValueError('修正导致三角面翻转或塌缩')
        audit.append({'objectId': oid, 'supportVertices': int(support.sum()),
                      'changedVertices': int(np.any(after != original, axis=1).sum()),
                      'outsideUnchanged': True, 'maxNormalizedDisplacement': float(np.linalg.norm(delta, axis=1).max(initial=0))})
    return audit
