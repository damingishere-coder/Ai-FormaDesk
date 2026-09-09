import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-transport-"));
process.env.ZAOWU_DATA_DIR = root;
process.env.ZAOWU_CODEX = path.join(root, "fake-codex");
fs.writeFileSync(
  process.env.ZAOWU_CODEX,
  `#!${process.execPath}
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
fs.appendFileSync(${JSON.stringify(path.join(root, "spawns"))},'spawn\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
if(m.method==='initialize')return send({id:m.id,result:{}});
if(m.method==='config/read')return send({id:m.id,result:{config:{mcp_servers:{}}}});
if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'test'}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});
if(m.params.input[0].text==='hang')return;
send({method:'item/completed',params:{threadId:'test',item:{type:'agentMessage',text:'{"ok":true}'}}});
send({method:'turn/completed',params:{threadId:'test',turn:{status:'completed'}}});}
});
`,
  { mode: 0o700 },
);
const { createVisualScope, visualRequest } =
  await import("../server/visual-ai");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
describe("任务内视觉连接复用", () => {
  it("同一任务JSON请求复用进程，关闭后无登记残留", async () => {
    const scope = createVisualScope();
    const request = {
      cwd: root,
      prompt: "ok",
      images: [],
      signal: new AbortController().signal,
      timeoutMs: 3000,
    };
    try {
      expect(await scope.request(request)).toEqual({ ok: true });
      expect(await scope.request(request)).toEqual({ ok: true });
      expect(
        fs.readFileSync(path.join(root, "spawns"), "utf8").trim().split("\n"),
      ).toHaveLength(1);
    } finally {
      await scope.close();
    }
    expect(fs.readdirSync(path.join(root, "runtime-processes"))).toEqual([]);
  });
  it("取消与超时清理进程，下一次独立调用可以恢复", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 80);
    await expect(
      visualRequest({
        cwd: root,
        prompt: "hang",
        images: [],
        signal: ctrl.signal,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow("取消");
    await expect(
      visualRequest({
        cwd: root,
        prompt: "hang",
        images: [],
        signal: new AbortController().signal,
        timeoutMs: 80,
      }),
    ).rejects.toThrow("时限");
    expect(fs.readdirSync(path.join(root, "runtime-processes"))).toEqual([]);
  });
});
