"""Shared material controls used by CLI and trusted MCP commands."""
import bpy, json

def node(mat):
    if not mat:return None
    mat.use_nodes=True
    return next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)

def rgb(value):
    vals=[int(value[i:i+2],16)/255 for i in (1,3,5)]
    return tuple(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in vals)

def adjust_material(mat, values):
    """Factors retain texture connections; baking handles portable web derivatives."""
    n=node(mat)
    origin=json.loads(mat.get('forma_adjust_origin','null'))
    if origin is None:
        controls=json.loads(mat.get('forma_controls','null'))
        origin={'color':list(rgb(controls['color'])) if controls else list(n.inputs['Base Color'].default_value)[:3], 'roughness':controls['roughness'] if controls else n.inputs['Roughness'].default_value, 'metalness':controls['metalness'] if controls else n.inputs['Metallic'].default_value}
        mat['forma_adjust_origin']=json.dumps(origin)
    for prop, key in [('Base Color','color'),('Roughness','roughness'),('Metallic','metalness')]:
        socket=n.inputs[prop]
        value=(*rgb(values[key]),1) if key=='color' else values[key]
        adjusted=tuple(v/max(origin['color'][i],1e-6) if origin['color'][i]>1e-6 else (1 if v<1e-6 else v/1e-6) for i,v in enumerate(value[:3]))+(1,) if key=='color' else value-origin[key]
        marker='Forma_Adjust_'+key
        factor=mat.node_tree.nodes.get(marker)
        if factor:
            factor.inputs[2 if key=='color' else 1].default_value=adjusted
        elif socket.is_linked:
            original=socket.links[0].from_socket
            mat.node_tree.links.remove(socket.links[0])
            if key=='color':
                factor=mat.node_tree.nodes.new('ShaderNodeMixRGB');factor.blend_type='MULTIPLY';factor.inputs[0].default_value=1
                mat.node_tree.links.new(original,factor.inputs[1]);factor.inputs[2].default_value=adjusted
            else:
                factor=mat.node_tree.nodes.new('ShaderNodeMath');factor.operation='ADD';factor.use_clamp=True
                mat.node_tree.links.new(original,factor.inputs[0]);factor.inputs[1].default_value=adjusted
            factor.name=marker;mat.node_tree.links.new(factor.outputs[0],socket)
        else:socket.default_value=value
    mat['forma_controls']=json.dumps(values)
    # Solid viewport uses these display properties rather than shader nodes.
    mat.diffuse_color=(*rgb(values['color']),1)
    mat.roughness=values['roughness']
    mat.metallic=values['metalness']
