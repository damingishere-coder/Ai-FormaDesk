"""Small optional helpers available to generated scripts as `forma`."""
import bpy

def material(name, color, roughness=0.5, metalness=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get('Principled BSDF')
    rgba = tuple(color) if len(color) == 4 else (*color, 1)
    node.inputs['Base Color'].default_value = rgba
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Metallic'].default_value = metalness
    mat.diffuse_color = rgba
    return mat

def finish(obj, mat=None, bevel=0.0, smooth=True):
    if mat is not None: obj.data.materials.append(mat)
    if bevel > 0:
        modifier = obj.modifiers.new('倒角', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 2
    if smooth and obj.type == 'MESH':
        for face in obj.data.polygons: face.use_smooth = True
    return obj

def group(name, objects):
    parent = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(parent)
    for obj in objects:
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world
    return parent
