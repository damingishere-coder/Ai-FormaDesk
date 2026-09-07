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
def material(obj):
    n=mat_node(obj.active_material) if hasattr(obj,'active_material') else None
    return None if not n else {'color':color_hex(n.inputs['Base Color'].default_value),'roughness':n.inputs['Roughness'].default_value,'metalness':n.inputs['Metallic'].default_value}
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
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH':
            verts+=len(obj.data.vertices);obj.data.calc_loop_triangles();tris+=len(obj.data.loop_triangles)
        objects.append({'id':identity(obj),'name':obj.name,'type':obj.type,'parentId':identity(obj.parent) if obj.parent else None,'transform':{'position':list(obj.location),'rotation':list(obj.rotation_euler),'scale':list(obj.scale)},'matrix':[obj.matrix_local[r][c] for c in range(4) for r in range(4)],'visible':not obj.hide_render,'material':material(obj),'light':{'type':obj.data.type,'color':color_hex(obj.data.color),'energy':obj.data.energy} if obj.type=='LIGHT' else None})
    if verts>2000000:raise ValueError('V1 场景超过 200 万顶点上限')
    return {'objects':objects,'stats':{'objects':len(objects),'vertices':verts,'triangles':tris},'units':'meters','coordinates':'blender-z-up'}
if mode=='execute':
    if os.path.exists(file('base.blend')):open_scene('base.blend')
    else:
        bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    with open(file('generated.py'),encoding='utf8') as f:code=compile(f.read(),'generated.py','exec')
    exec(code,{'bpy':bpy,'__name__':'__main__'})
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
        for prop in ['Base Color','Roughness','Metallic']:
            for link in list(n.inputs[prop].links):mat.node_tree.links.remove(link)
        n.inputs['Base Color'].default_value=(*color_rgb(v['color']),1);n.inputs['Roughness'].default_value=v['roughness'];n.inputs['Metallic'].default_value=v['metalness']
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
        pairs[obj].location.x+=.25
    bpy.ops.wm.save_as_mainfile(filepath=file('raw.blend'),check_existing=False)
elif mode=='validate':
    open_scene('raw.blend');normalize();m=manifest()
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=file('scene.blend'),check_existing=False)
    # GLB supports basic PBR; keep procedural nodes in the saved .blend,
    # and use their explicit PBR fallback values in the web derivative.
    for mat in bpy.data.materials:
        n=mat_node(mat)
        if n:
            for prop in ['Base Color','Roughness','Metallic','Normal']:
                for link in list(n.inputs[prop].links):
                    if link.from_node.type not in ('TEX_IMAGE','NORMAL_MAP'):mat.node_tree.links.remove(link)
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
    scene.render.resolution_x=1280;scene.render.resolution_y=720;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.filepath=file('render.png')
    scene.render.film_transparent=False
    if not scene.world:scene.world=bpy.data.worlds.new('世界')
    scene.world.use_nodes=True;bg=scene.world.node_tree.nodes.get('Background')
    if bg:bg.inputs['Color'].default_value=(.75,.78,.82,1);bg.inputs['Strength'].default_value=.5
    if not any(o.type=='LIGHT' for o in scene.objects):
        d=bpy.data.lights.new('预览补光','SUN');d.energy=2;o=bpy.data.objects.new('预览补光',d);scene.collection.objects.link(o);o.rotation_euler=(.45,-.5,-.5)
    bpy.ops.render.render(write_still=True)
else:raise ValueError('未知执行模式')
print('FORMA_WORKER_OK',mode)
