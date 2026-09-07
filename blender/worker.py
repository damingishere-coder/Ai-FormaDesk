"""Trusted Blender entrypoint. Z-up local transforms; glTF is Y-up.
Generated code only runs in 'execute'. A fresh process reopens and validates it.
"""
import bpy, sys, json, os, uuid, math
from mathutils import Vector, Matrix
args=sys.argv[sys.argv.index('--')+1:]
mode, directory=args[0], args[1]
def file(name): return os.path.join(directory,name)
def read(name):
    with open(file(name),encoding='utf8') as f: return json.load(f)
def write(name,value):
    with open(file(name),'w',encoding='utf8') as f: json.dump(value,f,ensure_ascii=False,allow_nan=False)
def open_scene(name):
    bpy.ops.wm.open_mainfile(filepath=file(name),load_ui=False,use_scripts=False)
def identity(obj):
    val=obj.get('forma_id')
    try: uuid.UUID(str(val))
    except (ValueError,TypeError,AttributeError): val=str(uuid.uuid4());obj['forma_id']=val
    return val
def srgb(v): return 12.92*v if v<=.0031308 else 1.055*v**(1/2.4)-.055
def linear(v): return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def color_hex(c): return '#'+''.join(f'{round(max(0,min(1,srgb(v)))*255):02x}' for v in c[:3])
def color_rgb(c): return tuple(linear(int(c[i:i+2],16)/255) for i in (1,3,5))
def mat_node(mat):
    if not mat:return None
    mat.use_nodes=True
    return next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
def material_factor(socket):
    if not socket.is_linked:return socket.default_value
    node=socket.links[0].from_node
    if node.get('forma_factor')==socket.name:
        return node.inputs[7 if socket.type=='RGBA' else 1].default_value
    return (1,1,1,1) if socket.type=='RGBA' else 1.0
def set_material_factor(mat,socket,value,replace=False):
    if replace:
        for link in list(socket.links):mat.node_tree.links.remove(link)
    if not socket.is_linked:
        socket.default_value=value;return
    source=socket.links[0].from_socket
    factor=source.node
    if factor.get('forma_factor')!=socket.name:
        if socket.type=='RGBA':
            factor=mat.node_tree.nodes.new('ShaderNodeMix')
            factor.data_type='RGBA';factor.blend_type='MULTIPLY';factor.inputs[0].default_value=1
            mat.node_tree.links.new(source,factor.inputs[6])
            output=factor.outputs[2]
        else:
            factor=mat.node_tree.nodes.new('ShaderNodeMath');factor.operation='MULTIPLY'
            mat.node_tree.links.new(source,factor.inputs[0]);output=factor.outputs[0]
        factor['forma_factor']=socket.name
        factor.label='网页材质系数 / '+socket.name
        mat.node_tree.links.new(output,socket)
    factor.inputs[7 if socket.type=='RGBA' else 1].default_value=value
def material(obj):
    n=mat_node(obj.active_material) if hasattr(obj,'active_material') else None
    return None if not n else {'color':color_hex(material_factor(n.inputs['Base Color'])),'roughness':material_factor(n.inputs['Roughness']),'metalness':material_factor(n.inputs['Metallic'])}
def find(oid):
    obj=next((o for o in bpy.context.scene.objects if o.get('forma_id')==oid),None)
    if obj is None:raise ValueError('对象 ID 不存在: '+oid)
    return obj
def descendants(obj):
    return [obj]+[n for c in obj.children for n in descendants(c)]
def normalize():
    scene=bpy.context.scene
    if len(scene.objects)>1500:raise ValueError('V1 场景最多允许 1500 个对象')
    seen=set()
    for obj in scene.objects:
        oid=identity(obj)
        if oid in seen:obj['forma_id']=str(uuid.uuid4())
        seen.add(obj['forma_id'])
        if obj.type=='LIGHT' and obj.data.type not in ('POINT','SUN'):obj.data.type='POINT'
        if obj.constraints:raise ValueError('V1 不支持对象约束，请将最终变换应用到对象')
        # Canonicalize parent inverse so browser-local and Blender-local TRS agree.
        local=obj.matrix_local.copy();obj.matrix_parent_inverse=Matrix.Identity(4);obj.matrix_basis=local
        obj.rotation_mode='XYZ'
        if obj.type not in ('MESH','EMPTY','LIGHT','CAMERA','CURVE','FONT','SURFACE','META'):raise ValueError('不支持的对象类型 '+obj.type)
    for img in bpy.data.images:
        w,h=img.size
        if max(w,h)>2048:img.scale(max(1,round(w*2048/max(w,h))),max(1,round(h*2048/max(w,h))))
    scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=1
    bpy.context.view_layer.update()
def manifest():
    objects=[];verts=0;tris=0
    depsgraph=bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type in ('MESH','CURVE','FONT','SURFACE','META'):
            evaluated=obj.evaluated_get(depsgraph);mesh=evaluated.to_mesh()
            try:
                if mesh:
                    verts+=len(mesh.vertices);mesh.calc_loop_triangles();tris+=len(mesh.loop_triangles)
            finally:evaluated.to_mesh_clear()
            if verts>2000000:raise ValueError('V1 场景应用修改器后超过 200 万顶点上限')
        objects.append({'id':identity(obj),'name':obj.name,'type':obj.type,'parentId':identity(obj.parent) if obj.parent else None,**({'subjectId':obj['forma_subject_id']} if obj.get('forma_subject_id') else {}),'transform':{'position':list(obj.location),'rotation':list(obj.rotation_euler),'scale':list(obj.scale)},'matrix':[obj.matrix_local[r][c] for c in range(4) for r in range(4)],'visible':not obj.hide_render,'material':material(obj),'light':{'type':obj.data.type,'color':color_hex(obj.data.color),'energy':obj.data.energy} if obj.type=='LIGHT' else None})
    if verts>2000000:raise ValueError('V1 场景超过 200 万顶点上限')
    return {'objects':objects,'stats':{'objects':len(objects),'vertices':verts,'triangles':tris},'units':'meters','coordinates':'blender-z-up'}
if mode=='execute':
    if os.path.exists(file('base.blend')):open_scene('base.blend')
    else:
        bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    with open(file('generated.py'),encoding='utf8') as f:code=compile(f.read(),'generated.py','exec')
    exec(code,{'bpy':bpy,'__name__':'__main__'})
    bpy.ops.wm.save_as_mainfile(filepath=file('raw.blend'),check_existing=False)
elif mode=='surface-refine':
    open_scene('subject.blend')
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=file('raw.blend'),check_existing=False)
elif mode=='image3d':
    if os.path.exists(file('base.blend')):open_scene('base.blend')
    else:
        bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    request=read('command.json')
    root_id=str(uuid.uuid4());root_matrix=Matrix.Identity(4);root_parent=None
    if request.get('objectId'):
        selected=find(request['objectId']);root_id=selected.get('forma_subject_id') or identity(selected)
        old=find(root_id);root_matrix=old.matrix_world.copy();root_parent=old.parent
        for obj in reversed(descendants(old)):bpy.data.objects.remove(obj,do_unlink=True)
    root=bpy.data.objects.new(request.get('name','照片主体')[:120],None)
    root['forma_id']=root_id;root['forma_subject_id']=root_id;root['forma_scale_estimated']=True
    bpy.context.scene.collection.objects.link(root);root.parent=root_parent;root.matrix_world=root_matrix
    with bpy.data.libraries.load(file('subject.blend'),link=False) as (source,target):
        target.objects=source.objects
    count=0
    for obj in target.objects:
        if obj and obj.type=='MESH':
            local=obj.matrix_basis.copy();obj.parent=None
            bpy.context.scene.collection.objects.link(obj);obj.parent=root;obj.matrix_basis=local
            obj['forma_id']=str(uuid.uuid4());obj['forma_subject_id']=root_id;count+=1
    if not count:raise ValueError('候选文件没有主体网格')
    bpy.ops.wm.save_as_mainfile(filepath=file('raw.blend'),check_existing=False)
elif mode=='command':
    open_scene('base.blend');c=read('command.json');obj=find(c['objectId']);op=c['operation']
    if op=='transform':
        t=c['transform'];obj.location=t['position'];obj.rotation_mode='XYZ';obj.rotation_euler=t['rotation'];obj.scale=t['scale']
    elif op=='material':
        if obj.type not in ('MESH','CURVE','FONT','SURFACE','META'):raise ValueError('此对象没有可编辑材质')
        if obj.data.users>1:obj.data=obj.data.copy()
        mat=obj.active_material.copy() if obj.active_material else bpy.data.materials.new('网页材质')
        mat.use_nodes=True
        if len(obj.data.materials):obj.data.materials[obj.active_material_index]=mat
        else:obj.data.materials.append(mat)
        n=mat_node(mat);v=c['material']
        if not n:raise ValueError('此材质没有可编辑的 Principled BSDF')
        alpha=n.inputs['Base Color'].default_value[3]
        set_material_factor(mat,n.inputs['Base Color'],(*color_rgb(v['color']),alpha),c.get('replaceTexture',False))
        set_material_factor(mat,n.inputs['Roughness'],v['roughness'])
        set_material_factor(mat,n.inputs['Metallic'],v['metalness'])
    elif op=='light':
        if obj.type!='LIGHT':raise ValueError('此对象不是灯光')
        if obj.data.users>1:obj.data=obj.data.copy()
        obj.data.color=color_rgb(c['light']['color']);obj.data.energy=c['light']['energy']
    elif op=='visibility':
        for o in descendants(obj):o.hide_render=not c['visible'];o.hide_viewport=not c['visible']
    elif op=='rename':obj.name=c['name']
    elif op=='delete':
        for o in reversed(descendants(obj)):bpy.data.objects.remove(o,do_unlink=True)
    elif op=='duplicate':
        pairs={}
        for o in descendants(obj):
            cp=o.copy()
            if o.data:cp.data=o.data.copy()
            cp['forma_id']=str(uuid.uuid4());bpy.context.collection.objects.link(cp);pairs[o]=cp
        for o,cp in pairs.items():
            if o.parent in pairs:cp.parent=pairs[o.parent]
            if o.get('forma_subject_id'):
                source_root=next((n for n in pairs if identity(n)==o['forma_subject_id']),None)
                cp['forma_subject_id']=identity(pairs[source_root]) if source_root else identity(cp)
        pairs[obj].location.x+=.25
    bpy.ops.wm.save_as_mainfile(filepath=file('raw.blend'),check_existing=False)
elif mode=='validate':
    open_scene('raw.blend');normalize();m=manifest()
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=file('scene.blend'),check_existing=False)
    # The editable master keeps original geometry; only photo-subject previews
    # receive decimation. Re-evaluate every subject after applying modifiers.
    groups={}
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH' and obj.get('forma_subject_id'):
            groups.setdefault(obj['forma_subject_id'],[]).append(obj)
    deps=bpy.context.evaluated_depsgraph_get()
    for objects in groups.values():
        total=0
        for obj in objects:
            evaluated=obj.evaluated_get(deps);mesh=evaluated.to_mesh()
            try:mesh.calc_loop_triangles();total+=len(mesh.loop_triangles)
            finally:evaluated.to_mesh_clear()
        if total>150000:
            for obj in objects:
                modifier=obj.modifiers.new('网页预览简化','DECIMATE');modifier.ratio=145000/total
        bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get();preview_total=0
        for obj in objects:
            evaluated=obj.evaluated_get(deps);mesh=evaluated.to_mesh()
            try:mesh.calc_loop_triangles();preview_total+=len(mesh.loop_triangles)
            finally:evaluated.to_mesh_clear()
        if preview_total>150000:raise ValueError('图生主体简化后仍超过 15 万三角面，拒绝更新网页版本')
    # Let Blender's glTF exporter traverse supported image, factor and normal
    # chains. Pruning non-image links here also destroys valid texture factors.
    # Export hidden objects too; visibility is carried by the authoritative manifest.
    hidden=[(o,o.hide_viewport,o.hide_render,o.hide_get()) for o in bpy.context.scene.objects]
    for o,_,_,_ in hidden:o.hide_viewport=False;o.hide_render=False;o.hide_set(False)
    bpy.ops.export_scene.gltf(filepath=file('scene.glb'),export_format='GLB',export_extras=True,export_yup=True,export_lights=True,export_cameras=True,export_apply=True,export_animations=False,use_visible=False,use_renderable=False)
    write('scene.json',m)
elif mode=='inspect':
    open_scene('scene.blend');write('inspection.json',manifest())
elif mode=='render':
    open_scene('base.blend');c=read('camera.json');scene=bpy.context.scene
    # Three.js Y-up -> Blender Z-up, preserving the submitted vertical framing.
    def cv(v):return Vector((v[0],-v[2],v[1]))
    pos=cv(c['position']);target=cv(c['target']);up=cv(c['up']).normalized();back=(pos-target).normalized();right=up.cross(back).normalized();up=back.cross(right).normalized()
    camdata=bpy.data.cameras.new('Forma_RenderCamera');cam=bpy.data.objects.new('Forma_RenderCamera',camdata);scene.collection.objects.link(cam);cam.matrix_world=Matrix(((right.x,up.x,back.x,pos.x),(right.y,up.y,back.y,pos.y),(right.z,up.z,back.z,pos.z),(0,0,0,1)));scene.camera=cam
    camdata.type='PERSP';camdata.sensor_fit='VERTICAL';camdata.sensor_height=24;camdata.lens=12/math.tan(math.radians(c['fov'])/2)
    scene.render.engine='BLENDER_EEVEE_NEXT'
    settings=c.get('settings',{});scene.render.resolution_x=settings.get('width',1280);scene.render.resolution_y=settings.get('height',720);scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.filepath=file('render.png')
    scene.render.film_transparent=bool(settings.get('transparent',False));scene.render.image_settings.color_mode='RGBA' if scene.render.film_transparent else 'RGB'
    if not scene.world:scene.world=bpy.data.worlds.new('世界')
    scene.world.use_nodes=True;bg=scene.world.node_tree.nodes.get('Background')
    if bg:bg.inputs['Color'].default_value=(.75,.78,.82,1);bg.inputs['Strength'].default_value=.5
    if not any(o.type=='LIGHT' for o in scene.objects):
        d=bpy.data.lights.new('预览补光','SUN');d.energy=2;o=bpy.data.objects.new('预览补光',d);scene.collection.objects.link(o);o.rotation_euler=(.45,-.5,-.5)
    bpy.ops.render.render(write_still=True)
else:raise ValueError('未知执行模式')
print('FORMA_WORKER_OK',mode)
