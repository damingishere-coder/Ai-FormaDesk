import fs from "node:fs";
import path from "node:path";
const materialHelpers = fs.readFileSync(
  path.resolve(import.meta.dirname, "../blender/material_controls.py"),
  "utf8",
);
import { commandSchema, type SceneCommand } from "../src/types";
export const pythonLiteral = (value: unknown) =>
  `json.loads(${JSON.stringify(JSON.stringify(value))})`;
export function sessionGuard(id: string) {
  return `import bpy, json\nif bpy.context.scene.get('forma_bridge_session') != ${JSON.stringify(id)}: raise ValueError('Blender 已切换场景，请重新打开工作台作品')\nif bpy.data.filepath != bpy.context.scene.get('forma_bridge_file'): raise ValueError('Blender 文件已切换或另存，请重新打开工作台作品')\n`;
}
export function inspectCode(id: string) {
  return (
    sessionGuard(id) +
    `\nresult=[]
for obj in bpy.context.scene.objects:
    mat=obj.active_material if hasattr(obj, 'active_material') else None
    node=mat.node_tree.nodes.get('Principled BSDF') if mat and mat.use_nodes else None
    result.append({'id':obj.get('forma_id'),'name':obj.name,'type':obj.type,'parentId':obj.parent.get('forma_id') if obj.parent else None,'transform':{'position':list(obj.location),'rotation':list(obj.rotation_euler),'scale':list(obj.scale)},'controls':json.loads(mat.get('forma_controls','null')) if mat else None,'color':list(node.inputs['Base Color'].default_value) if node else None,'roughness':node.inputs['Roughness'].default_value if node else None,'metalness':node.inputs['Metallic'].default_value if node else None})
print('FORMA_RESULT:'+json.dumps(result))`
  );
}
export function commandCode(id: string, input: SceneCommand) {
  const c = commandSchema.parse(input);
  if (!["transform", "material"].includes(c.operation))
    throw new Error(
      "Blender 联动仅支持变换和基础材质；其他操作请使用工作台 CLI",
    );
  return (
    sessionGuard(id) +
    materialHelpers +
    `\nc=${pythonLiteral(c)}
obj=next((o for o in bpy.context.scene.objects if o.get('forma_id')==c['objectId']),None)
if obj is None: raise ValueError('当前 Blender 场景找不到选中对象')
if c['operation']=='transform':
    t=c['transform']; obj.rotation_mode='XYZ'; obj.location=t['position']; obj.rotation_euler=t['rotation']; obj.scale=t['scale']
else:
    if obj.type not in ('MESH','CURVE','FONT','SURFACE','META'): raise ValueError('此对象不支持材质')
    if obj.data.users>1: obj.data=obj.data.copy()
    group=obj.active_material.get('forma_surface_group') if obj.active_material else None
    indices=[i for i,m in enumerate(obj.data.materials) if m and m.get('forma_surface_group')==group] if group else [obj.active_material_index]
    for index in indices:
        mat=obj.data.materials[index].copy() if len(obj.data.materials)>index and obj.data.materials[index] else bpy.data.materials.new('工作台材质')
        mat.use_nodes=True
        if len(obj.data.materials)>index: obj.data.materials[index]=mat
        else: obj.data.materials.append(mat)
        if next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None) is None: raise ValueError('材质不含 Principled BSDF，保留原节点不做猜测')
        adjust_material(mat,c['material'])
bpy.context.view_layer.update()
print('FORMA_RESULT:'+json.dumps({'applied':True,'objectId':c['objectId']}))`
  );
}
export function captureCode(id: string, output: string) {
  return (
    sessionGuard(id) +
    `\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(output)},check_existing=False,copy=True)\nprint('FORMA_RESULT:'+json.dumps({'saved':True}))`
  );
}
export function parseToolResult(result: any): any {
  const text = (result.content || [])
    .filter((v: any) => v.type === "text")
    .map((v: any) => v.text)
    .join("\n");
  if (
    result.isError ||
    /^Error|Error executing|Communication error|Rejected by safe mode/m.test(
      text,
    )
  )
    throw new Error(text.slice(0, 1500) || "Blender MCP 调用失败");
  const marker = text.indexOf("FORMA_RESULT:");
  if (marker < 0) throw new Error("Blender MCP 没有返回实际执行结果");
  const value = text.slice(marker + 13).split("\n")[0];
  return JSON.parse(value);
}

export function prepareCaptureCode(
  id: string,
  objects: { name: string; id?: string }[],
  newId: () => string,
) {
  const used = new Set<string>();
  const assignments = objects.flatMap((o) => {
    if (
      o.id &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        o.id,
      ) &&
      !used.has(o.id)
    ) {
      used.add(o.id);
      return [];
    }
    const next = newId();
    used.add(next);
    return [{ name: o.name, id: next }];
  });
  return (
    sessionGuard(id) +
    `
from mathutils import Matrix
for entry in ${pythonLiteral(assignments)}:
    obj=bpy.context.scene.objects.get(entry['name'])
    if obj is None: raise ValueError('同步过程中对象已变化，请重新读取场景')
    obj['forma_id']=entry['id']
for obj in bpy.context.scene.objects:
    if obj.parent and obj.matrix_parent_inverse!=Matrix.Identity(4):
        local=obj.matrix_local.copy();obj.matrix_parent_inverse=Matrix.Identity(4);obj.matrix_basis=local
    if obj.rotation_mode!='XYZ': obj.rotation_mode='XYZ'
bpy.context.view_layer.update()
print('FORMA_RESULT:{}')`
  );
}
