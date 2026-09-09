"""Run with Blender --background --factory-startup --python this_file.
Verifies export preparation preserves authored lighting without saving a scene.
"""
import bpy
import json
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'blender'))
from appearance import ensure_render_lighting

scene = bpy.context.scene
world = scene.world
world.use_nodes = True
background = world.node_tree.nodes.get('Background')
background.inputs['Color'].default_value = (.105, .125, .15, 1)
background.inputs['Strength'].default_value = .45
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = -.3
light = next(o for o in scene.objects if o.type == 'LIGHT')
light.data.energy = 1100
light.data.color = (1, .85, .66)
light.data.shadow_soft_size = 1.5

def snapshot():
    return (scene.world.as_pointer(), list(background.inputs['Color'].default_value),
            background.inputs['Strength'].default_value,
            [(l.from_node.name, l.from_socket.name, l.to_node.name, l.to_socket.name)
             for l in world.node_tree.links],
            [(o.name, o.data.type, o.data.energy, tuple(o.data.color), o.hide_render,
              tuple(o.matrix_world[:])) for o in scene.objects if o.type == 'LIGHT'],
            scene.view_settings.view_transform, scene.view_settings.exposure)

before = snapshot()
ensure_render_lighting(scene)
assert snapshot() == before, 'Legacy authored world or lights changed during export'
# Linked environment inputs and later edits take precedence over old metadata.
color = world.node_tree.nodes.new('ShaderNodeRGB')
world.node_tree.links.new(color.outputs[0], background.inputs['Color'])
scene['forma_lighting'] = json.dumps({'worldColor': '#ffffff', 'worldStrength': 2,
                                    'exposure': 1, 'viewTransform': 'Standard'})
before = snapshot()
ensure_render_lighting(scene)
assert snapshot() == before, 'Linked world or current color management changed'
# A scene with missing resources still gets a usable fallback, just once.
for o in list(scene.objects):
    if o.type == 'LIGHT': bpy.data.objects.remove(o, do_unlink=True)
scene.world = None
ensure_render_lighting(scene)
ensure_render_lighting(scene)
assert scene.world is not None
assert len([o for o in scene.objects if o.type == 'LIGHT']) == 1
print('FORMA_RENDER_LIGHTING_PRESERVED: legacy world, linked world, lights, color management, fallback')
