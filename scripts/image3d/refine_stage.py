"""Trusted local surface edit: visibility-tested projection into existing UV pixels.

No remeshing or UV unwrap. Unselected pixels are copied byte-for-byte from the
original PNG; an overlapping UV layout is rejected rather than painting twice.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def target(job):
    request=json.loads((job/'request.json').read_text())
    obj=next((o for o in bpy.context.scene.objects if o.get('forma_id')==request['objectId']),None)
    if obj is None or obj.type!='MESH':raise ValueError('请选择需要精修的网格对象')
    if any(m.show_render for m in obj.modifiers):raise ValueError('局部表面精修需要已应用修改器的网格')
    if len(obj.data.materials)!=1:raise ValueError('首版局部精修需要单一图片材质')
    mat=obj.active_material
    bsdf=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None) if mat and mat.use_nodes else None
    if not bsdf:raise ValueError('选中对象没有可精修的图片材质')
    visited=set();images=set()
    def walk(socket):
        for link in socket.links:
            node=link.from_node
            if node in visited:continue
            visited.add(node)
            if node.type=='TEX_IMAGE' and node.image:images.add(node.image)
            else:
                for value in node.inputs:walk(value)
    walk(bsdf.inputs['Base Color'])
    if len(images)!=1:raise ValueError('局部精修需要一张明确的基础颜色贴图')
    image=next(iter(images))
    if max(image.size)>2048:raise ValueError('局部精修贴图上限为 2048')
    uv=next((u for u in obj.data.uv_layers if 'ProjectionUV' not in u.name and u.name!='_SG_ProjectionBuffer'),None)
    if not uv:raise ValueError('选中对象没有可编辑的纹理 UV')
    return request,obj,mat,image,uv


def camera(job,request):
    scene=bpy.context.scene;c=request['camera']
    cv=lambda v:Vector((v[0],-v[2],v[1]))
    pos=cv(c['position']);back=(pos-cv(c['target'])).normalized()
    right=cv(c['up']).cross(back).normalized();up=back.cross(right).normalized()
    if right.length<.5:raise ValueError('相机向上方向不能为零或与观察方向平行')
    data=bpy.data.cameras.new('Forma refine camera');cam=bpy.data.objects.new('Forma refine camera',data)
    scene.collection.objects.link(cam)
    cam.matrix_world=Matrix(((right.x,up.x,back.x,pos.x),(right.y,up.y,back.y,pos.y),(right.z,up.z,back.z,pos.z),(0,0,0,1)))
    data.type='PERSP';data.sensor_fit='VERTICAL';data.sensor_height=24
    data.lens=12/(math.tan(math.radians(c['fov'])/2)*max(1,c['aspect']))
    scene.camera=cam;bpy.context.view_layer.update()
    return cam


def prepare(job):
    from PIL import Image
    import numpy as np
    bpy.ops.wm.open_mainfile(filepath=str(job/'base.blend'),load_ui=False,use_scripts=False)
    request,obj,mat,image,uv=target(job)
    # Keep the exact source encoding for the post-projection pixel invariant.
    if image.packed_file:data=bytes(image.packed_file.data)
    else:data=Path(bpy.path.abspath(image.filepath)).read_bytes()
    (job/'original-atlas.png').write_bytes(data)
    atlas=Image.open(job/'original-atlas.png')
    if atlas.format!='PNG':raise ValueError('局部精修仅支持无损 PNG 基础贴图')
    cam=camera(job,request);scene=bpy.context.scene
    selection=Image.open(job/'selection.png').convert('L')
    aspect=request['camera']['aspect']
    dimensions=(512,round(512/aspect)) if aspect>=1 else (round(512*aspect),512)
    square=Image.new('L',(512,512));square.paste(selection.resize(dimensions,Image.Resampling.NEAREST),((512-dimensions[0])//2,(512-dimensions[1])//2))
    if not square.getbbox():raise ValueError('请先涂选需要修改的区域')
    square.save(job/'view-mask.png')
    scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=8
    scene.render.resolution_x=scene.render.resolution_y=512;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
    scene.render.film_transparent=True;scene.use_nodes=False
    if not scene.world:scene.world=bpy.data.worlds.new('World')
    scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.8,.8,.8,1)
    scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.8
    scene.view_settings.view_transform='Standard'
    scene.render.filepath=str(job/'context.png');bpy.ops.render.render(write_still=True)
    distances=[(obj.matrix_world@Vector(c)-cam.location).length for c in obj.bound_box]
    scene.view_layers[0].use_pass_z=True;scene.use_nodes=True
    nodes=scene.node_tree.nodes;nodes.clear();layer=nodes.new('CompositorNodeRLayers');remap=nodes.new('CompositorNodeMapRange')
    remap.inputs['From Min'].default_value=max(.001,min(distances)*.9);remap.inputs['From Max'].default_value=max(distances)*1.1
    remap.inputs['To Min'].default_value=1;remap.inputs['To Max'].default_value=0;remap.use_clamp=True
    out=nodes.new('CompositorNodeComposite');scene.node_tree.links.new(layer.outputs['Depth'],remap.inputs['Value']);scene.node_tree.links.new(remap.outputs['Value'],out.inputs['Image'])
    scene.render.filepath=str(job/'depth.png');bpy.ops.render.render(write_still=True)
    (job/'prepare-report.json').write_text(json.dumps({'objectId':obj['forma_id'],'atlas':list(image.size),'maskPixels':int((np.array(square)>0).sum())}))


def apply(job):
    import numpy as np
    from PIL import Image
    bpy.ops.wm.open_mainfile(filepath=str(job/'base.blend'),load_ui=False,use_scripts=False)
    request,obj,material,image,uv=target(job)
    cam=camera(job,request);scene=bpy.context.scene
    scene.render.resolution_x=scene.render.resolution_y=512;scene.render.resolution_percentage=100
    mesh=obj.data;mesh.calc_loop_triangles()
    positions=np.array([obj.matrix_world@v.co for v in mesh.vertices],dtype=np.float64)
    loops=np.array([v.uv[:] for v in uv.data],dtype=np.float64)
    if not np.isfinite(loops).all() or (loops < -1e-5).any() or (loops > 1+1e-5).any():
        raise ValueError(f'纹理 UV 超出标准单张贴图范围：{loops.min()} 至 {loops.max()}')
    loops=np.clip(loops,0,1)  # Smart UV packing can round an edge by a few ULPs.
    # Occluders include all visible scene meshes, not just the chosen object.
    vertices=[];faces=[];deps=bpy.context.evaluated_depsgraph_get()
    for other in scene.objects:
        if other.type!='MESH' or other.hide_render:continue
        evaluated=other.evaluated_get(deps);evaluated_mesh=evaluated.to_mesh()
        try:
            evaluated_mesh.calc_loop_triangles();offset=len(vertices)
            vertices.extend(evaluated.matrix_world@v.co for v in evaluated_mesh.vertices)
            faces.extend(tuple(offset+i for i in t.vertices) for t in evaluated_mesh.loop_triangles)
        finally:evaluated.to_mesh_clear()
    tree=BVHTree.FromPolygons(vertices,faces,all_triangles=True)
    origin=cam.matrix_world.translation;camera_position=np.array(origin)
    projection=np.array(cam.calc_matrix_camera(deps,x=512,y=512)@cam.matrix_world.inverted())
    original=np.array(Image.open(job/'original-atlas.png').convert('RGBA'))[::-1].copy()
    result=original.copy();height,width=original.shape[:2]
    generated=np.array(Image.open(job/'generated-texture.png').convert('RGBA'))[::-1]
    mask=np.array(Image.open(job/'view-mask.png').convert('L'))[::-1]
    occupied=np.zeros((height,width),dtype=np.uint8);changed_mask=np.zeros((height,width),dtype=bool)
    tolerance=max(1e-5,max(obj.dimensions)*1e-5)
    for triangle in mesh.loop_triangles:
        coords=loops[list(triangle.loops)]*np.array([width,height])
        lo=np.maximum(0,np.floor(coords.min(axis=0)-.5).astype(int));hi=np.minimum([width-1,height-1],np.ceil(coords.max(axis=0)-.5).astype(int))
        if (hi<lo).any():continue
        xx,yy=np.meshgrid(np.arange(lo[0],hi[0]+1),np.arange(lo[1],hi[1]+1))
        points=np.stack((xx.ravel()+.5,yy.ravel()+.5),axis=1)
        a,b,c=coords;v0=b-a;v1=c-a;det=v0[0]*v1[1]-v1[0]*v0[1]
        if abs(det)<1e-9:continue
        delta=points-a;u=(delta[:,0]*v1[1]-delta[:,1]*v1[0])/det;v=(v0[0]*delta[:,1]-v0[1]*delta[:,0])/det
        inside=(u>1e-7)&(v>1e-7)&(u+v<1-1e-7)
        if not inside.any():continue
        x=xx.ravel()[inside];y=yy.ravel()[inside];u=u[inside];v=v[inside]
        if occupied[y,x].any():raise ValueError('检测到重叠 UV，局部修改可能影响未选表面，已保留原版本')
        occupied[y,x]=1
        xyz=positions[list(triangle.vertices)];world=xyz[0]+u[:,None]*(xyz[1]-xyz[0])+v[:,None]*(xyz[2]-xyz[0])
        projected=np.c_[world,np.ones(len(world))]@projection.T
        screen=projected[:,:2]/np.maximum(projected[:,3:],1e-12);pixels=np.floor((screen+1)*256).astype(int)
        good=(projected[:,3]>0)&(pixels[:,0]>=0)&(pixels[:,0]<512)&(pixels[:,1]>=0)&(pixels[:,1]<512)
        indices=np.flatnonzero(good)
        indices=indices[mask[pixels[indices,1],pixels[indices,0]]>0]
        for i in indices:
            direction=world[i]-camera_position;distance=float(np.linalg.norm(direction))
            hit,normal,face,depth=tree.ray_cast(origin,Vector(direction/distance),distance+tolerance)
            if hit is None or abs(depth-distance)>tolerance:continue
            px,py=pixels[i];alpha=float(mask[py,px])/255
            result[y[i],x[i],:3]=np.rint(original[y[i],x[i],:3]*(1-alpha)+generated[py,px,:3]*alpha).astype(np.uint8)
            changed_mask[y[i],x[i]]=True
    if not changed_mask.any():raise ValueError('选区没有命中可见的主体表面，请调整视角或选区')
    if not np.array_equal(result[~changed_mask],original[~changed_mask]):raise RuntimeError('未选纹理像素发生变化')
    if not np.array_equal(result[:,:,3],original[:,:,3]):raise RuntimeError('纹理透明度发生变化')
    output=job/'refined-atlas.png';Image.fromarray(result[::-1]).save(output)
    Image.fromarray(changed_mask[::-1].astype(np.uint8)*255).save(job/'atlas-mask.png')
    # Restore the original scene's camera, render settings and all other state;
    # only the chosen object's private image/material may differ in the output.
    bpy.ops.wm.open_mainfile(filepath=str(job/'base.blend'),load_ui=False,use_scripts=False)
    request,obj,material,image,uv=target(job)
    replacement=bpy.data.images.load(str(output),check_existing=False);replacement.colorspace_settings.name=image.colorspace_settings.name;replacement.pack()
    private=material.copy()
    for node in private.node_tree.nodes:
        if node.type=='TEX_IMAGE' and node.image==image:node.image=replacement
    # A shared mesh/material must not repaint a duplicate elsewhere in the scene.
    if obj.data.users>1:obj.data=obj.data.copy()
    obj.data.materials[0]=private
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(job/'refined.blend'),check_existing=False)
    report={'objectId':obj['forma_id'],'selectedAtlasPixels':int(changed_mask.sum()),'changedPixels':int(np.any(result!=original,axis=2).sum()),
        'unselectedPixelsUnchanged':True,'alphaUnchanged':True,'geometryOperation':'none','originalAtlasSha256':hashlib.sha256((job/'original-atlas.png').read_bytes()).hexdigest()}
    (job/'refine-report.json').write_text(json.dumps(report,indent=2))
    print('FORMA_REFINE_OK',json.dumps(report))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--runtime',type=Path,required=True);parser.add_argument('--job',type=Path,required=True);parser.add_argument('--mode',choices=['prepare','apply'],required=True)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]);sys.path.append(str(args.runtime/'blender-python'))
    (prepare if args.mode=='prepare' else apply)(args.job)


if __name__=='__main__':main()
