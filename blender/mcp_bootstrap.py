"""Start the pinned upstream addon in an isolated GUI Blender work copy."""
import bpy, sys, os, json, importlib.util
from types import SimpleNamespace
from pathlib import Path
config = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
folder = Path(config['dir'])
bpy.ops.wm.open_mainfile(filepath=str(folder / 'working.blend'), load_ui=False, use_scripts=False)
spec = importlib.util.spec_from_file_location('forma_blender_mcp', config['addon'])
addon = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = addon
spec.loader.exec_module(addon)
# Upstream register() auto-starts port 9876. A running sentinel suppresses that
# side effect; only our explicitly loopback-bound, dedicated socket is started.
bpy.types.blendermcp_server = SimpleNamespace(running=True)
addon.register()
scene = bpy.context.scene
scene.blendermcp_auto_start_server = False
for name in ('polyhaven', 'hyper3d', 'hunyuan3d', 'sketchfab', 'polypizza'):
    setattr(scene, 'blendermcp_use_' + name, False)
scene['forma_bridge_session'] = config['id']
scene['forma_bridge_file'] = str(folder / 'working.blend')
server = addon.BlenderMCPServer(host='127.0.0.1', port=config['port'])
bpy.types.blendermcp_server = server
server.start()
scene.blendermcp_server_running = server.running
port = server.socket.getsockname()[1] if server.socket else 0
server.port = port
scene.blendermcp_port = port
if not server.running:
    raise RuntimeError('Blender MCP 端口启动失败')
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(folder / 'working.blend'), check_existing=False)
for window in bpy.context.window_manager.windows:
    for area in window.screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.shading.type = 'SOLID'
            area.spaces.active.shading.color_type = 'MATERIAL'
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
            if region:
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.view3d.view_all(center=False)
(folder / 'ready.json').write_text(json.dumps({'port':port,'id':config['id'],'loopback':True}))
print('FORMA_MCP_READY', flush=True)
