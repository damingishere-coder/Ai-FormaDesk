"""Trusted visual checkpoints, orthographic renders and texture application."""
import bpy,sys,os,json,uuid
from mathutils import Vector
sys.path.insert(0,os.path.dirname(__file__))
from appearance import bounds,studio,configure_world,scene_snapshot,assert_preserved,geometry_signature,base_material,project_texture
args=sys.argv[sys.argv.index('--')+1:];mode,folder=args[0],args[1]
def p(name):return os.path.join(folder,name)
def read(name):
    with open(p(name)) as f:return json.load(f)
def write(name,data):
    with open(p(name),'w') as f:json.dump(data,f,ensure_ascii=False)
config=read('visual.json')
bpy.ops.wm.open_mainfile(filepath=p(config.get('input','scene.blend')),load_ui=False,use_scripts=False)
scene=bpy.context.scene
if mode=='snapshot':
    write('snapshot.json',scene_snapshot())
elif mode=='preserve':
    assert_preserved(read('snapshot.json'),config.get('allowed',[]));write('preserved.json',{'ok':True})
elif mode=='render':
    if config.get('portable'):
        # Inspect the exported asset, restoring only the authoritative area lights
        # that GLB cannot represent. Geometry and maps come from the real GLB.
        area=[(o.name,o.get('forma_id'),o.matrix_world.copy(),o.data.copy()) for o in scene.objects if o.type=='LIGHT' and o.data.type=='AREA']
        for o in list(scene.objects):bpy.data.objects.remove(o,do_unlink=True)
        bpy.ops.import_scene.gltf(filepath=p('scene.glb'),import_pack_images=True,export_import_convert_lighting_mode='COMPAT')
        for name,identity,matrix,data in area:
            placeholder=next((o for o in scene.objects if o.get('forma_id')==identity),None)
            if placeholder:bpy.data.objects.remove(placeholder,do_unlink=True)
            o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.matrix_world=matrix;o['forma_id']=identity
    targets=[o for o in scene.objects if o.get('forma_id') in config['targets'] and o.type=='MESH']
    center,extent=bounds(targets);span=extent*1.3
    for o in scene.objects:
        if o.type not in ('LIGHT','CAMERA') and o not in targets:o.hide_render=True
    if config.get('shape'):
        gray=bpy.data.materials.new('形状检查');gray.diffuse_color=(.55,.55,.55,1);gray.use_nodes=True
        for o in targets:
            o.data.materials.clear();o.data.materials.append(gray)
            for face in o.data.polygons:face.material_index=0
    studio(targets);configure_world(scene)
    scene.render.engine='BLENDER_EEVEE_NEXT';scene.render.resolution_x=config.get('resolution',512);scene.render.resolution_y=scene.render.resolution_x;scene.render.resolution_percentage=100
    scene.render.film_transparent=False;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGB'
    camera=bpy.data.cameras.new('检查相机');ob=bpy.data.objects.new('检查相机',camera);scene.collection.objects.link(ob);scene.camera=ob;camera.type='ORTHO';camera.ortho_scale=span
    views={}
    for name,back,up in [('front',(0,-1,0),(0,0,1)),('right',(1,0,0),(0,0,1)),('top',(0,0,1),(0,1,0))]:
        direction=Vector(back);ob.location=center+direction*span*3;ob.rotation_euler=(-direction).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=p(('portable-' if config.get('portable') else '')+name+'.png');bpy.ops.render.render(write_still=True)
        right=Vector(up).cross(direction)
        views[name]={'center':list(center),'span':span,'back':back,'up':up,'right':list(right)}
    if not config.get('portable'):write('views.json',views)
elif mode=='surface':
    targets=[o for o in scene.objects if o.get('forma_id') in config['targets'] and o.type=='MESH']
    before={o.get('forma_id'):geometry_signature(o) for o in targets}
    preserved=scene_snapshot();allowed=config['targets']
    byid={o.get('forma_id'):o for o in targets}
    for item in config['surface']['objects']:
        if item['id'] not in byid:raise ValueError('材质方案引用了目标以外的对象')
        obj=byid[item['id']];obj.data=obj.data.copy();mat=base_material(item)
        obj.data.materials.clear();obj.data.materials.append(mat)
        for poly in obj.data.polygons:poly.material_index=0
        if item['kind']=='image':
            views=json.loads(json.dumps(config.get('views',{})))
            if len(views)!=3:raise ValueError('图片材质缺少三视图纹理')
            for v in views.values():
                filename=v['image']
                if os.path.basename(filename)!=filename:raise ValueError('纹理路径必须在任务目录')
                v['image']=p(filename)
            project_texture(obj,mat,views,scene)
    for o in targets:
        if geometry_signature(o)!=before[o.get('forma_id')]:raise ValueError('外观阶段改变了几何')
    assert_preserved(preserved,allowed)
    studio(targets,config['surface'].get('lighting'))
    for o in scene.objects:
        if not o.get('forma_id'):o['forma_id']=str(uuid.uuid4())
    bpy.ops.wm.save_as_mainfile(filepath=p('raw.blend'),check_existing=False)
else:raise ValueError('未知视觉处理模式')
print('FORMA_VISUAL_OK',mode)
