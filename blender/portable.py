"""Preview derivatives only: native glTF channels first, selective baking second."""
import bpy
import hashlib
import json
import os
import time
import uuid

CHANNELS = ('Base Color', 'Roughness', 'Metallic', 'Normal', 'Emission Color', 'Alpha')

def native_image(node):
    if node.type != 'TEX_IMAGE' or not node.image:
        return False
    socket = node.inputs['Vector']
    if not socket.is_linked:
        return True
    link = socket.links[0]
    source = link.from_node
    if source.type == 'MAPPING':
        if not source.inputs['Vector'].is_linked:
            return False
        link = source.inputs['Vector'].links[0]
        source = link.from_node
    return source.type == 'UVMAP' or (source.type == 'TEX_COORD' and link.from_socket.name == 'UV')

def principled(mat):
    if not mat or not mat.use_nodes:
        return None
    output = next((n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    if not output or not output.inputs['Surface'].is_linked:
        return None
    shader = output.inputs['Surface'].links[0].from_node
    return shader if shader.type == 'BSDF_PRINCIPLED' else None

def native_channel(socket, channel):
    if not socket.is_linked:
        return True
    link = socket.links[0]
    node = link.from_node
    if channel == 'Normal':
        return (node.type == 'NORMAL_MAP' and node.space == 'TANGENT'
                and node.inputs['Color'].is_linked
                and native_image(node.inputs['Color'].links[0].from_node))
    if channel in ('Metallic', 'Roughness'):
        expected = 'Blue' if channel == 'Metallic' else 'Green'
        return (node.type in ('SEPARATE_COLOR', 'SEPRGB')
                and link.from_socket.name in (expected, expected[0])
                and node.inputs[0].is_linked
                and native_image(node.inputs[0].links[0].from_node))
    return native_image(node)

def required_channels(obj):
    needed = set()
    for mat in obj.data.materials:
        shader = principled(mat)
        if shader:
            needed.update(c for c in CHANNELS if not native_channel(shader.inputs[c], c))
    return [c for c in CHANNELS if c in needed]

def atomic_json(file, value):
    with open(file + '.tmp', 'w', encoding='utf8') as stream:
        json.dump(value, stream, ensure_ascii=False)
    os.replace(file + '.tmp', file)

def portable_materials(objects, directory, quality='detail', size=1024, source_hash='', budget=120):
    """Cache is scoped to exact packed source bytes, Blender and converter versions.

    This deliberately does not reuse maps just because materials look identical:
    procedural coordinates, geometry, UVs and object transforms can affect a bake.
    """
    os.makedirs(directory, exist_ok=True)
    started = time.monotonic()
    # Without a packed source identity, cross-run reuse is unsafe.
    source_hash = source_hash or str(uuid.uuid4())
    version = hashlib.sha256(open(__file__, 'rb').read()).hexdigest()
    report = {'quality': quality, 'pendingObjects': 0, 'baked': 0, 'cached': 0,
              'objects': [], 'complete': False}
    meshes = [o for o in objects if o.type == 'MESH' and len(o.data.polygons)]
    largest = max((max(o.dimensions) for o in meshes), default=1)
    report_file = os.path.join(directory, 'report.json')
    def progress():
        report['seconds'] = round(time.monotonic() - started, 3)
        atomic_json(report_file, report)
        print('FORMA_PREVIEW ' + json.dumps(report, ensure_ascii=False), flush=True)
    for obj in meshes:
        channels = required_channels(obj)
        if not channels:
            continue
        resolution = min(size, 512) if max(obj.dimensions) < largest * .15 else size
        entry = {'id': str(obj.get('forma_id')), 'name': obj.name, 'channels': channels, 'size': resolution}
        report['objects'].append(entry)
        report['pendingObjects'] += 1
        if quality == 'basic':
            # Only derivative materials are simplified. The editable file is already saved.
            for slot in obj.material_slots:
                if not slot.material:
                    continue
                slot.material = slot.material.copy()
                shader = principled(slot.material)
                if shader:
                    for channel in channels:
                        socket = shader.inputs[channel]
                        if not native_channel(socket, channel):
                            for link in list(socket.links):
                                slot.material.node_tree.links.remove(link)
            continue
        if time.monotonic() - started > budget:
            progress()
            raise RuntimeError('细节预览达到处理时间预算，已完成贴图保留，可继续生成')
        obj.data = obj.data.copy()
        source_uv = obj.data.uv_layers.active.name if obj.data.uv_layers.active else None
        for slot in obj.material_slots:
            if not slot.material:
                continue
            slot.material = slot.material.copy()
            # Preserve original image-coordinate meaning when introducing a bake UV.
            if source_uv and slot.material.use_nodes:
                tree = slot.material.node_tree
                for tex in list(tree.nodes):
                    if tex.type == 'TEX_IMAGE' and not tex.inputs['Vector'].is_linked:
                        uv_node = tree.nodes.new('ShaderNodeUVMap')
                        uv_node.uv_map = source_uv
                        tree.links.new(uv_node.outputs[0], tex.inputs['Vector'])
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        uv = obj.data.uv_layers.get('FormaBake') or obj.data.uv_layers.new(name='FormaBake')
        obj.data.uv_layers.active = uv
        uv.active_render = True
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(island_margin=.025)
        bpy.ops.object.mode_set(mode='OBJECT')
        images = {}
        for channel in channels:
            key = hashlib.sha256(json.dumps([source_hash, bpy.app.version_string, version,
                                             entry['id'], channel, resolution]).encode()).hexdigest()
            target = os.path.join(directory, key + '.png')
            if os.path.isfile(target) and os.path.isfile(target + '.done'):
                image = bpy.data.images.load(target, check_existing=False)
                report['cached'] += 1
            else:
                if time.monotonic() - started > budget:
                    progress()
                    raise RuntimeError('细节预览达到处理时间预算，已完成贴图保留，可继续生成')
                image = bpy.data.images.new('预览·' + obj.name + '·' + channel, width=resolution, height=resolution, alpha=False)
                if channel not in ('Base Color', 'Emission Color'):
                    image.colorspace_settings.name = 'Non-Color'
                altered = []
                for slot in obj.material_slots:
                    mat = slot.material
                    shader = principled(mat)
                    if not shader:
                        continue
                    tree = mat.node_tree
                    output = next(n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
                    original = output.inputs['Surface'].links[0].from_socket
                    texture = tree.nodes.new('ShaderNodeTexImage')
                    texture.image = image
                    tree.nodes.active = texture
                    emission = None
                    if channel != 'Normal':
                        emission = tree.nodes.new('ShaderNodeEmission')
                        socket = shader.inputs[channel]
                        if socket.is_linked:
                            tree.links.new(socket.links[0].from_socket, emission.inputs['Color'])
                        else:
                            value = socket.default_value
                            emission.inputs['Color'].default_value = value if channel in ('Base Color', 'Emission Color') else (value, value, value, 1)
                        tree.links.new(emission.outputs[0], output.inputs['Surface'])
                    altered.append((tree, output, original, texture, emission))
                scene = bpy.context.scene
                scene.render.engine = 'CYCLES'
                scene.cycles.device = 'CPU'
                scene.cycles.samples = 1
                scene.render.bake.use_clear = True
                scene.render.bake.margin = 12
                bpy.ops.object.bake(type='NORMAL' if channel == 'Normal' else 'EMIT')
                image.filepath_raw = target
                image.file_format = 'PNG'
                image.save()
                with open(target + '.done', 'w') as marker:
                    marker.write(key)
                for tree, output, original, texture, emission in altered:
                    tree.links.new(original, output.inputs['Surface'])
                    tree.nodes.remove(texture)
                    if emission:
                        tree.nodes.remove(emission)
                report['baked'] += 1
            if channel not in ('Base Color', 'Emission Color'):
                image.colorspace_settings.name = 'Non-Color'
            image.pack()
            images[channel] = image
            progress()
        # Keep each material slot and all untouched channels, including emission.
        for slot in obj.material_slots:
            mat = slot.material
            shader = principled(mat)
            if not shader:
                continue
            tree = mat.node_tree
            for channel, image in images.items():
                tex = tree.nodes.new('ShaderNodeTexImage')
                tex.image = image
                coords = tree.nodes.new('ShaderNodeUVMap')
                coords.uv_map = 'FormaBake'
                tree.links.new(coords.outputs[0], tex.inputs['Vector'])
                output = tex.outputs['Color']
                if channel == 'Normal':
                    normal = tree.nodes.new('ShaderNodeNormalMap')
                    normal.uv_map = 'FormaBake'
                    tree.links.new(output, normal.inputs['Color'])
                    output = normal.outputs[0]
                tree.links.new(output, shader.inputs[channel])
        report['pendingObjects'] -= 1
        progress()
    report['complete'] = quality == 'detail' or not report['pendingObjects']
    progress()
    return report
