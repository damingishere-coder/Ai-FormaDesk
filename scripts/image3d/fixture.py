"""Create an original, transparent reference object for the stage-A smoke test.

Run with trusted Blender: blender -b --factory-startup --python fixture.py -- DIR
This synthetic fixture tests the pipeline, not photographic reconstruction quality.
"""
import bpy
import math
import os
import sys
from mathutils import Vector

directory = os.path.realpath(sys.argv[sys.argv.index('--') + 1])
os.makedirs(directory, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

mat = bpy.data.materials.new('Ceramic blue')
mat.use_nodes = True
shader = mat.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value = (0.025, 0.22, 0.52, 1)
shader.inputs['Roughness'].default_value = 0.32

# A closed vase profile rotated around Z. Known geometry and color aid inspection.
profile = [(0, 0), (.32, 0), (.40, .12), (.45, .43), (.34, .75), (.19, .96), (.19, 1.12), (0, 1.12)]
verts, faces = [], []
segments = 64
for radius, z in profile:
    for i in range(segments):
        angle = i * 2 * math.pi / segments
        verts.append((radius * math.cos(angle), radius * math.sin(angle), z))
for row in range(len(profile) - 1):
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((row * segments + i, row * segments + j, (row + 1) * segments + j, (row + 1) * segments + i))
mesh = bpy.data.meshes.new('Vase mesh')
mesh.from_pydata(verts, [], faces)
mesh.update()
obj = bpy.data.objects.new('Blue vase', mesh)
bpy.context.collection.objects.link(obj)
obj.data.materials.append(mat)
for face in mesh.polygons:
    face.use_smooth = True
bevel = obj.modifiers.new('Gentle edges', 'BEVEL')
bevel.width = .025
bevel.segments = 3

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.join(directory, 'reference.png')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .4
for name, position, energy, size in [('Key', (3, -4, 5), 500, 4), ('Fill', (-3, -2, 2), 150, 3)]:
    light = bpy.data.lights.new(name, 'AREA')
    light.energy, light.shape, light.size = energy, 'DISK', size
    ob = bpy.data.objects.new(name, light)
    scene.collection.objects.link(ob)
    ob.location = position
    ob.rotation_euler = (Vector((0, 0, .5)) - ob.location).to_track_quat('-Z', 'Y').to_euler()
cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
scene.collection.objects.link(cam)
cam.location = (2, -4, 2)
cam.rotation_euler = (Vector((0, 0, .55)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 1.55
scene.camera = cam
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(directory, 'reference.blend'))
bpy.ops.render.render(write_still=True)
print('IMAGE3D_FIXTURE_OK')
