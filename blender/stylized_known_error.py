"""Known width error, separate from subjective real-photo acceptance."""
import sys,json
from pathlib import Path
import bpy
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
import photo_fit_worker as w
import stylized_geometry as sty
folder=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
body=sty.rounded_box('body',(0,0,.4),(1,.4,.8),.06)
other=sty.ellipsoid('badge',(0,-.22,.4),(.04,.025,.04))
camera=w.setup([body,other]);camera.location=(0,-3,.4);camera.rotation_euler=(Vector((0,0,.4))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.lens=55
bpy.context.view_layer.update();fixed=w.camera_record(camera)
if not (folder/'proposal.json').is_file():
 w.render(folder,'reference.png');body.scale.x=.86;bpy.context.view_layer.update();w.render(folder,'wrong.png')
 w.write(folder,'baseline.json',{'camera':fixed,'objects':w.inventory([body,other]),'wrong':.86,'target':1.0})
else:
 x=json.loads((folder/'proposal.json').read_text());changes=x['parameters']
 assert len(changes)==1 and changes[0]['name']=='width'
 width=changes[0]['value'];assert .85<=width<=1.15
 baseline=json.loads((folder/'baseline.json').read_text())
 before=w.inventory([other]);body.scale.x=width;bpy.context.view_layer.update();w.render(folder,'corrected.png');after=w.inventory([other])
 assert before==after
 assert abs(width-1)<abs(.86-1)-.03
 w.write(folder,'known-error.json',{'passed':True,'beforeWidthError':.14,'afterWidthError':abs(width-1),'proposal':x,'nonTargetUnchanged':True})
 bpy.ops.wm.save_as_mainfile(filepath=str(folder/'corrected.blend'))
