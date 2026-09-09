import fs from "node:fs";
import path from "node:path";
import { DATA } from "../server/config";
import { executeScene, artifact } from "../server/jobs";
import { put, uid, now, db } from "../server/store";
import { codex } from "../server/codex";
if (!process.env.ZAOWU_DATA_DIR || !DATA.includes("desktop-smoke-"))
  throw new Error("Fixture requires a dedicated desktop-smoke directory.");
const dir = path.join(DATA, "revisions", uid());
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "generated.py"),
  `import bpy, math\nfrom mathutils import Vector\ndef mat(n,c):\n m=bpy.data.materials.new(n);m.diffuse_color=(*c,1);m.use_nodes=True;m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(*c,1);m.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.42;return m\nwood=mat('温暖橡木',(.53,.30,.12));green=mat('森林绿',(.06,.25,.13));cream=mat('奶油陶瓷',(.86,.82,.69));orange=mat('陶土橙',(.72,.25,.08))\ndef box(n,loc,scale,m):\n bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=n;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m);b=o.modifiers.new('柔和边缘','BEVEL');b.width=.045;b.segments=4;o.modifiers.new('法线','WEIGHTED_NORMAL');return o\ndef cylinder(n,loc,r,d,m):\n bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=r,depth=d,location=loc);o=bpy.context.object;o.name=n;o.data.materials.append(m);b=o.modifiers.new('边缘','BEVEL');b.width=.018;b.segments=3;o.modifiers.new('法线','WEIGHTED_NORMAL');return o\nbox('橡木桌面',(0,0,1.1),(2.6,1.5,.13),wood)\nfor x in [-1.07,1.07]:\n for y in [-.52,.52]:box('桌腿',(x,y,.52),(.13,.13,1.05),wood)\ncylinder('灯座',(-.68,.22,1.21),.23,.06,green)\ncylinder('灯杆',(-.68,.22,1.60),.025,.75,green)\nbpy.ops.mesh.primitive_cone_add(vertices=64,radius1=.36,radius2=.16,depth=.28,location=(-.68,.22,2.03));o=bpy.context.object;o.name='绿色灯罩';o.data.materials.append(green)\nbox('书本一',(.49,.22,1.23),(.63,.43,.10),orange)\no=box('书本二',(.45,.20,1.33),(.59,.4,.10),cream);o.rotation_euler.z=.16\ncylinder('陶瓷杯',(.73,-.38,1.32),.12,.27,cream)\nbpy.ops.mesh.primitive_torus_add(major_radius=.087,minor_radius=.022,major_segments=32,minor_segments=12,location=(.86,-.38,1.34),rotation=(math.pi/2,0,0));bpy.context.object.name='杯把';bpy.context.object.data.materials.append(cream)\n`,
);
try {
  const scene = await executeScene(
    dir,
    "execute",
    new AbortController().signal,
    () => {},
  );
  const pid = uid(),
    rid = path.basename(dir),
    artifacts: any = {};
  for (const [key, name, mime] of [
    ["blend", "scene.blend", "application/x-blender"],
    ["glb", "scene.glb", "model/gltf-binary"],
    ["manifest", "scene.json", "application/json"],
    ["script", "generated.py", "text/x-python"],
    ["log", "execution.log", "text/plain"],
  ])
    artifacts[key] = artifact(path.join(dir, name), pid, name, mime);
  put("project", {
    id: pid,
    name: "午后工作角",
    currentRevisionId: rid,
    threadId: null,
    redo: [],
    createdAt: now(),
    updatedAt: now(),
  });
  put("revision", {
    id: rid,
    projectId: pid,
    parentId: null,
    source: "generate",
    label: "橡木桌、绿色台灯与陶瓷杯",
    createdAt: now(),
    scene,
    artifacts,
    preview: { status: "ready" },
  });
  fs.writeFileSync(
    path.join(DATA, "fixture.json"),
    JSON.stringify({ pid, rid, artifacts }),
  );
  console.log(`Desktop fixture: ${scene.objects.length} editable objects`);
} finally {
  codex.close();
  db.close();
}
