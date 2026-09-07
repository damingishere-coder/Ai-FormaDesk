/** Real Blender UV stretch regressions; no synthetic inference result. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ROOT } from "../../server/config";
import { runBlender } from "../../server/sandbox";
if (!process.env.ZAOWU_DATA_DIR || !process.argv[2])
  throw new Error("Need isolated output");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: false });
const script = `import bpy,json,runpy
from pathlib import Path
directory=Path(${JSON.stringify(output)})
audit=runpy.run_path(${JSON.stringify(path.join(ROOT, "blender/texture_audit.py"))})['audit']
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_plane_add(size=2);obj=bpy.context.object;obj['forma_id']='fixture-mesh'
image=bpy.data.images.new('Texture',8,8);image.generated_color=(.5,.3,.2,1);image.pack()
material=bpy.data.materials.new('Texture');material.use_nodes=True
node=material.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
material.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);obj.data.materials.append(material)
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(directory/'base.blend'),check_existing=False)
checks=[]
for case,scale,remove in [('uniform',(3,3,3),False),('stretch',(5,1,1),False),('missing-texture',(1,1,1),True)]:
 bpy.ops.wm.open_mainfile(filepath=str(directory/'base.blend'),load_ui=False,use_scripts=False)
 obj=next(o for o in bpy.context.scene.objects if o.get('forma_id')=='fixture-mesh');obj.scale=scale
 if remove:obj.data.materials.clear()
 bpy.ops.wm.save_as_mainfile(filepath=str(directory/'scene.blend'),check_existing=False)
 error=None
 try:audit(directory,'fixture-mesh')
 except ValueError as e:error=str(e)
 assert (error is None)==(case=='uniform'),(case,error)
 checks.append({'case':case,'rejected':error is not None,'error':error,'report':json.loads((directory/'texture-audit.json').read_text())})
(directory/'audit-probe.json').write_text(json.dumps({'passed':True,'checks':checks},ensure_ascii=False,indent=2))
print('TEXTURE_AUDIT_PROBE_OK')
`;
const file = path.join(output, "fixture.py");
fs.writeFileSync(file, script);
const result = await runBlender(
  output,
  ["--python", file],
  new AbortController().signal,
  120000,
);
fs.writeFileSync(
  path.join(output, "execution.log"),
  result.stdout + result.stderr,
);
assert.equal(result.code, 0, result.stderr.slice(-3000));
assert.equal(
  JSON.parse(fs.readFileSync(path.join(output, "audit-probe.json"), "utf8"))
    .passed,
  true,
);
console.log("TEXTURE_AUDIT_PROBE_OK");
