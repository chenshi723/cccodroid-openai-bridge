#!/usr/bin/env node
'use strict';
// Opt-in integration: candidate gateway + installed CLI, disposable HOME and fake loopback upstream only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const app=process.env.OPENAI_BRIDGE_APP_SOURCE;
if(!app||!process.env.CCAPP_CLAUDE||!process.env.CCAPP_LOADER)throw new Error('Set OPENAI_BRIDGE_APP_SOURCE and installed CLI/loader paths; integration is opt-in.');
const kit=process.env.OPENAI_BRIDGE_TEST_SOURCE?path.resolve(process.env.OPENAI_BRIDGE_TEST_SOURCE):path.resolve(__dirname,'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-app-contract-'));
const home=path.join(root,'home'),workspace=path.join(root,'workspace'),prefix=path.join(root,'usr');
for(const d of [home,workspace,path.join(prefix,'bin'),path.join(prefix,'lib')])fs.mkdirSync(d,{recursive:true});
// A disposable prefix owns the test component. Tool binaries are read-only links to the real toolchain.
for(const n of ['node','bash','sh','flock','timeout','setsid','readlink','tee','base64','date','sleep','mv','rm','dirname','curl','cat','git','env','head','tr','wc','chmod','touch']){
  const from=path.join(process.env.PREFIX,'bin',n);if(fs.existsSync(from))fs.symlinkSync(from,path.join(prefix,'bin',n));
}
const component=path.join(prefix,'lib/openai-bridge');fs.mkdirSync(component);
for(const n of ['installer.cjs','component.cjs','package.json','package-lock.json'])fs.copyFileSync(path.join(kit,n),path.join(component,n));
fs.cpSync(path.join(kit,'runtime'),path.join(component,'runtime'),{recursive:true});
fs.cpSync(path.join(kit,'node_modules'),path.join(component,'node_modules'),{recursive:true,verbatimSymlinks:true});
const allowed=new Set(['PATH','PREFIX','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD','CCAPP_CLAUDE','CCAPP_LOADER','CCAPP_GLIBC_LIB','CCAPP_GLIBC_PRELOAD','CCAPP_CLAUDE_PRELOAD','CCAPP_ENOSYS_RUN','CCAPP_BIONIC_PRELOAD','CCAPP_SHELL','CCAPP_RUNTIME']);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k)));
Object.assign(env,{HOME:home,CCAPP_HOME:home,CCAPP_PREFIX:prefix,CCAPP_WORKSPACE:workspace,CCAPP_TEST:'1',CCAPP_SEED:path.join(home,'no-seed.json'),CCAPP_PRIV_SOCK:path.join(home,'no-device.sock'),CCAPP_BIN:path.join(app,'gateway/bin'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CCR_BRIDGE_INTERVAL:'0.3',CCR_BRIDGE_GRACE:'0',CCR_BRIDGE_FAIL_LIMIT:'1'});
const write=(p,o)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n',{mode:0o600});};
const command=(args)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(component,'component.cjs'),...args],{env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const t=setTimeout(()=>p.kill('SIGKILL'),120000);p.once('error',reject);p.once('close',status=>{clearTimeout(t);resolve({status,out,err});});});
const listen=s=>new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(s.address().port));});
let requests=0,cancelled=0,result;
const upstream=http.createServer((req,res)=>{
  if(req.method==='GET'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'fixture-model',context_window:200000}]}));}
  let data='';req.on('data',b=>data+=b);req.on('end',()=>{
    const body=JSON.parse(data);assert.equal(req.headers.authorization,'Bearer fixture-only-upstream');assert.equal(body.model,'fixture-model');
    const n=++requests;
    const lastUser=[...(body.messages||[])].reverse().find(m=>m.role==='user');
    if(JSON.stringify(lastUser).includes('FIXTURE_KEEP_STREAM_OPEN')){
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({id:'test-'+n,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',content:'fixture streaming'},finish_reason:null}]})+'\n\n');
      const tick=setInterval(()=>res.write(': heartbeat\n\n'),100);res.once('close',()=>{clearInterval(tick);cancelled++;});return;
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'test-'+n,object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'APP_CONTRACT_OK_'+n},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:10,total_tokens:210}}));
  });
});
const target=path.join(home,'bridge'),settings=path.join(home,'.claude/settings.json');
(async()=>{
try{
  const upPort=await listen(upstream),probe=net.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r));
  const cfg=path.join(root,'fake-config.json');write(cfg,{endpoint:'http://127.0.0.1:'+upPort+'/v1/chat/completions',apiKey:'fixture-only-upstream',model:'fixture-model',port});
  const installed=await command(['configure','--dir',target,'--settings',settings,'--config',cfg,'--yes']);assert.equal(installed.status,0,installed.err);
  const c=JSON.parse(fs.readFileSync(path.join(target,'connection.json'),'utf8'));
  write(path.join(root,'components/openai-bridge.json'),{id:'openai-bridge',state:'ok',files:['lib/openai-bridge/component.cjs']});
  write(path.join(home,'ccapp-providers.json'),{active:'custom-contract',providers:{'custom-contract':{label:'Disposable fixture',baseUrl:c.baseUrl,apiKey:c.apiKey,authStyle:'bearer',defaultModel:'fixture-model',modelsUrl:'http://127.0.0.1:'+upPort+'/v1/models',fallbackModels:[{id:'fixture-model',context_window:200000}]}}});
  write(path.join(home,'ccapp-settings.json'),{provider:'custom-contract',model:'fixture-model',permissionMode:'default'});
  const harness=path.join(root,'harness.mjs');
  fs.writeFileSync(harness,`import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const gw=${JSON.stringify(path.join(app,'gateway/gw/'))},base=${JSON.stringify(c.baseUrl)},target=${JSON.stringify(target)},component=${JSON.stringify(component)};
const queue=await import(gw+'queue.mjs'),runs=await import(gw+'runs.mjs'),bus=await import(gw+'bus.mjs'),sf=await import(gw+'streamfix.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),events=[],httpStatuses=[];const off=bus.onPublish(e=>events.push(e));
sf.startStreamFix();while(!sf.STREAMFIX.port)await sleep(10);sf.STREAMFIX.server.on('request',(req,res)=>res.on('finish',()=>httpStatuses.push(res.statusCode)));
const health=()=>fetch(base+'/health',{signal:AbortSignal.timeout(700)}).then(r=>r.ok,()=>false);
const manage=verb=>{const r=spawnSync(process.execPath,[component+'/component.cjs',verb,'--dir',target,'--yes'],{encoding:'utf8',timeout:40000});assert.equal(r.status,0,r.stderr);};
async function phase(name,sid,text='Reply APP_CONTRACT_OK. Do not use tools.'){
const before=httpStatuses.length,{id}=queue.enqueue({message:text,...(sid?{sessionId:sid}:{pin:{provider:'custom-contract',model:'fixture-model'}})});let ended;
for(let i=0;i<1800;i++){ended=events.find(e=>e.type==='run_end'&&e.runId===id);if(ended)break;await sleep(100);}
assert(ended,name+' timed out');assert(!ended.failed&&!ended.isError&&!ended.aborted,JSON.stringify(ended));
const mine=events.filter(e=>e.runId===id),init=mine.find(e=>e.type==='init'),reply=mine.filter(e=>e.type==='delta').map(e=>e.text||'').join('');assert(init?.sessionId);assert.match(reply,/APP_CONTRACT_OK_/);if(sid)assert.equal(init.sessionId,sid);
const statuses=httpStatuses.slice(before);assert.deepEqual(statuses,[200],name+' must not depend on 502/retry');return {name,sessionId:init.sessionId,statuses};}
const result={scope:'candidate gateway startRun + installed CLI + private real CCR; fake upstream; not native UI or signed package'};
try{
assert.equal(await health(),false);result.startup=await phase('startup');manage('stop');assert.equal(await health(),false);result.resume=await phase('resume',result.startup.sessionId);
// Simulate process loss, not a real APK update. Kill only PIDs recorded by this disposable runtime.
const state=target+'/runtime-home/.claude-code-router';for(const f of ['watchdog.pid','.claude-code-router.pid']){const pid=Number(fs.readFileSync(state+'/'+f,'utf8'));const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');assert(cmd.includes(target));process.kill(pid,'SIGKILL');}
for(let i=0;i<40&&await health();i++)await sleep(100);assert.equal(await health(),false);result.processLoss=await phase('simulated-process-loss',result.startup.sessionId);
const {id}=queue.enqueue({message:'FIXTURE_KEEP_STREAM_OPEN. Do not use tools.',sessionId:result.startup.sessionId});let active;for(let i=0;i<1200;i++){active=events.find(e=>e.runId===id&&e.type==='delta');if(active)break;await sleep(100);}assert(active,'no streaming delta');assert(queue.abortRun(runs.RUNS.get(id)));
for(let i=0;i<100&&runs.RUNS.has(id);i++)await sleep(100);assert(!runs.RUNS.has(id));assert.equal(await health(),true);result.cancelled=true;result.afterCancel=await phase('after-cancel',result.startup.sessionId);
manage('stop');assert.equal(await health(),false);
const statusesBefore=httpStatuses.length,offset=events.length;
const concurrent=Array.from({length:3},()=>queue.enqueue({message:'Reply APP_CONTRACT_OK. Do not use tools.',pin:{provider:'custom-contract',model:'fixture-model'}}).id);
for(let i=0;i<1800&&concurrent.some(id=>!events.slice(offset).some(e=>e.type==='run_end'&&e.runId===id));i++)await sleep(100);
for(const id of concurrent){const mine=events.slice(offset).filter(e=>e.runId===id),end=mine.find(e=>e.type==='run_end');assert(end&&!end.failed&&!end.isError&&!end.aborted,JSON.stringify(end));assert.match(mine.filter(e=>e.type==='delta').map(e=>e.text||'').join(''),/APP_CONTRACT_OK_/);}
assert.deepEqual(httpStatuses.slice(statusesBefore),[200,200,200]);
const pids=fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).flatMap(n=>{try{const args=fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0');return args[1]===target+'/watchdog.sh'||args[1]===target+'/node_modules/@musistudio/claude-code-router/dist/cli.js'?[{pid:Number(n),args}]:[];}catch{return [];}});
assert.equal(pids.filter(p=>p.args[1]===target+'/watchdog.sh').length,1);assert.equal(pids.filter(p=>p.args[2]==='start').length,1);result.concurrent={sessions:3,statuses:[200,200,200],watchdogs:1,bridges:1};
const components=await import(gw+'components.mjs'),http=await import('node:http');
const admin=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://fixture');try{await components.routeComponents(req,res,u,u.pathname);}catch{res.writeHead(500);res.end('{}');}});await new Promise(r=>admin.listen(0,'127.0.0.1',r));
try{const rr=await fetch('http://127.0.0.1:'+admin.address().port+'/api/components/remove',{method:'POST',body:JSON.stringify({id:'openai-bridge'})});const removed=await rr.json();assert.equal(removed.ok,true,JSON.stringify(removed));}finally{admin.closeAllConnections();admin.close();}
assert.equal(await health(),false);assert.equal(fs.existsSync(process.env.HOME+'/.cccodroid/services/openai-bridge.json'),false);assert(fs.existsSync(target+'/connection.json'));assert(fs.existsSync(target+'/disabled'));assert.equal(fs.existsSync(component+'/component.cjs'),false);
const oldHook=spawnSync('bash',[target+'/start-bridge.sh','--hook'],{env:{...process.env,ANTHROPIC_BASE_URL:base},encoding:'utf8',timeout:5000});assert.equal(oldHook.status,0);assert.equal(await health(),false);result.componentRemoval={managerRoute:true,stopped:true,registrationRemoved:true,configurationPreserved:true,staleHookBlocked:true};
result.ok=true;console.log(JSON.stringify(result));
}finally{for(const r of runs.RUNS.values())queue.abortRun(r);queue.idleDisarmAll();off();sf.STREAMFIX.server.closeAllConnections();sf.STREAMFIX.server.close();setTimeout(()=>process.exit(process.exitCode||0),1000);}
`);
  const p=spawn(process.execPath,[harness],{env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const t=setTimeout(()=>p.kill('SIGTERM'),360000);
  const code=await new Promise((r,j)=>{p.once('error',j);p.once('close',r);});clearTimeout(t);
  assert.equal(code,0,'gateway integration failed: '+err+'\n'+out);
  result=JSON.parse(out.trim().split('\n').at(-1));assert.equal(result.ok,true);assert.equal(cancelled,1,'stream cancellation must reach upstream');assert.equal(requests,8,'unexpected retry/duplicate paid-shaped request');
  console.log(JSON.stringify({...result,successfulFakeRequests:requests,upstreamCancellations:cancelled},null,2));
}finally{
  if(fs.existsSync(path.join(target,'manage.cjs'))){
    const p=spawn(process.execPath,[path.join(target,'manage.cjs'),'uninstall','--dir',target,'--yes','--purge'],{env,stdio:'ignore'});
    const status=await new Promise((r,j)=>{p.once('error',j);p.once('close',r);});assert.equal(status,0,'own fixture cleanup');
  }
  upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(root,{recursive:true,force:true});
}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
