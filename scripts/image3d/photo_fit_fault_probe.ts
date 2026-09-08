import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runBlender } from "../../server/sandbox";

if (!process.env.ZAOWU_DATA_DIR || !process.argv[2]) throw new Error("需要隔离证据目录");
const output=path.resolve(process.argv[2]);fs.mkdirSync(output,{recursive:false});
const results: unknown[]=[];
const make=(name:string)=>{const dir=path.join(output,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,"probe.py"),
  "from pathlib import Path\nimport time\nPath('started.txt').write_text('started')\ntime.sleep(60)\n");return dir;};
for(const mode of ["memory","timeout","cancel"]){
  const dir=make(mode), controller=new AbortController();
  const interval=mode==="cancel"?setInterval(()=>{if(fs.existsSync(path.join(dir,"started.txt")))controller.abort();},100):undefined;
  let error="",code:number|undefined;
  try {
    const result=await runBlender(dir,["--python",path.join(dir,"probe.py")],controller.signal,
      mode==="timeout"?2500:20000,false,{maxFootprintMb:mode==="memory"?1:12288});
    code=result.code;fs.writeFileSync(path.join(dir,"execution.log"),result.stdout+result.stderr);
  } catch(e){error=e instanceof Error?e.message:String(e);}
  finally {clearInterval(interval);}
  if(mode==="memory"){
    assert.notEqual(code,0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"memory.json"),"utf8")).limitExceeded,true);
  }else if(mode==="timeout") assert.match(error,/超时/);
  else {assert.match(error,/取消/);assert.ok(fs.existsSync(path.join(dir,"started.txt")));}
  results.push({mode,code,error,passed:true});
}
// Each terminated job must release the shared inference lease.
const final=path.join(output,"recovery");fs.mkdirSync(final);
const result=await runBlender(final,["--version"],undefined,10000,false,{maxFootprintMb:12288});
assert.equal(result.code,0);
fs.writeFileSync(path.join(output,"faults.json"),JSON.stringify({passed:true,results,leaseRecovered:true},null,2));
console.log("PHOTO_FIT_FAULTS_OK");
