"""Trusted background adapter: camera fitting and sequential StableGen projection."""
import argparse
import json
import math
from pathlib import Path
import shutil
import sys

import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_stage import load_addon, meshes, export_preview


def camera_fit(job, objects, camera):
    import numpy as np
    from PIL import Image
    reference = Image.open(job / 'reference.png').convert('RGBA')
    box = reference.getchannel('A').point(lambda v: 255 if v > 16 else 0).getbbox()
    if not box: raise ValueError('主图没有可见主体')
    subject = reference.crop(box)
    subject.thumbnail((430, 430), Image.Resampling.LANCZOS)
    square = Image.new('RGBA', (512, 512))
    square.alpha_composite(subject, ((512-subject.width)//2, (512-subject.height)//2))
    square.save(job / 'aligned-reference.png')
    target = np.array(square.getchannel('A').resize((128, 128))) > 100
    yy, xx = np.where(target)
    target_width, target_height = (xx.max()-xx.min()+1)/128, (yy.max()-yy.min()+1)/128
    scene = bpy.context.scene
    scene.render.resolution_x = scene.render.resolution_y = 128
    scene.render.film_transparent = True
    scene.use_nodes = False
    scene.cycles.samples = 1
    corners = []
    for obj in objects:
        stride = max(1, len(obj.data.vertices)//3000)
        corners.extend(obj.matrix_world @ obj.data.vertices[index].co for index in range(0, len(obj.data.vertices), stride))
    temporary = []
    for obj in objects:
        if len(obj.data.polygons) > 20000:
            modifier = obj.modifiers.new('Camera fit proxy', 'DECIMATE')
            modifier.ratio = 20000/len(obj.data.polygons)
            temporary.append((obj, modifier))
    best = None
    trials = []
    try:
        for yaw in [-15, 0, 15]:
            for pitch in [0, 10, 20, 30]:
                y, p = math.radians(yaw), math.radians(pitch)
                camera.location = (2*math.sin(y)*math.cos(p), -2*math.cos(y)*math.cos(p), 2*math.sin(p))
                camera.rotation_euler = (-camera.location).to_track_quat('-Z', 'Y').to_euler()
                camera.data.lens = 50
                camera.data.shift_x = camera.data.shift_y = 0
                bpy.context.view_layer.update()
                points = [world_to_camera_view(scene, camera, v) for v in corners]
                width = max(v.x for v in points)-min(v.x for v in points)
                height = max(v.y for v in points)-min(v.y for v in points)
                camera.data.lens *= min(target_width/max(width, 1e-6), target_height/max(height, 1e-6))
                points = [world_to_camera_view(scene, camera, v) for v in corners]
                camera.data.shift_x = (max(v.x for v in points)+min(v.x for v in points))*.5-.5
                camera.data.shift_y = (max(v.y for v in points)+min(v.y for v in points))*.5-.5
                scene.render.filepath = str(job / 'camera-fit.png')
                bpy.ops.render.render(write_still=True)
                actual = np.array(Image.open(job/'camera-fit.png').convert('RGBA').getchannel('A')) > 100
                score = float((actual & target).sum()/max(1, (actual | target).sum()))
                trials.append({'yaw': yaw, 'pitch': pitch, 'silhouetteIoU': score})
                if best is None or score > best[0]:
                    best = (score, camera.matrix_world.copy(), camera.data.lens, camera.data.shift_x, camera.data.shift_y, yaw, pitch)
    finally:
        for obj, modifier in temporary: obj.modifiers.remove(modifier)
    camera.matrix_world = best[1]
    camera.data.lens, camera.data.shift_x, camera.data.shift_y = best[2:5]
    scene.render.resolution_x = scene.render.resolution_y = 512
    result = {'method': 'bounded perspective silhouette search', 'resolution': 128,
              'silhouetteIoU': best[0], 'yawDegrees': best[5], 'pitchDegrees': best[6],
              'estimated': True, 'trials': trials, 'sourceCrop': box}
    (job/'camera-fit.json').write_text(json.dumps(result, indent=2))
    return result


def settings(runtime, job):
    context = load_addon(runtime)
    context.preferences.addons['stablegen'].preferences.output_dir = str(job/'projection')
    scene = context.scene
    scene.output_timestamp = 'multiview'
    scene.generation_method = 'sequential'
    scene.sequential_ipadapter = False
    scene.bake_visibility_weights = True
    scene.overwrite_material = True
    scene.cycles.device = 'CPU'
    return context


def save(job):
    bpy.context.preferences.filepaths.save_version = 0
    for image in bpy.data.images:
        # Newly projected files may be lazily loaded (has_data=False). Pack the
        # file itself before saving so moving the candidate cannot lose a view.
        if image.source == 'FILE' and Path(bpy.path.abspath(image.filepath)).is_file():
            image.pack()
            if not image.packed_file: raise RuntimeError(f'纹理未能保存到候选：{image.name}')
    bpy.context.scene.cycles.shading_system = False
    bpy.ops.wm.save_as_mainfile(filepath=str(job/'projection.blend'), check_existing=False)


def initialize(runtime, job):
    bpy.ops.wm.open_mainfile(filepath=str(job/'geometry.blend'), load_ui=False, use_scripts=False)
    objects, _ = meshes()
    scene = bpy.context.scene
    camera = scene.camera
    camera.name = '00 Reference'
    fit = json.loads((job/'camera-fit.json').read_text()) if scene.get('forma_camera_fitted') else camera_fit(job, objects, camera)
    original = camera.location.copy()
    for index, (name, angle) in enumerate([('Left', math.pi/2), ('Right', -math.pi/2), ('Back', math.pi)], 1):
        other = bpy.data.objects.new(f'{index:02} {name}', camera.data.copy())
        scene.collection.objects.link(other)
        other.location = (original.x*math.cos(angle)-original.y*math.sin(angle),
                          original.x*math.sin(angle)+original.y*math.cos(angle), original.z)
        other.rotation_euler = (-other.location).to_track_quat('-Z', 'Y').to_euler()
        other.data.lens = 50
        other.data.shift_x = other.data.shift_y = 0
    context = settings(runtime, job)
    from stablegen.texturing.rendering import unwrap
    from stablegen.texturing.projection import project_image
    from stablegen.utils import get_file_path
    for obj in objects: unwrap(obj, 'smart', False)
    destination = Path(get_file_path(context, 'generated', camera_id=0, material_id=0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(job/'aligned-reference.png', destination)
    result = project_image(context, objects, 0, stop_index=0)
    if result is False or isinstance(result, Exception): raise RuntimeError(f'原图投射失败：{result}')
    protect_front(job, objects)
    coverage(job, objects, 0)
    save(job)
    return {'cameraFit': fit, 'projectedViews': 1, 'originalPhotoPreserved': True}


def fit_review(job):
    bpy.ops.wm.open_mainfile(filepath=str(job/'geometry.blend'),load_ui=False,use_scripts=False)
    objects,_=meshes();scene=bpy.context.scene;camera=scene.camera
    fit=camera_fit(job,objects,camera)
    original=camera.matrix_world.copy();position=camera.location.copy()
    lens,shift_x,shift_y=camera.data.lens,camera.data.shift_x,camera.data.shift_y
    scene.cycles.samples=8
    for label,angle in [('front',0),('left',math.pi/2),('right',-math.pi/2),('back',math.pi)]:
        if angle:
            camera.location=(position.x*math.cos(angle)-position.y*math.sin(angle),position.x*math.sin(angle)+position.y*math.cos(angle),position.z)
            camera.rotation_euler=(-camera.location).to_track_quat('-Z','Y').to_euler()
            camera.data.lens=50;camera.data.shift_x=camera.data.shift_y=0
        scene.render.filepath=str(job/f'shape-{label}.png');bpy.ops.render.render(write_still=True)
    camera.matrix_world=original;camera.data.lens=lens;camera.data.shift_x=shift_x;camera.data.shift_y=shift_y
    scene['forma_camera_fitted']=True;bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(job/'geometry.blend'),check_existing=False)
    return {'cameraFit':fit,'neutralReviewViews':4}


def protect_front(job, objects):
    """Keep visible photograph texels; do not let inferred views paint over them."""
    import numpy as np
    from PIL import Image
    alpha = np.array(Image.open(job/'aligned-reference.png').getchannel('A'))/255.
    for obj in objects:
        mesh = obj.data
        uv = np.zeros(len(mesh.loops)*3, dtype=np.float32)
        mesh.attributes['ProjectionUV_0_0'].data.foreach_get('vector', uv)
        uv = uv.reshape(-1, 3)
        x = np.clip((uv[:,0]*512).astype(int), 0, 511)
        y = np.clip(((1-uv[:,1])*512).astype(int), 0, 511)
        samples = alpha[y, x]*((uv[:,0]>=0)&(uv[:,0]<=1)&(uv[:,1]>=0)&(uv[:,1]<=1))
        point_alpha = np.zeros(len(mesh.vertices), dtype=np.float32)
        indices = np.array([loop.vertex_index for loop in mesh.loops])
        np.maximum.at(point_alpha, indices, samples)
        front = np.zeros(len(mesh.vertices), dtype=np.float32)
        mesh.attributes['_SG_VisWeight_0_0'].data.foreach_get('value', front)
        front *= point_alpha
        mesh.attributes['_SG_VisWeight_0_0'].data.foreach_set('value', front)
        protected = np.clip(front/.03, 0, 1)
        for index in range(1, 4):
            weight = np.zeros(len(mesh.vertices), dtype=np.float32)
            attribute = mesh.attributes[f'_SG_VisWeight_{index}_0']
            attribute.data.foreach_get('value', weight)
            attribute.data.foreach_set('value', weight*(1-protected))


def render_view(runtime, job, index):
    bpy.ops.wm.open_mainfile(filepath=str(job/'projection.blend'), load_ui=False, use_scripts=False)
    settings(runtime, job)
    scene = bpy.context.scene
    cameras = sorted([o for o in scene.objects if o.type == 'CAMERA'], key=lambda o:o.name)
    scene.camera = cameras[index]
    scene.cycles.shading_system = False
    scene.cycles.samples = 8
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.use_nodes = False
    target = job/f'view-{index}'
    target.mkdir(exist_ok=True)
    scene.render.filepath = str(target/'context.png')
    bpy.ops.render.render(write_still=True)
    scene.view_layers[0].use_pass_z = True
    scene.use_nodes = True
    nodes = scene.node_tree.nodes
    nodes.clear()
    layer = nodes.new('CompositorNodeRLayers')
    remap = nodes.new('CompositorNodeMapRange')
    remap.inputs['From Min'].default_value = 1.3
    remap.inputs['From Max'].default_value = 2.8
    remap.inputs['To Min'].default_value = 1
    remap.inputs['To Max'].default_value = 0
    remap.use_clamp = True
    output = nodes.new('CompositorNodeComposite')
    scene.node_tree.links.new(layer.outputs['Depth'], remap.inputs['Value'])
    scene.node_tree.links.new(remap.outputs['Value'], output.inputs['Image'])
    scene.render.filepath = str(target/'depth.png')
    bpy.ops.render.render(write_still=True)
    shutil.copyfile(job/'aligned-reference.png', target/'reference.png')
    return {'view': index, 'existingTextureReference': True}


def coverage(job, objects, index):
    import numpy as np
    from PIL import Image
    photo = np.array(Image.open(job/'aligned-reference.png').convert('RGBA'), dtype=np.float32)/255
    color = (photo[:,:,:3]*photo[:,:,3:]).sum(axis=(0,1))/max(1, photo[:,:,3].sum())
    color = [float(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for v in color]
    uncovered = vertices = 0
    for obj in objects:
        mesh = obj.data
        total = np.zeros(len(mesh.vertices), dtype=np.float32)
        for view in range(index+1):
            values = np.zeros(len(mesh.vertices), dtype=np.float32)
            mesh.attributes[f'_SG_VisWeight_{view}_0'].data.foreach_get('value', values)
            total += values
        known = (total>1e-5).astype(np.float32)
        uncovered += int((known==0).sum()); vertices += len(known)
        attribute = mesh.attributes.get('_FormaCoverage') or mesh.attributes.new('_FormaCoverage','FLOAT','POINT')
        attribute.data.foreach_set('value', known)
        material = obj.active_material
        nodes, links = material.node_tree.nodes, material.node_tree.links
        previous = nodes.get('Forma Uncovered Fill')
        if previous and previous.type == 'MIX_SHADER':
            # Recover candidates produced by the initial adapter. StableGen's
            # diffuse baker expects a color socket, not a closure converted to color.
            output = next(n for n in nodes if n.type=='OUTPUT_MATERIAL')
            links.new(previous.inputs[2].links[0].from_socket, output.inputs['Surface'])
            nodes.remove(previous)
        if not nodes.get('Forma Uncovered Fill'):
            output = next(n for n in nodes if n.type=='OUTPUT_MATERIAL')
            source = output.inputs['Surface'].links[0].from_socket
            factor = nodes.new('ShaderNodeAttribute');factor.attribute_name='_FormaCoverage'
            # StableGen connects its projected color directly to Surface and
            # inserts Principled for color-only baking. Keep that color contract.
            mix = nodes.new('ShaderNodeMixRGB');mix.name='Forma Uncovered Fill'
            mix.blend_type='MIX';mix.inputs[1].default_value=(*color,1)
            links.new(factor.outputs['Fac'],mix.inputs[0])
            links.new(source,mix.inputs[2]);links.new(mix.outputs[0],output.inputs['Surface'])
    (job/f'coverage-{index}.json').write_text(json.dumps({'projectedViews':index+1,
        'unprojectedVertexFraction':uncovered/max(1,vertices),
        'fallback':'reference average color, inferred rather than observed'},indent=2))


def update_projection(runtime, job, index):
    bpy.ops.wm.open_mainfile(filepath=str(job/'projection.blend'), load_ui=False, use_scripts=False)
    context = settings(runtime, job)
    from stablegen.texturing.projection import project_image
    from stablegen.utils import get_file_path
    destination = Path(get_file_path(context, 'generated', camera_id=index, material_id=0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(job/f'view-{index}/generated-texture.png', destination)
    objects, _ = meshes()
    result = project_image(context, objects, 0, stop_index=index)
    if result is False or isinstance(result, Exception): raise RuntimeError(f'多视角投射失败：{result}')
    coverage(job, objects, index)
    save(job)
    return {'projectedViews': index+1}


def bake(runtime, job):
    bpy.ops.wm.open_mainfile(filepath=str(job/'projection.blend'), load_ui=False, use_scripts=False)
    context = settings(runtime, job)
    from stablegen.texturing.rendering import prepare_baking, bake_texture
    objects, counts = meshes()
    coverage(job, objects, 3)
    prepare_baking(context)
    context.scene.cycles.shading_system = False
    target = job/'baked'
    target.mkdir(exist_ok=True)
    for obj in objects:
        if not bake_texture(context, obj, 2048, output_dir=str(target)): raise RuntimeError('纹理烘焙失败')
        image = bpy.data.images.get(f'{obj.name}_baked')
        if image is None or not image.has_data: raise RuntimeError('烘焙纹理为空')
        image.pack()
        material = bpy.data.materials.new(f'{obj.name}_export')
        material.use_nodes = True
        texture = material.node_tree.nodes.new('ShaderNodeTexImage')
        texture.image = image
        material.node_tree.links.new(texture.outputs['Color'], material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
        obj.data.materials.clear();obj.data.materials.append(material)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(job/'textured.blend'), check_existing=False)
    preview = export_preview(job, 'textured.glb', objects)
    scene = bpy.context.scene
    scene.use_nodes = False
    scene.cycles.samples = 8
    cameras = sorted([o for o in scene.objects if o.type=='CAMERA'],key=lambda o:o.name)
    for index, camera in enumerate(cameras):
        scene.camera=camera;scene.render.filepath=str(job/f'textured-view-{index}.png')
        bpy.ops.render.render(write_still=True)
    return {'mesh': counts, 'preview': preview, 'atlas': 2048, 'views': 4}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--mode', choices=['initialize', 'fit-review', 'view', 'project', 'bake'], required=True)
    parser.add_argument('--index', type=int, choices=[1,2,3], default=1)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    sys.path.append(str(args.runtime/'blender-python'))
    if args.mode == 'initialize': result = initialize(args.runtime, args.job)
    elif args.mode == 'fit-review': result = fit_review(args.job)
    elif args.mode == 'view': result = render_view(args.runtime, args.job, args.index)
    elif args.mode == 'project': result = update_projection(args.runtime, args.job, args.index)
    else: result = bake(args.runtime, args.job)
    (args.job/f'{args.mode}-{args.index}-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('FORMA_MULTIVIEW_OK', json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
