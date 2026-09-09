import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-bridge-test-"));
process.env.ZAOWU_DATA_DIR = root;
const { BlenderBridge } = await import("../server/blender-mcp");
const id = "00000000-0000-4000-8000-000000000001",
  pid = "00000000-0000-4000-8000-000000000002",
  base = "00000000-0000-4000-8000-000000000003";
const obj = {
  id,
  name: "object",
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
};
function connected() {
  fs.mkdirSync(path.join(root, "blender-sessions", id), { recursive: true });
  fs.writeFileSync(
    path.join(root, "blender-sessions", "active.json"),
    JSON.stringify({ id, projectId: pid, baseRevisionId: base, port: 45678 }),
  );
  const bridge = new BlenderBridge();
  const s = (bridge as any).session;
  s.state = "connected";
  s.client = { close: vi.fn(async () => {}) };
  return bridge;
}
beforeEach(() => {
  fs.rmSync(path.join(root, "blender-sessions"), {
    recursive: true,
    force: true,
  });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
describe("Blender 连接恢复与任务互斥", () => {
  it("修改执行结果不确定时拒绝重放，原基准版本保持不变", async () => {
    const bridge = connected();
    const execute = vi
      .spyOn(bridge as any, "execute")
      .mockImplementation(async (_s: any, code: any) => {
        if (code.includes("c=json.loads")) throw new Error("连接中断");
        return [obj];
      });
    const dir = path.join(root, "job-failed");
    fs.mkdirSync(dir);
    await expect(
      bridge.capture(pid, base, dir, new AbortController().signal, {
        baseRevisionId: base,
        objectId: id,
        operation: "transform",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1.1, 1.1, 1.1],
        },
      }),
    ).rejects.toThrow("连接中断");
    const count = execute.mock.calls.length;
    await expect(
      bridge.capture(pid, base, dir, new AbortController().signal),
    ).rejects.toThrow("重新连接");
    expect(execute).toHaveBeenCalledTimes(count);
    expect(bridge.status().baseRevisionId).toBe(base);
  });
  it("两个读取请求串行执行，避免与一次操作交错", async () => {
    const bridge = connected();
    let active = 0,
      peak = 0;
    vi.spyOn(bridge as any, "execute").mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return [obj];
    });
    await Promise.all([bridge.inspect(pid), bridge.inspect(pid)]);
    expect(peak).toBe(1);
  });
  it("断开后保留可恢复窗口，恢复不创建新的工作副本", async () => {
    const bridge = connected();
    await bridge.disconnect(pid);
    expect(bridge.status().state).toBe("closed");
    expect(bridge.status().recoverable?.map((s) => s.id)).toEqual([id]);
    vi.spyOn(bridge as any, "connect").mockImplementation(async (s: any) => {
      s.state = "connected";
    });
    await bridge.recover(pid, id);
    expect(bridge.status().sessionId).toBe(id);
    expect(bridge.status().connected).toBe(true);
    expect(bridge.status().recoverable).toHaveLength(0);
    const restarted = new BlenderBridge();
    expect(restarted.status().sessionId).toBe(id);
    expect(restarted.status().state).toBe("disconnected");
  });
  it("并发打开只有一次启动，版本不同的命令被拒绝", async () => {
    const bridge = new BlenderBridge();
    const start = vi
      .spyOn(bridge as any, "openSession")
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return bridge.status();
      });
    const first = bridge.open(pid, base, "unused");
    await expect(bridge.open(pid, base, "unused")).rejects.toThrow("正在启动");
    await first;
    expect(start).toHaveBeenCalledTimes(1);
    expect(() => connected().assertReady(pid, "other-version")).toThrow(
      "版本不同",
    );
  });
});
