"""Trusted material, bake and studio helpers. No generated code runs here."""
import bpy, math, json, hashlib, os
from mathutils import Vector

def geometry_signature(obj):
    data = {'type':obj.type, 'matrix':[list(r) for r in obj.matrix_world], 'parent':obj.parent.get('forma_id') if obj.parent else None}
    modifiers=[]
    for modifier in obj.modifiers:
        values={}
        for prop in modifier.bl_rna.properties:
            if prop.identifier=='rna_type' or prop.is_readonly:continue
            value=getattr(modifier,prop.identifier,None)
            if isinstance(value,(str,int,float,bool)) or value is None:values[prop.identifier]=value
            elif hasattr(value,'name'):values[prop.identifier]=value.name
            else:
                try:values[prop.identifier]=list(value)
                except TypeError:pass
        modifiers.append((modifier.type,values))
    data['modifiers']=modifiers
    if obj.type=='LIGHT':data['light']={'type':obj.data.type,'energy':obj.data.energy,'color':list(obj.data.color)}
    if obj.type == 'MESH':
        data['vertices']=[list(v.co) for v in obj.data.vertices]
        data['faces']=[list(p.vertices) for p in obj.data.polygons]
    return hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()

def material_signature(obj):
    result=[]
    for slot in getattr(obj,'material_slots',[]):
        mat=slot.material
        if not mat: result.append(None); continue
        nodes=[]
        if mat.use_nodes:
            for n in mat.node_tree.nodes:
                values=[]
                for s in n.inputs:
                    if hasattr(s,'default_value'):
                        v=s.default_value
                        try: v=list(v)
                        except TypeError: pass
                        values.append((s.name,str(v)))
                image=None
                if n.type=='TEX_IMAGE' and n.image:
                    image=(n.image.name,list(n.image.size),hashlib.sha256(n.image.packed_file.data).hexdigest() if n.image.packed_file else None)
                nodes.append((n.name,n.type,values,image))
        result.append((mat.name,nodes,[(l.from_node.name,l.from_socket.name,l.to_node.name,l.to_socket.name) for l in mat.node_tree.links] if mat.use_nodes else []))
    return hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()

def scene_snapshot():
    return {str(o.get('forma_id')):{'geometry':geometry_signature(o),'material':material_signature(o), 'visible':not o.hide_render} for o in bpy.context.scene.objects if o.get('forma_id')}

def assert_preserved(snapshot, allowed=()):
    current=scene_snapshot()
    for oid, old in snapshot.items():
        if oid in allowed:continue
        if current.get(oid)!=old:raise ValueError('未授权改变已有对象: '+oid)

from material_controls import node, rgb, adjust_material

def bounds(objects):
    points=[o.matrix_world@Vector(c) for o in objects if o.type=='MESH' for c in o.bound_box]
    if not points:raise ValueError('没有可检查的网格主体')
    lo=Vector(tuple(min(v[i] for v in points) for i in range(3))); hi=Vector(tuple(max(v[i] for v in points) for i in range(3)))
    return (lo+hi)/2, max(max(hi-lo),.01)

def studio(objects, settings=None):
    scene=bpy.context.scene; center, span=bounds(objects)
    # Respect existing user lights. Studio lights are added once for scenes without lights.
    if not any(o.type=='LIGHT' for o in scene.objects):
        for name,key,offset,power,size in [('主光','key',(2,-3,4),150,2.5),('补光','fill',(-3,-1,2),65,3),('轮廓光','rim',(1,3,3),100,2)]:
            factor=max(.25,min(2,(settings or {}).get(key,1)))
            light=bpy.data.lights.new('自然展示·'+name,'AREA');light.energy=power*span*span*factor;light.shape='SQUARE';light.size=size*span
            ob=bpy.data.objects.new(light.name,light);scene.collection.objects.link(ob);ob.location=center+Vector(offset)*span
            ob.rotation_euler=(center-ob.location).to_track_quat('-Z','Y').to_euler();ob['forma_studio']=True
    if not scene.get('forma_lighting'):scene['forma_lighting']=json.dumps({'version':1,'worldColor':'#d9d9d9','worldStrength':.25,'exposure':0,'viewTransform':'Standard'})
    if settings:
        config=json.loads(scene['forma_lighting']);config['exposure']=max(-2,min(2,settings['exposure']));config['worldStrength']=max(.05,min(2,settings['worldStrength']));config['viewTransform']=settings.get('viewTransform','Standard');scene['forma_lighting']=json.dumps(config)
    configure_world(scene)

def configure_world(scene):
    settings=json.loads(scene.get('forma_lighting','{}'))
    if not settings:return
    if not scene.world:scene.world=bpy.data.worlds.new('自然展示环境')
    scene.world.use_nodes=True;n=scene.world.node_tree.nodes.get('Background')
    if not n:n=scene.world.node_tree.nodes.new('ShaderNodeBackground')
    output=next((v for v in scene.world.node_tree.nodes if v.type=='OUTPUT_WORLD'),None) or scene.world.node_tree.nodes.new('ShaderNodeOutputWorld')
    for socket in (n.inputs['Color'],n.inputs['Strength']):
        for link in list(socket.links):scene.world.node_tree.links.remove(link)
    scene.world.node_tree.links.new(n.outputs[0],output.inputs['Surface'])
    n.inputs['Color'].default_value=(*rgb(settings['worldColor']),1);n.inputs['Strength'].default_value=settings['worldStrength']
    scene.view_settings.view_transform=settings.get('viewTransform','Standard');scene.view_settings.look='None';scene.view_settings.exposure=settings['exposure'];scene.view_settings.gamma=1

def ensure_render_lighting(scene):
    """Keep the saved scene's world graph, light rig and color management.

    Legacy scenes have no forma_lighting metadata; that does not mean their
    deliberately authored lighting is missing. Only supply genuinely absent
    resources in this disposable render process, never rewrite the source file.
    """
    if scene.world is None:
        scene.world=bpy.data.worlds.new('预览环境')
        scene.world.use_nodes=True
    if not any(o.type=='LIGHT' for o in scene.objects):
        data=bpy.data.lights.new('预览补光','SUN');data.energy=2
        light=bpy.data.objects.new('预览补光',data);scene.collection.objects.link(light)
        light.rotation_euler=(.45,-.5,-.5)

def base_material(item):
    mat=bpy.data.materials.new('外观·'+item['id'][:8]);mat.use_nodes=True;n=node(mat)
    n.inputs['Base Color'].default_value=(*rgb(item['color']),1);n.inputs['Roughness'].default_value=item['roughness'];n.inputs['Metallic'].default_value=item['metalness']
    mat['forma_controls']=json.dumps({k:item[k] for k in ('color','roughness','metalness')})
    mat['forma_surface_group']=item['id']
    if item['kind'] in ('wood','fabric'):
        tex=mat.node_tree.nodes.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=5 if item['kind']=='wood' else 180;tex.inputs['Detail'].default_value=2
        coords=mat.node_tree.nodes.new('ShaderNodeTexCoord');mapping=mat.node_tree.nodes.new('ShaderNodeVectorMath');mapping.operation='MULTIPLY';mapping.inputs[1].default_value=(15,15,1) if item['kind']=='wood' else (1,1,1)
        mat.node_tree.links.new(coords.outputs['Generated'],mapping.inputs[0]);mat.node_tree.links.new(mapping.outputs[0],tex.inputs['Vector'])
        ramp=mat.node_tree.nodes.new('ShaderNodeValToRGB')
        for element,scale in zip(ramp.color_ramp.elements,(.55,1.15)):element.color=tuple(min(1,v*scale) for v in rgb(item['color']))+(1,)
        mat.node_tree.links.new(tex.outputs['Fac'],ramp.inputs[0]);mat.node_tree.links.new(ramp.outputs[0],n.inputs['Base Color'])
        bump=mat.node_tree.nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.12;bump.inputs['Distance'].default_value=.002
        mat.node_tree.links.new(tex.outputs['Fac'],bump.inputs['Height']);mat.node_tree.links.new(bump.outputs[0],n.inputs['Normal'])
    return mat

def project_texture(obj, mat, views, scene):
    """Select visible, front-facing source per face. Hidden surfaces keep base material."""
    obj.data.materials.clear();obj.data.materials.append(mat)
    uv=obj.data.uv_layers.get('FormaProjection') or obj.data.uv_layers.new(name='FormaProjection')
    obj.data.uv_layers.active=uv
    slots={}
    for name,view in views.items():
        image=bpy.data.images.load(view['image'],check_existing=True);image.pack()
        mapped=mat.copy();mapped.name=mat.name+'·'+name;n=node(mapped)
        tex=mapped.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image;tex.extension='EXTEND'
        coord=mapped.node_tree.nodes.new('ShaderNodeUVMap');coord.uv_map=uv.name
        mapped.node_tree.links.new(coord.outputs['UV'],tex.inputs['Vector']);mapped.node_tree.links.new(tex.outputs['Color'],n.inputs['Base Color'])
        obj.data.materials.append(mapped);slots[name]=len(obj.data.materials)-1
    graph=bpy.context.evaluated_depsgraph_get()
    for poly in obj.data.polygons:
        center=obj.matrix_world@poly.center;normal=(obj.matrix_world.to_3x3().inverted().transposed()@poly.normal).normalized()
        best=None;quality=.02
        for name,view in views.items():
            direction=Vector(view['back']);score=normal.dot(direction)
            if score<=quality:continue
            # Trace from beyond the subject; reject occluded faces rather than painting through.
            origin=center+direction*view['span']*4
            hit,loc,_,_,_,_=scene.ray_cast(graph,origin,-direction,distance=view['span']*5)
            if hit and (loc-center).length>max(view['span']*.003,.00001):continue
            projected=[]
            for li in poly.loop_indices:
                p=obj.matrix_world@obj.data.vertices[obj.data.loops[li].vertex_index].co-Vector(view['center'])
                projected.append((.5+p.dot(Vector(view['right']))/view['span'],.5+p.dot(Vector(view['up']))/view['span']))
            if any(u<0 or u>1 or v<0 or v>1 for u,v in projected):continue
            quality=score;best=(name,projected)
        if best:
            poly.material_index=slots[best[0]]
            for li,coords in zip(poly.loop_indices,best[1]):uv.data[li].uv=coords
        else:poly.material_index=0

def bake_portable(objects, size=1024, directory=None):
    from portable import portable_materials
    # Legacy trusted pipeline callers still get a complete selective export.
    return portable_materials(objects, directory or os.path.join(bpy.app.tempdir, 'forma-textures'), size=size, budget=600)
