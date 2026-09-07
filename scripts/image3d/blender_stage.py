"""Trusted, non-modal StableGen adapter for the Stage A compatibility gate.

Run in a fresh Blender process. Inputs and outputs belong to a disposable job;
this adapter never opens or commits a workbench revision.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys
import time
import math
from types import SimpleNamespace

import bpy
from mathutils import Vector


class BackgroundContext:
    """Only substitute the optional redraw surface; real Blender data stays real."""
    def __getattr__(self, name):
        value = getattr(bpy.context, name)
        if name == 'screen' and value is None:
            return SimpleNamespace(areas=[])
        return value


def load_addon(runtime):
    # append: never shadow Blender's bundled numpy with another Python ABI.
    sys.path.append(str(runtime / 'blender-python'))
    sys.path.append(str(runtime / 'sources/stablegen'))
    import addon_utils
    addon = addon_utils.enable('stablegen', default_set=True, persistent=False)
    if addon is None:
        raise RuntimeError('StableGen 后台注册失败')
    return BackgroundContext()


def meshes():
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objects:
        raise RuntimeError('没有可烘焙的网格')
    deps = bpy.context.evaluated_depsgraph_get()
    vertices = triangles = 0
    for obj in objects:
        evaluated = obj.evaluated_get(deps)
        mesh = evaluated.to_mesh()
        try:
            vertices += len(mesh.vertices)
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
        finally:
            evaluated.to_mesh_clear()
    if vertices > 2_000_000 or len(bpy.context.scene.objects) > 1500:
        raise RuntimeError('应用修改器后的场景超过现有安全上限')
    return objects, {'vertices': vertices, 'triangles': triangles}


def export_preview(job, name, objects):
    _, counts=meshes()
    if counts['triangles']>150_000:
        for obj in objects:
            reduce=obj.modifiers.new('Web preview only','DECIMATE')
            reduce.ratio=145_000/counts['triangles']
    _, preview=meshes()
    if preview['triangles']>150_000:raise RuntimeError('预览简化后仍超过 15 万三角面，保留原始 .blend')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(job/name),export_format='GLB',use_selection=True,
                             export_apply=True,export_animations=False,export_cameras=False,
                             export_lights=False,export_extras=True)
    return preview


def prepare_shape(job, glb):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    objects, counts = meshes()
    corners = [o.matrix_world @ Vector(v) for o in objects for v in o.bound_box]
    low = Vector(tuple(min(v[i] for v in corners) for i in range(3)))
    high = Vector(tuple(max(v[i] for v in corners) for i in range(3)))
    longest = max(high-low)
    if not math.isfinite(longest) or longest <= 1e-8:
        raise RuntimeError('形体范围无效')
    center = (low+high)*.5
    # Apply a single world transform; never fill open surfaces or infer dimensions.
    matrices = {obj:obj.matrix_world.copy() for obj in objects}
    for index,obj in enumerate(objects):
        matrix = matrices[obj]
        obj.name = f'Subject_{index+1:02d}'
        obj.parent = None
        matrix.translation = (matrix.translation-center)/longest
        for i in range(3):
            for j in range(3):
                matrix[i][j] /= longest
        obj.matrix_world = matrix
    scene = bpy.context.scene
    cam = bpy.data.objects.new('Reference', bpy.data.cameras.new('Reference'))
    scene.collection.objects.link(cam)
    cam.location = (0, -2.0, .25)
    cam.rotation_euler = (-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.type = 'PERSP'
    cam.data.lens = 50
    scene.camera = cam
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    scene.cycles.device = 'CPU'
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    scene.world.color = (.6,.6,.6)
    scene.view_layers[0].use_pass_z = True
    scene.use_nodes = True
    nodes = scene.node_tree.nodes
    nodes.clear()
    layer = nodes.new('CompositorNodeRLayers')
    remap = nodes.new('CompositorNodeMapRange')
    remap.inputs['From Min'].default_value = 1.4
    remap.inputs['From Max'].default_value = 2.7
    remap.inputs['To Min'].default_value = 1
    remap.inputs['To Max'].default_value = 0
    remap.use_clamp = True
    output = nodes.new('CompositorNodeComposite')
    scene.node_tree.links.new(layer.outputs['Depth'],remap.inputs['Value'])
    scene.node_tree.links.new(remap.outputs['Value'],output.inputs['Image'])
    scene.render.filepath = str(job/'depth.png')
    bpy.ops.render.render(write_still=True)
    scene.use_nodes = False
    neutral=bpy.data.materials.new('Shape inspection')
    neutral.use_nodes=True
    neutral.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.55,.57,.6,1)
    neutral.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.65
    for obj in objects:
        obj.data.materials.clear();obj.data.materials.append(neutral)
    light=bpy.data.objects.new('Inspection light',bpy.data.lights.new('Inspection light','SUN'))
    scene.collection.objects.link(light)
    light.data.energy=2
    light.rotation_euler=(math.radians(25),math.radians(-20),math.radians(-25))
    scene.cycles.samples=8
    original_camera=cam.matrix_world.copy()
    for label,angle in [('front',0),('left',math.pi/2),('back',math.pi),('right',-math.pi/2)]:
        cam.location=(2*math.sin(angle),-2*math.cos(angle),.25)
        cam.rotation_euler=(-cam.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(job/f'shape-{label}.png')
        bpy.ops.render.render(write_still=True)
    cam.matrix_world=original_camera
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(job/'geometry.blend'),check_existing=False)
    preview=export_preview(job,'shape-preview.glb',objects)
    return {'mesh':counts,'previewMesh':preview,'longestSideMeters':1,'scaleEstimated':True,
            'cameraMatched':False,'note':'阶段 A 固定相机；尚未实现照片视角匹配'}


def build_workflow(runtime, job, prompt):
    context = load_addon(runtime)
    from stablegen.workflows import WorkflowManager
    # Plain settings avoid model dropdown callbacks and UI/network timers.
    scene = SimpleNamespace(
        comfyui_prompt=prompt, comfyui_negative_prompt='text, watermark, blurry, extra objects',
        use_separate_texture_prompt=False, use_camera_prompts=False,
        seed=42, steps=8, cfg=1.0, sampler='euler', scheduler='sgm_uniform', clip_skip=1,
        model_name='sd_xl_base_1.0.safetensors', model_architecture='sdxl',
        generation_method='sequential', sequential_ipadapter=False,
        use_ipadapter=True, ipadapter_strength=.8, ipadapter_start=0., ipadapter_end=1.,
        ipadapter_weight_type='standard', render=SimpleNamespace(resolution_x=512,resolution_y=512),
        lora_units=[SimpleNamespace(model_name='sdxl_lightning_8step_lora.safetensors',model_strength=1.,clip_strength=1.)],
        controlnet_units=[SimpleNamespace(unit_type='depth',model_name='controlnet_depth_sdxl_fp16.safetensors',
                                         strength=.8,start_percent=0.,end_percent=1.,is_union=False)])
    settings = SimpleNamespace(scene=scene, preferences=context.preferences)
    manager = WorkflowManager(SimpleNamespace(_current_image=0,_cameras=[]))
    graph, ids = manager._create_base_prompt(settings)
    manager._configure_resolution(graph,settings,ids)
    manager._configure_ipadapter(graph,settings,{'name':'reference.png'},ids)
    graph = manager._build_controlnet_chain(graph,settings,{'depth':{'name':'depth.png'}},ids)
    # Lightning contains UNet adapters only. The pinned ComfyUI bypass node
    # applies their low-rank forward path without retaining patched full weights.
    # This remains an experimental compatibility probe until real inference passes.
    for key,node in list(graph.items()):
        if node['class_type']=='LoraLoader':
            clip=node['inputs'].pop('clip')
            node['inputs'].pop('strength_clip',None)
            node['class_type']='LoraLoaderBypassModelOnly'
            for consumer in graph.values():
                for name,value in list(consumer['inputs'].items()):
                    if value==[key,1]:consumer['inputs'][name]=clip
    def single(kind):
        found=[key for key,node in graph.items() if node['class_type']==kind]
        if len(found)!=1:raise RuntimeError('固定工作流节点结构已变化：'+kind)
        return found[0]
    checkpoint=single('CheckpointLoaderSimple')
    checkpoint_name=graph[checkpoint]['inputs']['ckpt_name']
    adapter=single('IPAdapter')
    adapter_loader=single('IPAdapterUnifiedLoader')
    patched_model=graph[adapter_loader]['inputs']['model']
    conditioning='forma-conditioning'
    graph[conditioning]={'class_type':'FormaConditioning','inputs':{
        'checkpoint':checkpoint_name,'clip_vision':'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
        'ipadapter':'ip-adapter-plus_sdxl_vit-h.safetensors',
        'positive':graph[ids['pos_prompt']]['inputs']['text'],
        'negative':graph[ids['neg_prompt']]['inputs']['text'],
        'image':graph[adapter]['inputs']['image']}}
    graph[checkpoint]={'class_type':'FormaDiffusionModel','inputs':{
        'checkpoint':checkpoint_name,'ready':[conditioning,4]}}
    graph[adapter_loader]={'class_type':'FormaIPModel','inputs':{
        'ipadapter':'ip-adapter-plus_sdxl_vit-h.safetensors','model':patched_model}}
    adapter_inputs=graph[adapter]['inputs']
    graph[adapter]={'class_type':'IPAdapterEmbeds','inputs':{
        'model':patched_model,'ipadapter':[adapter_loader,0],
        'pos_embed':[conditioning,2],'neg_embed':[conditioning,3],
        'weight':adapter_inputs['weight'],'weight_type':'linear','embeds_scaling':'V only',
        'start_at':adapter_inputs['start_at'],'end_at':adapter_inputs['end_at']}}
    depth=single('ControlNetLoader')
    graph[depth]={'class_type':'FormaDepthModel','inputs':{
        'controlnet':graph[depth]['inputs']['control_net_name'],'model':[adapter,0]}}
    for node in graph.values():
        if node['class_type']=='ControlNetApplyAdvanced':
            node['inputs']['positive']=[conditioning,0];node['inputs']['negative']=[conditioning,1]
            node['inputs'].pop('vae',None)  # SDXL depth ControlNet consumes pixels.
    decode=single('VAEDecode')
    graph['forma-vae']={'class_type':'FormaDecodeVAE','inputs':{
        'checkpoint':checkpoint_name,'samples':graph[decode]['inputs']['samples']}}
    graph[decode]['inputs']['vae']=['forma-vae',0]
    out = ids['save_image']
    image_input = graph[out]['inputs']['images']
    graph[out] = {'class_type':'SaveImage','inputs':{'images':image_input,'filename_prefix':'texture'}}
    # Remove unused upstream template branches, including other model routes.
    retained = {}
    def visit(key):
        if key in retained:
            return
        retained[key]=graph[key]
        for value in graph[key]['inputs'].values():
            if isinstance(value,list) and len(value)==2 and isinstance(value[0],str):
                visit(value[0])
    visit(out)
    (job/'workflow.json').write_text(json.dumps({'prompt':retained,'outputNode':out},indent=2))
    return {'nodes':len(retained),'engine':'StableGen.WorkflowManager','steps':8,'resolution':512,
            'loraApplication':'ComfyUI bypass model-only (experimental)'}


def projection_bake(runtime, job, blend, texture, atlas):
    bpy.ops.wm.open_mainfile(filepath=str(blend), load_ui=False, use_scripts=False)
    context = load_addon(runtime)
    from stablegen.texturing.projection import project_image
    from stablegen.texturing.rendering import unwrap, prepare_baking, bake_texture
    from stablegen.utils import get_file_path
    context.preferences.addons['stablegen'].preferences.output_dir = str(job / 'projection')
    scene = context.scene
    scene.output_timestamp = 'stage-a'
    scene.generation_method = 'sequential'
    scene.sequential_ipadapter = False
    scene.bake_visibility_weights = True
    scene.overwrite_material = True
    cameras = sorted([o for o in scene.objects if o.type == 'CAMERA'], key=lambda o: o.name)
    if len(cameras) != 1:
        raise RuntimeError('阶段 A 单视角探针要求且只允许一台相机')
    objects, counts = meshes()
    for index,obj in enumerate(objects):
        # Upstream uses object names as output filenames.
        if any(c in obj.name for c in ['/', '\\']) or obj.name in ['.', '..']:
            obj.name=f'Subject_{index+1:02d}'
        unwrap(obj, 'smart', False)
    destination = Path(get_file_path(context, 'generated', camera_id=0, material_id=0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(texture, destination)
    result = project_image(context, objects, 0, stop_index=0)
    if result is False or isinstance(result, Exception):
        raise RuntimeError(f'StableGen 投射失败：{result}')
    prepare_baking(context)
    # Precomputed BVH visibility uses ordinary attribute/math nodes. The
    # upstream 4.5 default unnecessarily enables OSL even on this path.
    if not any(n.type == 'SCRIPT' for o in objects for m in o.data.materials if m and m.use_nodes for n in m.node_tree.nodes):
        scene.cycles.shading_system = False
    baked = job / 'baked'
    baked.mkdir(exist_ok=True)
    for obj in objects:
        if not bake_texture(context, obj, atlas, output_dir=str(baked)):
            raise RuntimeError(f'纹理烘焙失败：{obj.name}')
        image = bpy.data.images.get(f'{obj.name}_baked')
        if image is None or not image.has_data:
            raise RuntimeError('烘焙未产生可读取的图片纹理')
        material = bpy.data.materials.new(f'{obj.name}_export')
        material.use_nodes = True
        nodes = material.node_tree.nodes
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = image
        material.node_tree.links.new(tex.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])
        image.pack()
        obj.data.materials.clear()
        obj.data.materials.append(material)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(job / 'textured.blend'), check_existing=False)
    # The master was saved before adding preview-only modifiers.
    preview_counts=export_preview(job,'textured.glb',objects)
    return {'mesh': counts, 'previewMesh':preview_counts,'atlas': atlas, 'blender': bpy.app.version_string,
            'projection': 'StableGen.project_image', 'baking': 'StableGen.bake_texture',
            'aiTextureInference': False, 'note': '投射兼容性探针，不能替代完整生成验收'}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--job', type=Path, required=True)
    p.add_argument('--mode', choices=['projection','prepare','workflow'], default='projection')
    p.add_argument('--blend', type=Path)
    p.add_argument('--texture', type=Path)
    p.add_argument('--glb', type=Path)
    p.add_argument('--prompt', default='a blue ceramic vase, realistic surface, single object')
    p.add_argument('--atlas', type=int, choices=[256, 512, 1024, 2048], default=512)
    args = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
    args.job.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    if args.mode == 'prepare':
        if not args.glb: p.error('--prepare 需要 --glb')
        result = prepare_shape(args.job.resolve(),args.glb.resolve())
    elif args.mode == 'workflow':
        result = build_workflow(args.runtime.resolve(),args.job.resolve(),args.prompt)
    else:
        if not args.blend or not args.texture: p.error('投射需要 --blend 和 --texture')
        result = projection_bake(args.runtime.resolve(), args.job.resolve(), args.blend.resolve(), args.texture.resolve(), args.atlas)
    result['seconds'] = time.monotonic() - start
    (args.job / f'{args.mode}-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f'IMAGE3D_{args.mode.upper()}_OK', json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
