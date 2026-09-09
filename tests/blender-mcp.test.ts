import { describe, it, expect } from "vitest";
import {
  captureCode,
  commandCode,
  inspectCode,
  parseToolResult,
  prepareCaptureCode,
} from "../server/blender-mcp-code";
import { editSchema } from "../server/blender-edit";
import { z } from "zod";
const id = "00000000-0000-4000-8000-000000000001";
const base = "00000000-0000-4000-8000-000000000002";
describe("Blender MCP 受限调用", () => {
  it("自然语言输出的向量使用接口接受的数组格式，仍要求三个数值", () => {
    const schema: any = z.toJSONSchema(editSchema);
    const position = schema.properties.transform.anyOf[0].properties.position;
    expect(position.items).toEqual({ type: "number" });
    expect(position.prefixItems).toBeUndefined();
    expect(
      editSchema.safeParse({
        operation: "transform",
        transform: { position: [0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material: null,
        explanation: "",
      }).success,
    ).toBe(false);
  });
  it("只接受稳定ID和有限操作，拒绝任意操作与非法变换", () => {
    const common = { baseRevisionId: base, objectId: id };
    expect(() =>
      commandCode("session", { ...common, operation: "delete" }),
    ).toThrow("仅支持");
    expect(() =>
      commandCode("session", {
        ...common,
        operation: "transform",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [0, 1, 1],
        },
      }),
    ).toThrow();
    const code = commandCode("session", {
      ...common,
      operation: "transform",
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1.1, 1.1, 1.1],
      },
    });
    expect(code).toContain("forma_bridge_session");
    expect(code).toContain("forma_id");
    expect(code).not.toContain("select_all");
  });
  it("工具错误与没有真实执行回执的文本不得算成功", () => {
    expect(
      parseToolResult({
        content: [
          {
            type: "text",
            text: 'Code executed successfully: FORMA_RESULT:{"saved":true}\n',
          },
        ],
      }),
    ).toEqual({ saved: true });
    expect(() =>
      parseToolResult({
        content: [{ type: "text", text: "Error executing code: broken" }],
      }),
    ).toThrow();
    expect(() =>
      parseToolResult({ content: [{ type: "text", text: "saved" }] }),
    ).toThrow("实际执行结果");
    expect(() =>
      parseToolResult({
        isError: true,
        content: [{ type: "text", text: "FORMA_RESULT:{}" }],
      }),
    ).toThrow();
  });
  it("手工新增与重复ID分配新ID，原有有效ID不变", () => {
    let n = 0;
    const code = prepareCaptureCode(
      "session",
      [{ name: "old", id }, { name: "new" }, { name: "duplicate", id }],
      () => `new-${++n}`,
    );
    expect(n).toBe(2);
    expect(code).toContain("duplicate");
    expect(code).not.toContain('\\"name\\":\\"old\\"');
  });
  it("保存使用工作目录并保留Blender正在编辑的原文件路径", () => {
    expect(captureCode("session", "/tmp/a'quote/raw.blend")).toContain(
      "copy=True",
    );
    expect(inspectCode("session")).toContain("parentId");
  });
});
