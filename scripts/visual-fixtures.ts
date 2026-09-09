import fs from "node:fs";
import path from "node:path";
import { executeScene } from "../server/jobs";
import { runBlender } from "../server/sandbox";
import { ROOT } from "../server/config";
export const fixtures: Record<string, { prompt: string; script: string }> = {
  solid: {
    prompt:
      "根据图片建模一个绿色圆角立方体，三条边一样长，主体只有一个，没有额外图案。",
    script:
      "bpy.ops.mesh.primitive_cube_add(size=1);o=bpy.context.object;o.name='绿色方块';m=mat('绿',(0.04,.28,.15),.45);o.data.materials.append(m);b=o.modifiers.new('圆角','BEVEL');b.width=.035;b.segments=3",
  },
  wood: {
    prompt: "根据图片建模这张木桌：方形桌面，四条直桌腿，保留木质颜色和纹理。",
    script:
      "bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,.8));o=bpy.context.object;o.name='桌面';o.scale=(1,1,.1);o.data.materials.append(mat('木',(.3,.14,.05),.55))\nfor x,y in [(-.4,-.4),(-.4,.4),(.4,-.4),(.4,.4)]:\n bpy.ops.mesh.primitive_cube_add(size=1,location=(x,y,.4));o=bpy.context.object;o.name='桌腿';o.scale=(.08,.08,.8);o.data.materials.append(mat('木腿',(.3,.14,.05),.55))",
  },
  pattern: {
    prompt:
      "根据图片建模米黄色圆柱容器，侧面有两条红色水平色带，保留位置和比例，没有文字。",
    script:
      "bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=.35,depth=1);o=bpy.context.object;o.name='容器';o.data.materials.append(mat('米黄',(.72,.58,.35),.6))\nfor z in [-.32,.32]:\n bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=.352,depth=.09,location=(0,0,z));bpy.context.object.data.materials.append(mat('红',(.5,.02,.03),.6))",
  },
  metal: {
    prompt: "根据图片建模一个银色金属球体，保持球形，没有图案。",
    script:
      "bpy.ops.mesh.primitive_uv_sphere_add(segments=48,ring_count=24,radius=.5);o=bpy.context.object;o.name='银球';o.data.materials.append(mat('银',(.55,.57,.6),.23,1));\nfor p in o.data.polygons:p.use_smooth=True",
  },
  complex: {
    prompt: "根据图片建模一个蓝色环形物体，中心贯通，保留圆环厚度和比例。",
    script:
      "bpy.ops.mesh.primitive_torus_add(major_radius=.5,minor_radius=.18,major_segments=48,minor_segments=20);o=bpy.context.object;o.name='蓝环';o.data.materials.append(mat('蓝',(.03,.18,.48),.38));\nfor p in o.data.polygons:p.use_smooth=True",
  },
};

export async function ensureFixture(
  name: string,
  root: string,
  signal: AbortSignal,
) {
  const test = fixtures[name],
    source = path.join(root, name, "source");
  fs.mkdirSync(source, { recursive: true });
  if (!fs.existsSync(path.join(source, "render.png"))) {
    fs.writeFileSync(
      path.join(source, "generated.py"),
      `import bpy\ndef mat(name,color,rough,metal=0):\n m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*color,1);n.inputs['Roughness'].default_value=rough;n.inputs['Metallic'].default_value=metal;return m\n${test.script}`,
    );
    await executeScene(source, "execute", signal, () => {});
    fs.copyFileSync(
      path.join(source, "scene.blend"),
      path.join(source, "base.blend"),
    );
    fs.writeFileSync(
      path.join(source, "camera.json"),
      JSON.stringify({
        position: [2, 1.6, 2],
        target: [0, name === "wood" ? 0.45 : 0, 0],
        up: [0, 1, 0],
        fov: 36,
        aspect: 1,
        settings: { width: 512, height: 512, transparent: false },
      }),
    );
    const r = await runBlender(
      source,
      [
        "--python",
        path.join(ROOT, "blender/worker.py"),
        "--",
        "render",
        source,
      ],
      signal,
      300000,
      true,
    );
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).slice(-2000));
  }
  return path.join(source, "render.png");
}
