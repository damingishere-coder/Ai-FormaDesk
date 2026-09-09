import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
const base="http://127.0.0.1:8899";
const db=new Database(path.resolve("data/index.sqlite"),{readonly:true});
const row:any=db.prepare("SELECT body FROM documents WHERE kind='job' AND id=?").get("2dcccc72-3318-4b62-80d8-35c005629889");db.close();
if(!row)throw new Error("找不到指定对照任务");
const previous=JSON.parse(row.body);
const source=path.resolve("data/jobs/2dcccc72-3318-4b62-80d8-35c005629889/visual/original-1.png");
const session=await fetch(base+"/api/session");const cookie=session.headers.get("set-cookie")!.split(";")[0];const token=(await session.json()).token;
async function api(url:string,body?:unknown){const r=await fetch(base+"/api"+url,{method:body?"POST":"GET",headers:{cookie,"x-forma-session":token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;}
const p=await api("/projects",{name:"单轮三视图实测 · 双刀角色"});
const upload=await fetch(base+`/api/projects/${p.id}/attachments`,{method:"POST",headers:{cookie,"x-forma-session":token,"content-type":"application/octet-stream","x-file-name":encodeURIComponent("同一角色原图.png")},body:fs.readFileSync(source)});
const a=await upload.json();if(!upload.ok)throw new Error(a.error);
const job=await api(`/projects/${p.id}/generate`,{baseRevisionId:null,prompt:previous.request.prompt,attachmentIds:[a.id]});
const out=path.resolve("data/mcp-proof/single-pass-live.json");
fs.writeFileSync(out,JSON.stringify({projectId:p.id,jobId:job.id,previousJobId:previous.id},null,2));
let last="", finished=false;const started=Date.now();
while(Date.now()-started<30*60*1000){
  const j=await api(`/jobs/${job.id}`);
  if(j.stage!==last){last=j.stage;console.log(Math.round((Date.now()-started)/1000)+"s",j.stage);}
  if(["succeeded","failed","cancelled"].includes(j.status)){
    fs.writeFileSync(out,JSON.stringify({projectId:p.id,jobId:j.id,previousJobId:previous.id,elapsedSeconds:(Date.now()-started)/1000,status:j.status,error:j.error,events:j.events,visual:j.visual,resultRevisionId:j.resultRevisionId},null,2));
    if(j.status!=="succeeded")throw new Error(j.error);finished=true;console.log("SINGLE_PASS_LIVE_PASSED",j.resultRevisionId);break;
  }
  await new Promise(r=>setTimeout(r,4000));
}
if(!finished){
  await api(`/jobs/${job.id}/cancel`,{});
  const j=await api(`/jobs/${job.id}`);
  fs.writeFileSync(out,JSON.stringify({projectId:p.id,jobId:j.id,status:j.status,error:"完整实测超过30分钟，已请求取消",events:j.events,visual:j.visual},null,2));
  throw new Error("完整实测超过30分钟，已请求取消");
}
