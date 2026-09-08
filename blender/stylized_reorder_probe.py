import sys,json
from pathlib import Path
import bpy
sys.path.insert(0,str(Path(__file__).resolve().parent))
import photo_fit_worker as w
folder=Path(sys.argv[sys.argv.index('--')+1]);a=bpy.data.meshes.new('a');verts=[(0,0,0),(1,0,0),(1,1,0),(0,1,0)];a.from_pydata(verts,[],[(0,1,2),(0,2,3)]);a.update();uv=a.uv_layers.new()
for loop in a.loops:uv.data[loop.index].uv=verts[loop.vertex_index][:2]
b=bpy.data.meshes.new('b');b.from_pydata(verts,[],[(2,3,0),(1,2,0)]);b.update();uv=b.uv_layers.new()
for loop in b.loops:uv.data[loop.index].uv=verts[loop.vertex_index][:2]
assert [tuple(p.vertices) for p in a.polygons]!=[tuple(p.vertices) for p in b.polygons]
assert w.canonical_faces(a)==w.canonical_faces(b)
assert w.canonical_faces(a,True)==w.canonical_faces(b,True)
uv.data[0].uv.x+=.1
assert w.canonical_faces(a,True)!=w.canonical_faces(b,True)
(folder/'reorder.json').write_text(json.dumps({'passed':True,'faceOrderIgnored':True,'cornerUvChangeRejected':True},indent=2))
