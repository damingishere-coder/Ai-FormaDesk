"""Isolated PhotoFit stage runner. Only reads/writes its supplied job directory.

Generated initial scripts execute separately from validation. Correction stages
use validated data, never eval arbitrary model text. No workbench version writes.
"""
import hashlib
import ast
import json
import math
import itertools
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Vector, Matrix, Quaternion
from bpy_extras.object_utils import world_to_camera_view

sys.path.insert(0, str(Path(__file__).resolve().parent))
import photo_fit_geometry as fit
import stylized_geometry as sty


def write(directory, name, value):
    (directory/name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


def objects():
    result = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.hide_render]
    if not result or len(bpy.context.scene.objects) > 1500:
        raise ValueError('没有主体网格或对象数量超限')
    total = 0
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in result:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            total += len(mesh.vertices)
            if total > 2_000_000:
                raise ValueError('应用修改器后的顶点超出 200 万')
            coords = np.empty(len(mesh.vertices)*3)
            mesh.vertices.foreach_get('co', coords)
            if not np.isfinite(coords).all():
                raise ValueError('网格包含非有限坐标')
        finally:
            evaluated.to_mesh_clear()
    return result


def digest(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inventory(meshes):
    result = []
    for obj in meshes:
        fit.identify(obj, obj.get('forma_part', obj.name))
        world = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        result.append({'objectId': obj['forma_id'], 'name': obj.name,
            'vertices': len(obj.data.vertices), 'faces': len(obj.data.polygons),
            'bounds': [[min(v[i] for v in world) for i in range(3)], [max(v[i] for v in world) for i in range(3)]],
            'coordinatesHash': hashlib.sha256(fit.coordinates(obj).tobytes()).hexdigest(),
            'topologyHash': digest([list(p.vertices) for p in obj.data.polygons]),
            'uvHash': digest([[tuple(v.uv) for v in layer.data] for layer in obj.data.uv_layers]),
            'transformHash': digest([list(row) for row in obj.matrix_world]),
            'materials': [m.name if m else None for m in obj.data.materials],
            'modifiers': [(m.name, m.type) for m in obj.modifiers]})
    return result


def bounds(meshes):
    corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    return [[min(v[i] for v in corners) for i in range(3)], [max(v[i] for v in corners) for i in range(3)]]


def pixels(file):
    image = bpy.data.images.load(str(file), check_existing=False)
    w, h = image.size
    data = np.empty(w*h*4, dtype=np.float32)
    image.pixels.foreach_get(data)
    bpy.data.images.remove(image)
    return np.flipud(data.reshape(h, w, 4)).copy()


def save_pixels(file, data):
    h, w, _ = data.shape
    image = bpy.data.images.new('PhotoFit diagnostic', width=w, height=h, alpha=True)
    image.colorspace_settings.name = 'Non-Color'
    image.pixels.foreach_set(np.flipud(data).astype(np.float32).ravel())
    image.filepath_raw, image.file_format = str(file), 'PNG'
    image.save()
    bpy.data.images.remove(image)


def render(directory, name, size=512):
    scene = bpy.context.scene
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.filepath = str(directory/name)
    bpy.ops.render.render(write_still=True)
    return pixels(directory/name)


def camera_record(camera):
    return {'matrix': [list(row) for row in camera.matrix_world], 'lens': camera.data.lens,
            'shiftX': camera.data.shift_x, 'shiftY': camera.data.shift_y,
            'sensorWidth': camera.data.sensor_width, 'sensorFit': camera.data.sensor_fit,
            'type': camera.data.type, 'orthoScale': camera.data.ortho_scale}


def set_camera(camera, value):
    camera.matrix_world = Matrix(value['matrix'])
    camera.data.type, camera.data.lens = value['type'], value['lens']
    camera.data.shift_x, camera.data.shift_y = value['shiftX'], value['shiftY']
    camera.data.sensor_width, camera.data.sensor_fit = value['sensorWidth'], value['sensorFit']
    camera.data.ortho_scale = value['orthoScale']
    bpy.context.view_layer.update()


def setup(meshes):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 4
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.use_nodes = False
    scene.view_settings.view_transform = 'Standard'
    if scene.world is None:
        scene.world = bpy.data.worlds.new('PhotoFit world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = .65
    neutral = bpy.data.materials.new('PhotoFit gray inspection')
    neutral.use_nodes = True
    node = neutral.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = (.52, .54, .57, 1)
    node.inputs['Roughness'].default_value = .8
    # Overrides for inspection only: saved .blend retains original materials.
    scene.view_layers[0].material_override = neutral
    for light in [o for o in scene.objects if o.type == 'LIGHT']:
        light.hide_render = True
    light = bpy.data.objects.new('PhotoFit inspection sun', bpy.data.lights.new('PhotoFit sun', 'SUN'))
    scene.collection.objects.link(light)
    light.data.energy = 2
    light.rotation_euler = (.4, -.3, -.4)
    camera = scene.camera
    if camera is None:
        camera = bpy.data.objects.new('PhotoFit camera', bpy.data.cameras.new('PhotoFit camera'))
        scene.collection.objects.link(camera)
    scene.camera = camera
    return camera


def camera_fit(directory, meshes, camera, target, box):
    # Render real silhouettes. Proxy decimation would bias the fit for thin leaves.
    low, high = map(Vector, box)
    center, extent = (low+high)/2, max(high-low)
    if extent < 1e-8:
        raise ValueError('主体范围无效')
    bpy.context.scene.cycles.samples = 1
    # reference-128 is an independently resized, padded primary input.
    small = pixels(directory/'reference-128.png')[:, :, 3] > .4
    ys, xs = np.where(small)
    if not len(xs):
        raise ValueError('照片主体蒙版为空')
    target_size = np.array([(xs.max()-xs.min()+1)/128, (ys.max()-ys.min()+1)/128])
    target_center = np.array([(xs.max()+xs.min()+1)/256, 1-(ys.max()+ys.min()+1)/256])
    points = [o.matrix_world @ o.data.vertices[i].co for o in meshes
              for i in range(0, len(o.data.vertices), max(1, len(o.data.vertices)//1500))]
    trials = []
    best = None
    for yaw in (-30, 0, 30):
        for pitch in (0, 15, 30):
            for lens in (35, 65):
                y, p = math.radians(yaw), math.radians(pitch)
                camera.data.type, camera.data.lens = 'PERSP', lens
                camera.data.shift_x = camera.data.shift_y = 0
                distance = extent*2.4*lens/50
                camera.location = center+Vector((math.sin(y)*math.cos(p), -math.cos(y)*math.cos(p), math.sin(p)))*distance
                camera.rotation_euler = (center-camera.location).to_track_quat('-Z', 'Y').to_euler()
                bpy.context.view_layer.update()
                projected = np.array([(v.x, v.y) for v in (world_to_camera_view(bpy.context.scene, camera, c) for c in points)])
                span = np.ptp(projected, axis=0)
                camera.data.lens *= float(min(target_size/np.maximum(span, 1e-6)))
                projected = np.array([(v.x, v.y) for v in (world_to_camera_view(bpy.context.scene, camera, c) for c in points)])
                mid = (projected.max(axis=0)+projected.min(axis=0))/2
                camera.data.shift_x, camera.data.shift_y = mid-target_center
                mask = render(directory, 'fit-trial.png', 128)[:, :, 3] > .4
                score = float((mask & small).sum()/max(1, (mask | small).sum()))
                trials.append({'yaw': yaw, 'pitch': pitch, 'lens': lens, 'iou': score})
                if best is None or score > best[0]:
                    best = (score, camera_record(camera))
    # Local roll search follows perspective search; no geometry is changed here.
    for roll in (-6, 6):
        set_camera(camera, best[1])
        camera.rotation_euler = (camera.rotation_euler.to_quaternion() @ Quaternion((0, 0, 1), math.radians(roll))).to_euler()
        mask = render(directory, 'fit-trial.png', 128)[:, :, 3] > .4
        score = float((mask & small).sum()/max(1, (mask | small).sum()))
        trials.append({'roll': roll, 'iou': score})
        if score > best[0]:
            best = (score, camera_record(camera))
    set_camera(camera, best[1])
    write(directory, 'camera-trials.json', trials)
    bpy.context.scene.cycles.samples = 4


def measure(directory, reference, actual, constraints):
    target, current = reference[:, :, 3] > .4, actual[:, :, 3] > .4
    union = int((target | current).sum())
    error = 1-float((target & current).sum()/max(1, union))
    difference = np.zeros_like(reference)
    difference[:, :, 3] = 1
    difference[target & current, :3] = (.45, .45, .45)
    difference[target & ~current, :3] = (0, .8, .25)
    difference[current & ~target, :3] = (.95, .1, .05)
    save_pixels(directory/'difference.png', difference)
    overlay = reference.copy()
    overlay[:, :, :3] = .55*reference[:, :, :3]+.45*actual[:, :, :3]
    overlay[:, :, 3] = np.maximum(reference[:, :, 3], actual[:, :, 3])
    save_pixels(directory/'overlay.png', overlay)
    # 2D GPT landmarks are not 3D correspondences. Record validation, never invent
    # a keypoint distance by matching each point to whichever mesh vertex is close.
    checked = []
    for point in constraints.get('landmarks', []):
        x, y = int(point['x']*511), int(point['y']*511)
        patch = target[max(0,y-4):min(512,y+5), max(0,x-4):min(512,x+5)]
        valid = bool(patch.any()) and (not point['onSilhouette'] or not patch.all())
        checked.append({**point, 'maskConsistent': valid, 'eligible': valid and point['visible'] and point['confidence'] >= .8,
                        'usedForMetric': False, 'reason': '等待可靠的 2D/3D 同名对应点'})
    return {'silhouetteError': error, 'landmarkError': None, 'proportionError': None,
            'componentCount': None, 'landmarks': checked,
            'note': '轮廓误差不等于还原率；没有可靠对应点时其他数值保持空值'}


def region_errors(directory, reference, actual, operations, box, camera):
    old_file = directory/'before-front.png'
    if not operations or not old_file.exists(): return None
    old = pixels(old_file)
    low, high = np.array(box)
    span = high-low
    roi = np.zeros(reference.shape[:2], dtype=bool)
    for op in operations:
        corners = [low+(np.array(op['center'])+np.array(sign)*np.array(op['radius']))*span
                   for sign in itertools.product((-1,1), repeat=3)]
        points = [world_to_camera_view(bpy.context.scene, camera, Vector(v)) for v in corners]
        if any(v.z <= 0 for v in points): raise ValueError('修正区域在相机后方，无法对照')
        x0,x1 = np.clip([math.floor(min(v.x for v in points)*512), math.ceil(max(v.x for v in points)*512)],0,512)
        y0,y1 = np.clip([math.floor((1-max(v.y for v in points))*512), math.ceil((1-min(v.y for v in points))*512)],0,512)
        roi[y0:y1,x0:x1]=True
    target = reference[:,:,3]>.4
    def error(image):
        mask=image[:,:,3]>.4
        union = ((mask|target)&roi).sum()
        return 1-float(((mask&target)&roi).sum()/max(1,union)) if union else None
    return {'before':error(old),'after':error(actual),'roiFraction':float(roi.mean()),
            'method':'same-camera projected support bounding rectangles, silhouette only'}


def export_preview(directory, meshes, full_image):
    def triangle_count():
        count=0
        graph=bpy.context.evaluated_depsgraph_get()
        for obj in meshes:
            evaluated=obj.evaluated_get(graph); mesh=evaluated.to_mesh()
            try:
                mesh.calc_loop_triangles(); count+=len(mesh.loop_triangles)
            finally: evaluated.to_mesh_clear()
        return count
    original=triangle_count()
    temporary=[]
    try:
        if original>150_000:
            for obj in meshes:
                modifier=obj.modifiers.new('PhotoFit preview only','DECIMATE')
                modifier.ratio=145_000/original
                temporary.append((obj,modifier))
        triangles=triangle_count()
        if triangles>150_000: raise ValueError('网页预览超出 15 万三角面')
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes: obj.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(directory/'preview.glb'), export_format='GLB',
            use_selection=True, export_apply=True, export_extras=True, export_animations=False)
        preview=render(directory,'preview-front.png')
        a,b=full_image[:,:,3]>.4,preview[:,:,3]>.4
        return {'sourceTriangles':original,'previewTriangles':triangles,
                'silhouetteDeviation':1-float((a&b).sum()/max(1,(a|b).sum()))}
    finally:
        for obj,modifier in temporary: obj.modifiers.remove(modifier)


def visible_anchors(camera, box):
    low,high=np.array(box); span=np.maximum(high-low,1e-8)
    frame=camera.data.view_frame(scene=bpy.context.scene)
    x0,x1=min(v.x for v in frame),max(v.x for v in frame)
    y0,y1=min(v.y for v in frame),max(v.y for v in frame)
    result=[];graph=bpy.context.evaluated_depsgraph_get()
    for row in range(1,10):
        for col in range(1,10):
            x,y=col/10,row/10
            direction=camera.matrix_world.to_quaternion() @ Vector((x0+(x1-x0)*x,y1-(y1-y0)*y,frame[0].z))
            hit,location,normal,index,obj,_=bpy.context.scene.ray_cast(graph,camera.location,direction.normalized())
            if not hit or obj.type!='MESH' or obj.hide_render or not obj.get('forma_id'): continue
            normalized=(np.array(location)-low)/span
            if np.any(normalized<0) or np.any(normalized>1): continue
            result.append({'id':f'{row}{col}','x':x,'y':y,'objectId':obj['forma_id'],
                           'center':normalized.tolist(),'faceIndex':index})
    return result


def main():
    mode, folder = sys.argv[sys.argv.index('--')+1:]
    directory = Path(folder).resolve()
    request = json.loads((directory/'request.json').read_text())
    bpy.context.preferences.filepaths.save_version = 0
    if mode == 'script':
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        source = (directory/'generated.py').read_text()
        tree = ast.parse(source)
        declarations = [n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PARAMS' for t in n.targets)]
        params = {}
        if len(declarations) == 1:
            try:
                params = ast.literal_eval(declarations[0].value)
                if not isinstance(params, dict): params = {}
            except (ValueError, TypeError): pass
        exposed = {k: {'value':v, 'min':v-max(abs(v)*.35,.025), 'max':v+max(abs(v)*.35,.025), 'integer':isinstance(v,int)}
                   for k,v in params.items() if isinstance(k,str) and isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)}
        if request.get('stylized'):
            rule_nodes=[n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PARAM_RULES' for t in n.targets)]
            if len(rule_nodes)!=1: raise ValueError('需要字面量 PARAM_RULES')
            rules=ast.literal_eval(rule_nodes[0].value)
            exposed=sty.parameter_contract(params,rules,request.get('frozenParameters'))
        updates = request.get('parameters', {})
        if len(updates)>3: raise ValueError('每轮最多调整三个参数')
        for key,value in updates.items():
            limit=exposed.get(key)
            if limit is None or not isinstance(value,(int,float)) or not math.isfinite(value) or not limit['min']<=value<=limit['max']:
                raise ValueError('参数不存在或超出冻结范围：'+key)
            if limit['integer'] and int(value)!=value: raise ValueError('整数参数不能设为小数')
            params[key]=int(value) if limit['integer'] else value
        if updates:
            declarations[0].value=ast.parse(repr(params), mode='eval').body
            ast.fix_missing_locations(tree)
        exec(compile(tree, 'generated.py', 'exec'), {'bpy': bpy, 'fit': fit, 'sty':sty, '__name__': '__main__'})
        if request.get('stylized'): sty.validate_targets(exposed)
        for obj in bpy.context.scene.objects:
            if obj.name in request.get('identities', {}): obj['forma_id']=request['identities'][obj.name]
        write(directory, 'parameters.json', {k:{**v,'value':params[k]} for k,v in exposed.items()})
        (directory/'effective.py').write_text(ast.unparse(tree))
        bpy.ops.wm.save_as_mainfile(filepath=str(directory/'input.blend'), check_existing=False)
        return
    bpy.ops.wm.open_mainfile(filepath=str(directory/'input.blend'), load_ui=False, use_scripts=False)
    # Keep the source script as the editable procedural representation. The fit
    # candidate uses evaluated meshes so curves participate in bounds and audits.
    for obj in list(bpy.context.scene.objects):
        if obj.type in ('CURVE','SURFACE','META','FONT') and not obj.hide_render:
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True)
            bpy.context.view_layer.objects.active=obj
            bpy.ops.object.convert(target='MESH')
    meshes = objects()
    before = inventory(meshes)
    box = request.get('bounds') or bounds(meshes)
    changes = []
    if mode=='palette':
        sty.apply_palette(meshes,request['palette'])
        after=inventory(meshes)
        for a,b in zip(before,after):
            for key in ('objectId','coordinatesHash','topologyHash','uvHash','transformHash','modifiers'):
                if a[key]!=b[key]:raise ValueError('上色破坏几何：'+key)
    if mode == 'correct':
        changes = fit.apply_local_operations(meshes, request['operations'], box, request.get('strength', 1))
        after = inventory(objects())
        touched = {o['objectId'] for o in request['operations']}
        for a, b in zip(before, after):
            for key in ('objectId', 'topologyHash', 'uvHash', 'transformHash', 'materials', 'modifiers'):
                if a[key] != b[key]:
                    raise ValueError('局部修正破坏了 '+key)
            if a['objectId'] not in touched and a['coordinatesHash'] != b['coordinatesHash']:
                raise ValueError('非目标对象被修改')
    # Save editable geometry before adding inspection-only lights/materials.
    bpy.ops.wm.save_as_mainfile(filepath=str(directory/'candidate.blend'), check_existing=False)
    camera = setup(meshes)
    reference = pixels(directory/'reference.png')
    if request.get('camera'):
        set_camera(camera, request['camera'])
    else:
        camera_fit(directory, meshes, camera, reference, box)
    fixed = camera_record(camera)
    anchors=visible_anchors(camera,box)
    actual = render(directory, 'front.png')
    metrics = measure(directory, reference, actual, request.get('constraints', {}))
    target_errors = region_errors(directory, reference, actual, request.get('operations', []), box, camera)
    if target_errors: metrics['targetRegionError']=target_errors['after']
    center = Vector(tuple((a+b)/2 for a,b in zip(*box)))
    relative = camera.location-center
    for name, angle in [('left', -math.pi/2), ('right', math.pi/2), ('back', math.pi)]:
        camera.location = center+Vector((relative.x*math.cos(angle)-relative.y*math.sin(angle), relative.x*math.sin(angle)+relative.y*math.cos(angle), relative.z))
        camera.rotation_euler = (center-camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.shift_x = camera.data.shift_y = 0
        render(directory, name+'.png')
    set_camera(camera, fixed)
    if request.get('colorViews'):
        bpy.context.scene.view_layers[0].material_override=None
        bpy.context.scene.cycles.samples=16
        render(directory,'color-front.png')
        for name,angle in [('left',-math.pi/2),('right',math.pi/2),('back',math.pi)]:
            camera.location=center+Vector((relative.x*math.cos(angle)-relative.y*math.sin(angle),relative.x*math.sin(angle)+relative.y*math.cos(angle),relative.z))
            camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
            camera.data.shift_x=camera.data.shift_y=0
            render(directory,'color-'+name+'.png')
        set_camera(camera,fixed)
    preview=export_preview(directory,meshes,actual)
    write(directory, 'report.json', {'metrics': metrics, 'camera': fixed, 'bounds': box,
        'objects': inventory(meshes), 'changes': changes, 'geometryValid': True,
        'targetRegion': target_errors,
        'preview':preview,
        'anchors':anchors,
        'cameraReused': bool(request.get('camera')), 'stage': mode})


if __name__ == '__main__':
    main()
