import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { formatTokenCount, tokenUsageLabel } from "../src/tokenUsage";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-tokens-"));
process.env.ZAOWU_DATA_DIR = root;
process.env.ZAOWU_CODEX = path.join(root, "fake-codex");
fs.writeFileSync(process.env.ZAOWU_CODEX, `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let count=0;
rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
if(m.method==='initialize')return send({id:m.id,result:{}});
if(m.method==='config/read')return send({id:m.id,result:{config:{}}});
if(m.method==='thread/start'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:m.params.threadId||process.pid+'-'+(++count)}}});
if(m.method==='turn/start'){
 const tid=m.params.threadId;send({id:m.id,result:{turn:{id:'turn'}}});
 for(const total of [1500,1500,2900])send({method:'thread/tokenUsage/updated',params:{threadId:tid,turnId:'turn',tokenUsage:{total:{totalTokens:total,cachedInputTokens:500,reasoningOutputTokens:200},last:{totalTokens:1400}}}});
 const bad=m.params.input[0].text==='fail';
 send({method:'item/completed',params:{threadId:tid,item:{type:'agentMessage',text:JSON.stringify(m.params.outputSchema?.properties?.python?{python:'pass',summary:'测试'}:{ok:true})}}});
 send({method:'turn/completed',params:{threadId:tid,turn:{status:bad?'failed':'completed',error:bad?{message:'模拟失败'}:null}}});
}
});
`, { mode: 0o700 });
const { put, get, db } = await import("../server/store");
const { bindTokenThread, recordTokenTotal, projectTokenUsage, startTokenTracking } = await import("../server/token-usage");
const { CodexAdapter } = await import("../server/codex");
const { visualRequest } = await import("../server/visual-ai");
const start = startTokenTracking();
function project(id: string, createdAt = start) {
  const p = { id, name: id, createdAt, currentRevisionId: null, threadId: null, redo: [] };
  put("project", p);
  return p;
}
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

it("累计输入输出一次，重复/乱序/历史回填不多算，重读保留且作品隔离", () => {
  const a = project("a"), b = project("b");
  bindTokenThread(a.id, "thread-a");
  for (const n of [1200, 1200, 1100, -1, NaN, 1.5, 2200]) recordTokenTotal("thread-a", n);
  bindTokenThread(a.id, "thread-b"); recordTokenTotal("thread-b", 300);
  expect(projectTokenUsage(a)).toEqual({ totalTokens: 2500, partial: false });
  expect(projectTokenUsage(b)).toEqual({ totalTokens: 0, partial: false });
  expect(get<any>("token-usage", "thread-a").totalTokens).toBe(2200);
  expect(startTokenTracking()).toBe(start);
  expect(() => bindTokenThread(b.id, "thread-a")).toThrow("不属于");
});
it("旧作品无记录不显示零；历史补回及未知调用标明不完整", () => {
  const old = project("old", "2020-01-01T00:00:00Z");
  expect(projectTokenUsage(old)).toBeNull();
  bindTokenThread(old.id, "old-thread"); recordTokenTotal("old-thread", 12000);
  expect(projectTokenUsage(old)).toEqual({ totalTokens: 12000, partial: true });
  const newer = project("newer"); bindTokenThread(newer.id, "unknown");
  expect(projectTokenUsage(newer)).toBeNull();
  bindTokenThread(newer.id, "known"); recordTokenTotal("known", 20);
  expect(projectTokenUsage(newer)).toEqual({ totalTokens: 20, partial: true });
});
it("K/M 边界、整数、零和缺失值", () => {
  expect([0,999,1000,12500,999949,999950,1200000].map(formatTokenCount)).toEqual(["0","999","1K","12.5K","999.9K","1M","1.2M"]);
  expect(tokenUsageLabel(null)).toBe("Token 未统计");
  expect(tokenUsageLabel({ totalTokens: 12500, partial: true })).toBe("≥12.5K tokens");
});
it("普通建模与视觉请求接收真实协议形状，失败仍保留已消耗用量", async () => {
  const p = project("transport"); const adapter = new CodexAdapter();
  const signal = new AbortController().signal;
  try {
    await adapter.generate(p.id, null, "ok", signal, () => {}, () => {});
    expect(projectTokenUsage(p)?.totalTokens).toBe(2900);
    await expect(visualRequest({ projectId: p.id, cwd: root, prompt: "fail", images: [], signal, timeoutMs: 3000 })).rejects.toThrow("模拟失败");
    expect(projectTokenUsage(p)).toEqual({ totalTokens: 5800, partial: false });
  } finally { adapter.close(); }
});
