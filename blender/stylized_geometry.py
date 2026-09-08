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
    mod=obj.modifiers.new('Curved source surface','SUBSURF');mod.levels=1;mod.render_levels=1
    bpy.ops.object.modifier_apply(modifier=mod.name)
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


def surface_patch(name, surface, x, z, width, height, offset=.002):
    """A shallow elliptical mesh following the actual visible front surface, not a protruding eyeball."""
    if surface.type!='MESH' or not np.isfinite([x,z,width,height,offset]).all() or not .002<=width<=.5 or not .002<=height<=.5 or not .0005<=offset<=.008:
        raise ValueError('贴合曲面区域参数无效')
    bpy.context.view_layer.update()
    corners=[surface.matrix_world@Vector(c) for c in surface.bound_box]
    front=min(v.y for v in corners)-1
    inverse=surface.matrix_world.inverted();direction=(inverse.to_3x3()@Vector((0,1,0))).normalized()
    def point(px,pz):
        hit,loc,normal,_=surface.ray_cast(inverse@Vector((px,front,pz)),direction)
        if not hit:raise ValueError('贴合曲面区域超出主体表面')
        world=surface.matrix_world@loc;world.y-=offset
        return tuple(world)
    vertices=[point(x,z)];faces=[];segments=32;rings=5
    for ring in range(1,rings+1):
        t=ring/rings
        for i in range(segments):
            angle=2*math.pi*i/segments;vertices.append(point(x+math.cos(angle)*width*.5*t,z+math.sin(angle)*height*.5*t))
    for i in range(segments):faces.append((0,1+i,1+(i+1)%segments))
    for r in range(rings-1):
        for i in range(segments):
            a=1+r*segments+i;b=1+r*segments+(i+1)%segments
            faces.append((a,a+segments,b+segments,b))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.scene.collection.objects.link(obj)
    for p in mesh.polygons:p.use_smooth=True
    return identify(obj,name)


def organic(name, lobes, blend=.035, resolution=80):
    """Smooth-union ellipsoids with an explicit bounded field and marching tetrahedra.

    Each lobe is {center:[x,y,z], radii:[rx,ry,rz]}. This is original code,
    preserving a reproducible volumetric control representation on the object.
    """
    if not 1<=len(lobes)<=48 or not .005<=blend<=.08 or not 32<=resolution<=100:
        raise ValueError('连续场参数超限')
    centers=np.array([l['center'] for l in lobes],dtype=float);radii=np.array([l['radii'] for l in lobes],dtype=float)
    if centers.shape!=(len(lobes),3) or not np.isfinite([centers,radii]).all() or radii.min()<.008 or radii.max()>2:
        raise ValueError('连续场控制点无效')
    low=(centers-radii).min(axis=0)-blend;high=(centers+radii).max(axis=0)+blend
    step=float((high-low).max()/resolution);shape=np.ceil((high-low)/step).astype(int)+1
    if np.prod(shape)>1_100_000:raise ValueError('连续场采样预算超限')
    axes=[low[i]+np.arange(shape[i])*step for i in range(3)]
    points=np.stack(np.meshgrid(*axes,indexing='ij'),axis=-1);field=np.full(tuple(shape),np.inf)
    for c,r in zip(centers,radii):
        distance=(np.linalg.norm((points-c)/r,axis=-1)-1)*float(r.min())
        h=np.maximum(blend-np.abs(field-distance),0)/blend
        field=np.minimum(field,distance)-h*h*blend*.25
    offsets=np.array([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,0,1),(1,0,1),(1,1,1),(0,1,1)])
    signs=[field[o[0]:shape[0]-1+o[0],o[1]:shape[1]-1+o[1],o[2]:shape[2]-1+o[2]]<0 for o in offsets]
    total=np.sum(signs,axis=0);cells=np.argwhere((total>0)&(total<8))
    tetrahedra=[(0,5,1,6),(0,1,2,6),(0,2,3,6),(0,3,7,6),(0,7,4,6),(0,4,5,6)]
    vertices=[];faces=[];edge_vertices={};stride=np.array([shape[1]*shape[2],shape[2],1])
    for cell in cells:
        grid=cell+offsets;values=field[tuple(grid.T)];ids=grid@stride
        def edge(a,b):
            key=tuple(sorted((int(ids[a]),int(ids[b]))))
            if key not in edge_vertices:
                t=float(values[a]/(values[a]-values[b]));pos=low+(grid[a]+t*(grid[b]-grid[a]))*step
                edge_vertices[key]=len(vertices);vertices.append(tuple(pos))
            return edge_vertices[key]
        for tet in tetrahedra:
            inside=[i for i in tet if values[i]<0];outside=[i for i in tet if values[i]>=0]
            if not inside or not outside:continue
            if len(inside)==1:faces.append(tuple(edge(inside[0],j) for j in outside))
            elif len(outside)==1:faces.append(tuple(edge(outside[0],j) for j in inside))
            else:
                a,b=inside;c,d=outside;q=[edge(a,c),edge(a,d),edge(b,d),edge(b,c)]
                faces.extend([(q[0],q[1],q[2]),(q[0],q[2],q[3])])
    if not vertices:raise ValueError('连续场为空')
    vertices=np.array(vertices);faces=np.array(faces,dtype=int)
    # Orient every triangle towards the scalar field's outward gradient.
    gradient=np.stack(np.gradient(field,step),axis=-1)
    midpoint=vertices[faces].mean(axis=1);indices=np.clip(np.rint((midpoint-low)/step).astype(int),0,shape-1)
    normals=np.cross(vertices[faces[:,1]]-vertices[faces[:,0]],vertices[faces[:,2]]-vertices[faces[:,0]])
    flip=np.einsum('ij,ij->i',normals,gradient[tuple(indices.T)])<0
    faces[flip]=faces[flip][:,[0,2,1]]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices.tolist(),[],faces.tolist());mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.scene.collection.objects.link(obj)
    for p in mesh.polygons:p.use_smooth=True
    obj['stylized_field']=json.dumps({'lobes':lobes,'blend':blend,'resolution':resolution})
    return identify(obj,name)
