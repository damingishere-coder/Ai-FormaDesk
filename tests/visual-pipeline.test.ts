import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-pipeline-test-"));
process.env.ZAOWU_DATA_DIR = root;
const call = vi.hoisted(() => vi.fn());
const blender = vi.hoisted(() => vi.fn());
vi.mock("../server/visual-ai", () => ({ createVisualScope: () => ({request:call,close:async()=>{}}) }));
vi.mock("../server/sandbox", () => ({ runBlender: blender }));
const { runVisualPipeline } = await import("../server/visual-pipeline");
const { referenceViews } = await import("../src/visualTypes");
const id = "00000000-0000-4000-8000-000000000001";
const empty: any = {objects:[],stats:{objects:0,vertices:0,triangles:0},units:"meters",coordinates:"blender-z-up"};
const scene: any = {...empty,objects:[{id,type:"MESH",parentId:null}]};
const png = await sharp({create:{width:128,height:128,channels:3,background:"#fff"}}).png().toBuffer();
const subject = {clear:true,question:"",subject:"盒子",parts:["盒体"],proportions:"方形",materials:"绿色",assumptions:["深度推测"]};
const surface = {lighting:{viewTransform:"Standard",exposure:0,worldStrength:.25,key:1,fill:1,rim:1},objects:[{id,kind:"solid",color:"#00ff00",roughness:.5,metalness:0,description:"纯色"}]};
afterAll(() => fs.rmSync(root,{recursive:true,force:true}));
beforeEach(() => {
  call.mockReset(); blender.mockReset();
  blender.mockResolvedValue({code:0,stdout:"ok",stderr:""});
  call.mockImplementation(async (r:any) => {
    if(r.signal.aborted)throw new Error("任务已取消");
    if(r.imageOutput){fs.writeFileSync(r.imageOutput,png);return {path:r.imageOutput,width:128,height:128,toolCallId:"native-test"};}
    if(r.prompt.includes("识别需要建模"))return subject;
    if(r.prompt.includes("材质计划"))return surface;
    throw new Error("不应调用视觉检查："+r.prompt);
  });
});
function options(name:string){
  const dir=path.join(root,name);fs.mkdirSync(dir);const input=path.join(dir,"input.png");fs.writeFileSync(input,png);
  const makeFiles=(d:string)=>{for(const [n,v] of Object.entries({"scene.json":JSON.stringify(scene),"scene.blend":"blend","scene.glb":"glb","execution.log":"ok"}))fs.writeFileSync(path.join(d,n),v);};
  return {runId:name,root:dir,prompt:"按图建模",images:[input],baseScene:empty,signal:new AbortController().signal,onState:vi.fn(),onStage:vi.fn(),register:(f:string)=>f,
    generate:vi.fn().mockResolvedValue({python:"# generated",summary:"脚本"}),
    execute:vi.fn(async(d:string)=>{makeFiles(d);return scene;}),validate:vi.fn(async(d:string)=>{makeFiles(d);return scene;})};
}
describe("单轮三视图与无视觉评分流程",()=>{
  it("三张图、一次建模和材质规划后直接完成，纯色不渲染评分图",async()=>{
    const o=options("one-pass");const result=await runVisualPipeline(o);
    expect(result.summary).toContain("模型已生成");
    expect(o.generate).toHaveBeenCalledTimes(1);expect(o.execute).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.filter(([r])=>r.imageOutput)).toHaveLength(3);
    expect(call).toHaveBeenCalledTimes(5); // subject + three images + material plan; zero reviews
    expect(result.state.reviews).toEqual([]);
    expect(blender.mock.calls.some(([,args])=>args.includes("render"))).toBe(false);
    expect(result.state.pipelineVersion).toBe(2);
    expect(result.state.steps?.every(step=>step.endedAt)).toBe(true);
    const count=call.mock.calls.length;await runVisualPipeline(o);expect(call).toHaveBeenCalledTimes(count);
  });
  it("正面先完成，另外两张最大并发二，全部结束后才生成脚本",async()=>{
    const o=options("concurrent");const original=call.getMockImplementation()!;
    let active=0,peak=0,frontDone=false;
    call.mockImplementation(async(r:any)=>{
      if(!r.imageOutput)return original(r);
      const front=r.imageOutput.endsWith("front.png");if(!front)expect(frontDone).toBe(true);
      active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));
      const v=await original(r);active--;if(front)frontDone=true;return v;
    });
    o.generate.mockImplementation(async()=>{expect(active).toBe(0);return {python:"pass",summary:""};});
    await runVisualPipeline(o);expect(peak).toBe(2);
  });
  it("失败不自动修复；主动重试只补缺失视角",async()=>{
    const o=options("resume");const original=call.getMockImplementation()!;let fail=true;
    call.mockImplementation(async(r:any)=>{if(fail&&r.imageOutput?.endsWith("right.png"))throw new Error("生成失败");return original(r);});
    await expect(runVisualPipeline(o)).rejects.toThrow("生成失败");expect(o.generate).not.toHaveBeenCalled();
    const before=call.mock.calls.filter(([r])=>r.imageOutput).length;fail=false;
    await runVisualPipeline(o);
    expect(call.mock.calls.filter(([r])=>r.imageOutput)).toHaveLength(before+1);
    const calls=call.mock.calls.length;
    await expect(runVisualPipeline({...o,prompt:"换个主体"})).rejects.toThrow("参考或场景已变化");expect(call).toHaveBeenCalledTimes(calls);
  });
  it("脚本异常不自动重新生成，保留候选脚本",async()=>{
    const o=options("script-failure");o.execute.mockRejectedValue(new Error("Python 报错"));
    await expect(runVisualPipeline(o)).rejects.toThrow("Python 报错");expect(o.generate).toHaveBeenCalledTimes(1);expect(o.execute).toHaveBeenCalledTimes(1);
    const state=JSON.parse(fs.readFileSync(path.join(o.root,"pipeline.json"),"utf8"));expect(fs.existsSync(path.join(state.shapeDraft.dir,"generated.py"))).toBe(true);
  });
  it("旧评分失败的完整参考仍可复用，历史报告不阻止继续",async()=>{
    const o=options("legacy");o.generate.mockRejectedValueOnce(new Error("pause"));await expect(runVisualPipeline(o)).rejects.toThrow("pause");
    const p=path.join(o.root,"pipeline.json"),state=JSON.parse(fs.readFileSync(p,"utf8"));delete state.version;delete state.referenceViewNames;state.viewsApproved=false;state.rounds={views:3};state.visible.reviews=[{phase:"三视图",round:2,result:{acceptable:false,shapeIssues:["不像"],textureIssues:[],lightingIssues:[],repair:"重画"}}];fs.writeFileSync(p,JSON.stringify(state));
    const before=call.mock.calls.filter(([r])=>r.imageOutput).length;const result=await runVisualPipeline(o);
    expect(call.mock.calls.filter(([r])=>r.imageOutput)).toHaveLength(before);expect(result.state.reviews).toHaveLength(1);
  });
  it("主体不明确或已取消时不出图",async()=>{
    const o=options("ambiguous");call.mockResolvedValue({...subject,clear:false,question:"桌子还是椅子？"});await expect(runVisualPipeline(o)).rejects.toThrow("桌子还是椅子");expect(call).toHaveBeenCalledTimes(1);
    const ctrl=new AbortController();ctrl.abort();await expect(runVisualPipeline({...options("cancelled"),signal:ctrl.signal})).rejects.toThrow("取消");
  });
  it("明确背面参考时使用背面，默认仍为正右顶",()=>{
    expect(referenceViews("执行正面、侧面、背面三视图检查")).toEqual(["front","right","back"]);
    expect(referenceViews("普通盒子")).toEqual(["front","right","top"]);
  });
});
