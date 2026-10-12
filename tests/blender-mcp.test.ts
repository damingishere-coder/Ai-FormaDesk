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
  it.each([
    "Error lamp",
    "Error executing code lamp",
    "Communication error lamp",
    "Rejected by safe mode lamp",
    "Unauthorized lamp",
    "FORMA_RESULT: lamp",
  ])("合法对象名 %s 不得被解释为工具错误", (name) => {
    const objects = [{ id, name }];
    expect(
      parseToolResult({
        content: [
          { type: "image", data: "ignored" },
          {
            type: "text",
            text: `Code executed successfully: Blender log\r\nFORMA_RESULT:${JSON.stringify(objects)}\r\n`,
          },
        ],
      }),
    ).toEqual(objects);
  });
  it.each([
    "Error executing code: broken",
    "Communication error: disconnected",
    "Rejected by safe mode: not authorized",
    "Code execution error: scene switched",
    "Unauthorized: denied",
    "Forbidden: denied",
    "Permission denied: denied",
  ])("明确错误行 %s 即使包含成功 marker 也必须拒绝", (error) => {
    expect(() =>
      parseToolResult({
        content: [{ type: "text", text: `FORMA_RESULT:{}\n  ${error}` }],
      }),
    ).toThrow(error);
    expect(() =>
      parseToolResult({
        content: [
          {
            type: "text",
            text: `Code executed successfully: ${error}\nFORMA_RESULT:{}`,
          },
        ],
      }),
    ).toThrow(error);
  });
  it("isError 优先拒绝，坏 JSON、含糊 marker 和伪回执不能成功", () => {
    expect(() =>
      parseToolResult({
        isError: true,
        content: [{ type: "text", text: 'FORMA_RESULT:{"saved":true}' }],
      }),
    ).toThrow();
    for (const text of [
      "FORMA_RESULT:",
      "FORMA_RESULT:{broken}",
      "FORMA_RESULT:```json\n{}\n```",
      "FORMA_RESULT:{} FORMA_RESULT:{}",
    ]) {
      expect(() =>
        parseToolResult({ content: [{ type: "text", text }] }),
      ).toThrow();
    }
    expect(() =>
      parseToolResult({
        content: [
          { type: "text", text: "FORMA_RESULT:{}" },
          { type: "text", text: "FORMA_RESULT:{}" },
        ],
      }),
    ).toThrow("多个执行结果");
    expect(() =>
      parseToolResult({
        content: [{ type: "text", text: "log mentions FORMA_RESULT:{}" }],
      }),
    ).toThrow("实际执行结果");
    expect(() => parseToolResult(null)).toThrow("无效响应");
    expect(() =>
      parseToolResult({ content: [{ type: "text", text: null }] }),
    ).toThrow("实际执行结果");
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
