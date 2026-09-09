import { z } from "zod";
import { materialSchema, commandSchema } from "../src/types";
import { visualRequest } from "./visual-ai";
// Structured output requires homogeneous array items; tuple schemas emit prefixItems.
const vector = z.array(z.number()).length(3);
export const editSchema = z.object({
  operation: z.enum(["transform", "material", "none"]),
  transform: z
    .object({ position: vector, rotation: vector, scale: vector })
    .nullable(),
  material: materialSchema.nullable(),
  explanation: z.string(),
});
export async function interpretBlenderEdit(
  cwd: string,
  prompt: string,
  object: unknown,
  baseRevisionId: string,
  objectId: string,
  signal: AbortSignal,
  onActivity: (message: string) => void,
) {
  const result = editSchema.parse(
    await visualRequest({
      cwd,
      prompt: `用户明确要求对选中对象做局部调整：${prompt}\n当前实际 Blender 对象：${JSON.stringify(object)}\n只支持位置、旋转、缩放和基础材质。返回绝对变换值，保留未要求变化的轴。单位米，旋转弧度。放大10%意味着当前缩放乘1.1。优先使用controls中的sRGB颜色、粗糙度和金属度作为当前值；没有controls时color为线性RGBA，需要转换成sRGB十六进制。不猜测未提供的材质参数。如果只是询问、描述不明确、需要复杂几何或其他对象，operation=none并在explanation说明。不运行脚本、不做视觉评分。`,
      images: [],
      signal,
      schema: z.toJSONSchema(editSchema),
      onActivity,
    }),
  );
  if (result.operation === "none")
    throw new Error(result.explanation || "这次请求需要通过创作方案处理");
  return commandSchema.parse({
    operation: result.operation,
    baseRevisionId,
    objectId,
    ...(result.transform ? { transform: result.transform } : {}),
    ...(result.material ? { material: result.material } : {}),
  });
}
