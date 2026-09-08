"""Original Blender primitives for softly simplified subjects; no external runtime."""
import math
import json
import bpy
import numpy as np
from mathutils import Vector
from photo_fit_geometry import identify


def ellipsoid(name, center, radii):
    if not np.isfinite([center, radii]).all() or min(radii) <= 0 or max(radii) > 2:
        raise ValueError('椭球参数无效')
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, location=center)
    obj=bpy.context.object; obj.name=name; obj.scale=radii
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for p in obj.data.polygons: p.use_smooth=True
    return identify(obj,name)


def rounded_box(name, center, size, radius=.02):
    if not np.isfinite([center,size]).all() or min(size)<=0 or not 0<=radius<=min(size)/2:
        raise ValueError('圆角部件参数无效')
    bpy.ops.mesh.primitive_cube_add(size=1,location=center)
    obj=bpy.context.object;obj.name=name;obj.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if radius:
        mod=obj.modifiers.new('Soft edge','BEVEL');mod.width=radius;mod.segments=3
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return identify(obj,name)


def fuse(name, parts, voxel=.005, smooth=.3):
    """Fuse only the explicit body members; eyes, ear cavities and leaves stay separate."""
    parts=list(parts)
    if not 1<=len(parts)<=40 or len(set(parts))!=len(parts) or not .003<=voxel<=.03 or not 0<=smooth<=.5:
        raise ValueError('连续形体参数超限')
    if any(o.type!='MESH' for o in parts): raise ValueError('融合只接受显式网格')
    corners=[o.matrix_world@Vector(c) for o in parts for c in o.bound_box]
    cells=np.prod([(max(v[i] for v in corners)-min(v[i] for v in corners))/voxel+1 for i in range(3)])
    if cells>30_000_000: raise ValueError('融合体素预算超限')
    members=[o.name for o in parts]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        if obj.data.users>1: obj.data=obj.data.copy()
        obj.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]
    bpy.ops.object.join();obj=bpy.context.object;obj.name=name
    # Material boundaries are added after the geometry has passed review.
    obj.data.materials.clear()
    mod=obj.modifiers.new('Continuous body','REMESH');mod.mode='VOXEL';mod.voxel_size=voxel
    mod.use_smooth_shade=True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    if smooth:
        mod=obj.modifiers.new('Continuous transition','SMOOTH');mod.factor=smooth;mod.iterations=4
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in obj.data.polygons:p.use_smooth=True
    obj['stylized_members']=json.dumps(members)
    return identify(obj,name)


def parameter_contract(params, rules, frozen=None):
    if not params or set(params)!=set(rules): raise ValueError('每项 PARAMS 都需要 PARAM_RULES')
    result={}
    for name,value in params.items():
        rule=rules[name]
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):raise ValueError('参数必须为有限数字')
        if rule.get('kind') not in ('proportion','shape','detail'):raise ValueError('参数类别无效')
        targets=rule.get('targets')
        if not isinstance(targets,list) or not targets or not all(isinstance(t,str) and t for t in targets):raise ValueError('参数必须声明影响部件')
        lo,hi=rule.get('min'),rule.get('max')
        if not isinstance(lo,(int,float)) or not isinstance(hi,(int,float)) or not math.isfinite(lo+hi) or lo>hi:raise ValueError('参数范围无效')
        if rule['kind']=='proportion':
            base=rule.get('baseline')
            if not isinstance(base,(int,float)) or not math.isfinite(base) or base<=0:raise ValueError('比例基准必须为正数')
            lo=max(lo,base*.85);hi=min(hi,base*1.15)
        if frozen:
            old=frozen.get(name)
            if not old or old['targets']!=targets or old['kind']!=rule['kind']:raise ValueError('冻结参数声明发生变化')
            lo=max(lo,old['min']);hi=min(hi,old['max'])
        if not lo<=value<=hi:raise ValueError('参数超出风格范围：'+name)
        result[name]={'value':value,'min':lo,'max':hi,'integer':isinstance(value,int),'targets':targets,'kind':rule['kind']}
    return result


def validate_targets(contract):
    names={o.name for o in bpy.context.scene.objects if o.type in ('MESH','CURVE') and not o.hide_render}
    if any(t not in names for r in contract.values() for t in r['targets']):raise ValueError('参数影响范围含不存在的最终部件')


def apply_palette(meshes, plan):
    """Standard material slots + face regions: exportable, exact geometry preservation."""
    if not 1<=len(plan['palette'])<=12:raise ValueError('主色板必须为 1..12 色')
    mats={}
    for item in plan['palette']:
        name=item['id'];rgba=item['color']
        if name in mats or len(rgba)!=3 or not np.isfinite(rgba).all() or min(rgba)<0 or max(rgba)>1:raise ValueError('色板无效')
        mat=bpy.data.materials.new('Stylized_'+name);mat.use_nodes=True
        # Input RGB is sRGB; Blender stores linear base colour.
        rgb=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in rgba]
        node=mat.node_tree.nodes.get('Principled BSDF')
        node.inputs['Base Color'].default_value=(*rgb,1);node.inputs['Roughness'].default_value=item['roughness']
        mat.diffuse_color=(*rgb,1);mats[name]=mat
    by_name={o.name:o for o in meshes}
    if {a['part'] for a in plan['assignments']}!=set(by_name) or len(plan['assignments'])!=len(by_name):raise ValueError('色板必须覆盖且仅覆盖所有部件')
    for a in plan['assignments']:
        obj=by_name[a['part']]
        if obj.data.users>1:obj.data=obj.data.copy()
        obj.data.materials.clear();obj.data.materials.append(mats[a['colorId']])
        for p in obj.data.polygons:p.material_index=0
    for patch in plan['patches']:
        obj=by_name[patch['part']]
        center=np.array(patch['center']);radius=np.array(patch['radius'])
        if not np.isfinite([center,radius]).all() or min(center)<0 or max(center)>1 or min(radius)<.01 or max(radius)>2:raise ValueError('色块选区无效')
        pts=np.array([obj.matrix_world@v.co for v in obj.data.vertices]);lo=pts.min(axis=0);span=np.maximum(pts.max(axis=0)-lo,1e-8)
        slot=len(obj.data.materials);obj.data.materials.append(mats[patch['colorId']])
        for p in obj.data.polygons:
            pos=(np.mean(pts[list(p.vertices)],axis=0)-lo)/span
            if np.linalg.norm((pos-center)/radius)<=1:p.material_index=slot
