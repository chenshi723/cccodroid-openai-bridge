#!/usr/bin/env node
'use strict';
// Opt-in integration: candidate gateway + installed CLI, disposable HOME and fake loopback upstream only.
// Never import server.mjs: its orphan reaper is process-global, not scoped to these fixtures.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const app=process.env.OPENAI_BRIDGE_APP_SOURCE;
if(!app||!process.env.CCAPP_CLAUDE||!process.env.CCAPP_LOADER||!process.env.PREFIX)throw new Error('Set OPENAI_BRIDGE_APP_SOURCE, PREFIX and installed CLI/loader paths; integration is opt-in.');
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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const listen=s=>new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(s.address().port));});
const freePort=async()=>{const s=net.createServer(),port=await listen(s);await new Promise(r=>s.close(r));return port;};
function command(args,{entry=path.join(component,'component.cjs'),childEnv=env,timeout=120000}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[entry,...args],{env:childEnv,detached:true,stdio:['ignore','pipe','pipe']});let out='',err='',timedOut=false;
    p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
    const t=setTimeout(()=>{timedOut=true;try{process.kill(-p.pid,'SIGKILL');}catch{p.kill('SIGKILL');}},timeout);
    p.once('error',e=>{clearTimeout(t);reject(e);});p.once('close',(status,signal)=>{clearTimeout(t);resolve({status,signal,timedOut,out,err});});
  });
}
const target=path.join(home,'bridge'),settings=path.join(home,'.claude/settings.json');
const health=base=>fetch(base+'/health',{signal:AbortSignal.timeout(700)}).then(r=>r.ok,()=>false);
const checked=r=>assert.equal(r.status,0,JSON.stringify({status:r.status,signal:r.signal,timedOut:r.timedOut})+'\n'+r.err+'\n'+r.out);
const processArgs=pid=>{try{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');}catch{return [];}};
function ownRuntimePids(){
  const scripts=[path.join(target,'watchdog.sh'),path.join(target,'node_modules/@musistudio/claude-code-router/dist/cli.js')];
  return fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).map(Number).filter(pid=>scripts.includes(processArgs(pid)[1]));
}
let requests=0,cancelled=0;
const upstream=http.createServer((req,res)=>{
  if(req.method==='GET'){assert.equal(req.url,'/v1/models');res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'fixture-model',context_window:200000}]}));}
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
  let data='';req.on('data',b=>data+=b);req.on('end',()=>{
    const body=JSON.parse(data);assert.equal(req.headers.authorization,'Bearer fixture-only-upstream');assert.equal(body.model,'fixture-model');
    const n=++requests,lastUser=[...(body.messages||[])].reverse().find(m=>m.role==='user');
    if(JSON.stringify(lastUser).includes('FIXTURE_KEEP_STREAM_OPEN')){
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({id:'test-'+n,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',content:'fixture streaming'},finish_reason:null}]})+'\n\n');
      const tick=setInterval(()=>res.write(': heartbeat\n\n'),100);res.once('close',()=>{clearInterval(tick);cancelled++;});return;
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'test-'+n,object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'APP_CONTRACT_OK_'+n},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:10,total_tokens:210}}));
  });
});

// Each scenario is a NEW Node process, not a query-string import of run.mjs: that
// would still reuse its cached managed-bridge dependency. Cold phases therefore
// cannot accidentally bypass preflight through the real 20-second ready cache.
async function gatewayHarness(){
  const fs=await import('node:fs'),assert=(await import('node:assert/strict')).default,http=await import('node:http');
  const {spawnSync}=await import('node:child_process');
  const o=JSON.parse(process.env.OPENAI_BRIDGE_HARNESS),gw=o.gw,base=o.base,target=o.target,component=o.component;
  const config=await import(gw+'config.mjs');assert.equal(config.CFG.home,process.env.HOME);assert.equal(config.LIVE,false);
  const queue=await import(gw+'queue.mjs'),runs=await import(gw+'runs.mjs'),bus=await import(gw+'bus.mjs'),sf=await import(gw+'streamfix.mjs');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms)),events=[],httpStatuses=[];let preflightChecks=0;const off=bus.onPublish(e=>events.push(e));
  sf.startStreamFix();for(let i=0;i<200&&!sf.STREAMFIX.port;i++)await sleep(10);assert(sf.STREAMFIX.port,'streamfix did not listen');
  sf.STREAMFIX.server.on('request',(req,res)=>res.on('finish',()=>httpStatuses.push(res.statusCode)));
  const health=()=>fetch(base+'/health',{signal:AbortSignal.timeout(700)}).then(r=>r.ok,()=>false);
  if(['startup','resume','processLoss','concurrent'].includes(o.scenario)){
    // Verify readiness AT the real CLI spawn, before SessionStart can start a
    // cold bridge and hide a missing preflight through lucky Hook timing.
    const childProcess=(await import('node:child_process')).default,{syncBuiltinESMExports}=await import('node:module'),spawn=childProcess.spawn;
    childProcess.spawn=function(bin,args,options){
      if(options?.env?.CCAPP_RUN_ID){
        const probe=spawnSync(process.execPath,['-e',`fetch(${JSON.stringify(base+'/health')},{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`],{env:process.env,encoding:'utf8',timeout:2000});
        assert.equal(probe.status,0,'managed preflight must be ready before CLI spawn; cannot rely on its Hook');preflightChecks++;
      }
      return spawn(bin,args,options);
    };
    syncBuiltinESMExports();
  }
  async function waitFor(check,label,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const r=check();if(r)return r;await sleep(50);}throw new Error(label+' timed out');}
  async function endOf(id){return waitFor(()=>events.find(e=>e.type==='run_end'&&e.runId===id),'run '+id);}
  async function phase(name,sid,text='Reply APP_CONTRACT_OK. Do not use tools.'){
    const before=httpStatuses.length,{id}=queue.enqueue({message:text,...(sid?{sessionId:sid}:{pin:{provider:'custom-contract',model:'fixture-model'}})}),ended=await endOf(id);
    assert(!ended.failed&&!ended.isError&&!ended.aborted,JSON.stringify({ended,errors:events.filter(e=>e.runId===id&&e.type==='error')}));
    const mine=events.filter(e=>e.runId===id),init=mine.find(e=>e.type==='init'),reply=mine.filter(e=>e.type==='delta').map(e=>e.text||'').join('');
    assert(init?.sessionId);assert.match(reply,/APP_CONTRACT_OK_/);if(sid)assert.equal(init.sessionId,sid);
    const statuses=httpStatuses.slice(before);assert.deepEqual(statuses,[200],name+' must not depend on 502/retry');return {name,sessionId:init.sessionId,statuses};
  }
  let result;
  try{
    if(['startup','resume','processLoss'].includes(o.scenario)){
      assert.equal(await health(),false,o.scenario+' must begin genuinely cold');
      result={...await phase(o.scenario,o.sid),cold:true,freshGatewayProcess:true};assert.equal(preflightChecks,1);result.preflightReadyBeforeCli=true;
    }else if(o.scenario==='cancel'){
      assert.equal(await health(),true);
      const {id}=queue.enqueue({message:'FIXTURE_KEEP_STREAM_OPEN. Do not use tools.',sessionId:o.sid});
      await waitFor(()=>events.find(e=>e.runId===id&&e.type==='delta'),'streaming delta');assert(queue.abortRun(runs.RUNS.get(id)));
      const ended=await endOf(id);assert.equal(ended.aborted,true);assert(!runs.RUNS.has(id));assert.equal(await health(),true);
      result={cancelled:true,afterCancel:await phase('after-cancel',o.sid)};
    }else if(o.scenario==='cancel-ensure'){
      assert.equal(await health(),false,'cancel during ensure must begin genuinely cold');
      const processList=()=>fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).flatMap(n=>{try{return [{pid:Number(n),args:fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\0')}];}catch{return [];}});
      const launchers=()=>processList().filter(p=>p.args[1]===component+'/component.cjs'&&p.args[2]==='ensure'&&p.args.includes(target));
      const {id}=queue.enqueue({message:'Cancel during real cold readiness. Do not use tools.',pin:{provider:'custom-contract',model:'fixture-model'}});
      await waitFor(()=>launchers().length&&runs.RUNS.get(id)?.readyAbort,'real pending ensure launcher',10000);
      assert.equal(runs.RUNS.get(id)?.child,null);const before=Date.now();assert(queue.abortRun(runs.RUNS.get(id)));
      const ended=await endOf(id);assert.equal(ended.aborted,true);assert(Date.now()-before<2000,'cancelled run must not await shared readiness');
      assert.equal(events.some(e=>e.runId===id&&(e.type==='init'||e.type==='error')),false);assert.deepEqual(httpStatuses,[]);
      // Cancellation detaches only this waiter. The shared cold startup is
      // intentionally allowed to finish; do not kill its detached service.
      const managed=await import(gw+'managed-bridge.mjs');assert.equal(await managed.ensureManagedBridge({custom:true,baseUrl:base}),true);
      assert.equal(await health(),true);
      const temporary=()=>processList().filter(p=>(p.args[1]===component+'/component.cjs'&&p.args[2]==='ensure'&&p.args.includes(target))||
        (p.args[1]===component+'/installer.cjs'&&p.args[2]==='ensure'&&p.args.includes(target))||p.args[1]===target+'/start-bridge.sh'||
        (p.args[1]===target+'/manage.cjs'&&p.args[2]==='ensure'));
      await waitFor(()=>temporary().length===0,'real ensure temporary process cleanup',5000);
      const processes=processList();assert.equal(processes.filter(p=>p.args[1]===target+'/watchdog.sh').length,1);
      assert.equal(processes.filter(p=>p.args[1]===target+'/node_modules/@musistudio/claude-code-router/dist/cli.js'&&p.args[2]==='start').length,1);
      result={preflightOnly:true,noCli:true,noHttpRequests:true,cancelReturnedBeforeReady:true,sharedStartupCompleted:true,noTemporaryProcesses:true,watchdogs:1,bridges:1};
    }else if(o.scenario==='concurrent'){
      assert.equal(await health(),false,'concurrent must begin genuinely cold');
      const ids=Array.from({length:3},()=>queue.enqueue({message:'Reply APP_CONTRACT_OK. Do not use tools.',pin:{provider:'custom-contract',model:'fixture-model'}}).id);
      const ended=await Promise.all(ids.map(endOf));
      for(let i=0;i<ids.length;i++){assert(!ended[i].failed&&!ended[i].isError&&!ended[i].aborted,JSON.stringify(ended[i]));assert.match(events.filter(e=>e.runId===ids[i]&&e.type==='delta').map(e=>e.text||'').join(''),/APP_CONTRACT_OK_/);}
      assert.deepEqual(httpStatuses,[200,200,200]);
      const args=fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).flatMap(n=>{try{return [fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\0')];}catch{return [];}});
      assert.equal(args.filter(a=>a[1]===target+'/watchdog.sh').length,1);
      assert.equal(args.filter(a=>a[1]===target+'/node_modules/@musistudio/claude-code-router/dist/cli.js'&&a[2]==='start').length,1);
      assert.equal(preflightChecks,3);result={sessions:3,statuses:httpStatuses,cold:true,freshGatewayProcess:true,preflightReadyBeforeCli:true,watchdogs:1,bridges:1};
    }else if(o.scenario==='remove'){
      assert.equal(await health(),true);
      const components=await import(gw+'components.mjs');
      const admin=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://fixture');try{await components.routeComponents(req,res,u,u.pathname);}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
      await new Promise(r=>admin.listen(0,'127.0.0.1',r));
      try{const rr=await fetch('http://127.0.0.1:'+admin.address().port+'/api/components/remove',{method:'POST',body:JSON.stringify({id:'openai-bridge'})});const removed=await rr.json();assert.equal(removed.ok,true,JSON.stringify(removed));}
      finally{admin.closeAllConnections();await new Promise(r=>admin.close(r));}
      assert.equal(await health(),false);assert.equal(fs.existsSync(process.env.HOME+'/.cccodroid/services/openai-bridge.json'),false);
      assert(fs.existsSync(target+'/connection.json'));assert(fs.existsSync(target+'/disabled'));assert.equal(fs.existsSync(component+'/component.cjs'),false);
      const oldHook=spawnSync('bash',[target+'/start-bridge.sh','--hook'],{env:{...process.env,ANTHROPIC_BASE_URL:base},encoding:'utf8',timeout:5000});assert.equal(oldHook.status,0,oldHook.stderr);assert.equal(await health(),false);
      result={managerRoute:true,stopped:true,registrationRemoved:true,configurationPreserved:true,staleHookBlocked:true};
    }else{
      assert.equal(o.scenario,'remove-ensure');
      const {id}=queue.enqueue({message:'Must be cancelled before CLI spawn.',pin:{provider:'custom-contract',model:'fixture-model'}});
      await waitFor(()=>['ensure','child','grandchild'].every(n=>fs.existsSync(o.tree+'/'+n+'.pid')),'ensure process tree',10000);
      const scripts={ensure:component+'/component.cjs',child:o.tree+'/child.cjs',grandchild:o.tree+'/grandchild.cjs'};
      const pids=Object.fromEntries(Object.keys(scripts).map(n=>[n,Number(fs.readFileSync(o.tree+'/'+n+'.pid','utf8'))]));
      for(const [n,pid] of Object.entries(pids))assert.equal(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0')[1],scripts[n]);
      assert(runs.RUNS.get(id)?.readyAbort,'must cancel while ensure is pending');assert.equal(runs.RUNS.get(id)?.child,null);
      const components=await import(gw+'components.mjs');
      const admin=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://fixture');try{await components.routeComponents(req,res,u,u.pathname);}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
      await new Promise(r=>admin.listen(0,'127.0.0.1',r));
      try{const rr=await fetch('http://127.0.0.1:'+admin.address().port+'/api/components/remove',{method:'POST',body:JSON.stringify({id:'openai-bridge'}),signal:AbortSignal.timeout(10000)});const removed=await rr.json();assert.equal(removed.ok,true,JSON.stringify(removed));}
      finally{admin.closeAllConnections();await new Promise(r=>admin.close(r));}
      const ended=await endOf(id),mine=events.filter(e=>e.runId===id);
      assert(!runs.RUNS.has(id));assert.equal(mine.some(e=>e.type==='init'),false,'pending ensure must not spawn CLI');assert.deepEqual(httpStatuses,[]);
      const alive=pid=>{try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');return !/^\d+ \(.*\) Z /.test(stat);}catch{return false;}};
      await waitFor(()=>Object.values(pids).every(pid=>!alive(pid)),'ensure descendants must die, not just the direct child',5000);
      const remaining=fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).flatMap(n=>{try{const args=fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\0');return Object.values(scripts).includes(args[1])&&alive(n)?[Number(n)]:[];}catch{return [];}});
      assert.deepEqual(remaining,[]);
      assert.equal(ended.failed,true);assert(fs.existsSync(o.tree+'/disabled'));assert.equal(fs.existsSync(process.env.HOME+'/.cccodroid/services/openai-bridge.json'),false);assert.equal(fs.existsSync(component+'/component.cjs'),false);
      const args=JSON.parse(fs.readFileSync(o.tree+'/uninstall.json','utf8'));assert.equal(args[args.indexOf('--endpoint')+1],base);assert.equal(args[args.indexOf('--instance')+1],o.instanceId);
      result={scenario:o.scenario,preflightOnly:true,noCli:true,noHttpRequests:true,terminatedEnsureProcesses:Object.keys(pids).length};
    }
    assert.equal(runs.RUNS.size,0);return result;
  }finally{
    for(const r of runs.RUNS.values())queue.abortRun(r);queue.idleDisarmAll();off();
    sf.STREAMFIX.server.closeAllConnections();await new Promise(r=>sf.STREAMFIX.server.close(r));
  }
}
const harness=path.join(root,'harness.mjs');
fs.writeFileSync(harness,`(${gatewayHarness.toString()})().then(result=>{console.log(JSON.stringify(result));process.exit(0);},e=>{console.error(e.stack);process.exit(1);});\n`,{mode:0o600});
async function runGateway(scenario,base,extra={},childEnv=env,fixtureComponent=component){
  const options={scenario,gw:path.join(app,'gateway/gw/'),base,target,component:fixtureComponent,...extra};
  const r=await command([],{entry:harness,childEnv:{...childEnv,OPENAI_BRIDGE_HARNESS:JSON.stringify(options)},timeout:240000});
  checked(r);const result=JSON.parse(r.out.trim().split('\n').at(-1));console.log('PASS '+scenario);return result;
}

// A synthetic installed component makes pending-ensure retirement deterministic.
// Its child/grandchild are fixture-owned and block forever: natural expiry must
// not conceal a leaked short-lived process tree. No real component is replaced.
async function pendingEnsureFixture(scenario,sentinelBase){
  const dir=path.join(root,scenario),fixtureHome=path.join(dir,'home'),fixturePrefix=path.join(dir,'usr'),tree=path.join(dir,'tree'),fixtureComponent=path.join(fixturePrefix,'lib/openai-bridge');
  for(const d of [fixtureHome,fixtureComponent,path.join(fixturePrefix,'bin'),tree])fs.mkdirSync(d,{recursive:true});
  fs.symlinkSync(process.execPath,path.join(fixturePrefix,'bin/node'));
  const base='http://127.0.0.1:'+await freePort(),instanceId=require('node:crypto').randomBytes(16).toString('hex');
  const reg=path.join(fixtureHome,'.cccodroid/services/openai-bridge.json');
  write(reg,{schema:1,id:'openai-bridge',endpoint:base,runtimeDir:tree,instanceId});
  write(path.join(dir,'components/openai-bridge.json'),{id:'openai-bridge',state:'ok',files:['lib/openai-bridge/component.cjs']});
  write(path.join(fixtureHome,'ccapp-providers.json'),{active:'custom-contract',providers:{'custom-contract':{label:'Fake pending bridge',baseUrl:base,apiKey:'fixture-only-no-inference',authStyle:'bearer',defaultModel:'fixture-model',fallbackModels:[{id:'fixture-model'}]}}});
  write(path.join(fixtureHome,'ccapp-settings.json'),{provider:'custom-contract',model:'fixture-model',permissionMode:'default'});
  fs.writeFileSync(path.join(tree,'grandchild.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(path.join(tree,'grandchild.pid'))},String(process.pid));setInterval(()=>{},1000);\n`);
  fs.writeFileSync(path.join(tree,'child.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(path.join(tree,'child.pid'))},String(process.pid));require('node:child_process').spawn(process.execPath,[${JSON.stringify(path.join(tree,'grandchild.cjs'))}],{stdio:'inherit'});setInterval(()=>{},1000);\n`);
  fs.writeFileSync(path.join(fixtureComponent,'component.cjs'),`const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2);assert.equal(args[args.indexOf('--dir')+1],${JSON.stringify(tree)});assert.equal(args[args.indexOf('--endpoint')+1],${JSON.stringify(base)});assert.equal(args[args.indexOf('--instance')+1],${JSON.stringify(instanceId)});if(args[0]==='ensure'){fs.writeFileSync(${JSON.stringify(path.join(tree,'ensure.pid'))},String(process.pid));require('node:child_process').spawn(process.execPath,[${JSON.stringify(path.join(tree,'child.cjs'))}],{stdio:'inherit'});setInterval(()=>{},1000);}else{assert.equal(args[0],'uninstall');fs.writeFileSync(${JSON.stringify(path.join(tree,'uninstall.json'))},JSON.stringify(args));fs.writeFileSync(${JSON.stringify(path.join(tree,'disabled'))},'disabled');fs.unlinkSync(${JSON.stringify(reg)});}\n`);
  const fixtureEnv={...env,HOME:fixtureHome,CCAPP_HOME:fixtureHome,CCAPP_PREFIX:fixturePrefix,CCAPP_WORKSPACE:tree,CLAUDE_CONFIG_DIR:path.join(fixtureHome,'.claude')};
  try{
    const result=await runGateway(scenario,base,{tree,instanceId},fixtureEnv,fixtureComponent);
    assert.equal(await health(sentinelBase),true,'cancelling/retiring must not kill another fixture service');return {...result,unrelatedServicePreserved:true};
  }finally{
    // Failure cleanup is limited to exact scripts created above, never names,
    // shared service ports, installed binaries or arbitrary recorded PIDs.
    const scripts=[path.join(fixtureComponent,'component.cjs'),path.join(tree,'child.cjs'),path.join(tree,'grandchild.cjs')];
    const remaining=()=>fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).map(Number).filter(pid=>scripts.includes(processArgs(pid)[1]));
    for(const pid of remaining())try{process.kill(pid,'SIGKILL');}catch{}
    for(let i=0;i<60&&remaining().length;i++)await sleep(50);
    assert.deepEqual(remaining(),[],'synthetic fixture cleanup must leave no process tree');
  }
}

(async()=>{
  let sentinel,finalResult;
  try{
    const upPort=await listen(upstream),port=await freePort(),cfg=path.join(root,'fake-config.json');
    write(cfg,{endpoint:'http://127.0.0.1:'+upPort+'/v1/chat/completions',apiKey:'fixture-only-upstream',model:'fixture-model',port});
    checked(await command(['configure','--dir',target,'--settings',settings,'--config',cfg,'--yes']));
    const c=JSON.parse(fs.readFileSync(path.join(target,'connection.json'),'utf8'));
    write(path.join(root,'components/openai-bridge.json'),{id:'openai-bridge',state:'ok',files:['lib/openai-bridge/component.cjs']});
    write(path.join(home,'ccapp-providers.json'),{active:'custom-contract',providers:{'custom-contract':{label:'Disposable fixture',baseUrl:c.baseUrl,apiKey:c.apiKey,authStyle:'bearer',defaultModel:'fixture-model',modelsUrl:'http://127.0.0.1:'+upPort+'/v1/models',fallbackModels:[{id:'fixture-model',context_window:200000}]}}});
    write(path.join(home,'ccapp-settings.json'),{provider:'custom-contract',model:'fixture-model',permissionMode:'default'});
    const result={scope:'candidate gateway startRun + installed CLI + private real CCR; fake upstream; not native UI or signed package'};
    // Fail fast on pending-ensure regressions before the heavier CLI chain.
    // This process/HTTP service is deliberately outside both ensure trees.
    const sentinelScript=path.join(root,'unrelated-sentinel.cjs'),sentinelPort=await freePort(),sentinelBase='http://127.0.0.1:'+sentinelPort;
    fs.writeFileSync(sentinelScript,`require('node:http').createServer((req,res)=>res.end('fixture sentinel')).listen(${sentinelPort},'127.0.0.1');\n`);
    sentinel=spawn(process.execPath,[sentinelScript],{env,stdio:'ignore'});
    for(let i=0;i<100&&!await health(sentinelBase);i++)await sleep(50);assert.equal(await health(sentinelBase),true);assert.equal(processArgs(sentinel.pid)[1],sentinelScript);
    const serviceFile=path.join(home,'.cccodroid/services/openai-bridge.json'),registration=fs.readFileSync(serviceFile);
    result.cancelDuringEnsure=await runGateway('cancel-ensure',c.baseUrl);
    assert.deepEqual(fs.readFileSync(serviceFile),registration);assert.equal(fs.existsSync(path.join(target,'disabled')),false);assert.equal(await health(sentinelBase),true);
    checked(await command(['stop','--dir',target,'--yes']));assert.equal(await health(c.baseUrl),false);
    result.removeDuringEnsure=await pendingEnsureFixture('remove-ensure',sentinelBase);
    result.startup=await runGateway('startup',c.baseUrl);
    checked(await command(['stop','--dir',target,'--yes']));assert.equal(await health(c.baseUrl),false);
    result.resume=await runGateway('resume',c.baseUrl,{sid:result.startup.sessionId});
    // Simulated process loss, not an APK update. Kill only exact private runtime
    // scripts, after validating the recorded PIDs against /proc command lines.
    const state=path.join(target,'runtime-home/.claude-code-router');
    for(const [file,script] of [['watchdog.pid',path.join(target,'watchdog.sh')],['.claude-code-router.pid',path.join(target,'node_modules/@musistudio/claude-code-router/dist/cli.js')]]){
      const pid=Number(fs.readFileSync(path.join(state,file),'utf8'));assert.equal(processArgs(pid)[1],script);process.kill(pid,'SIGKILL');
    }
    for(let i=0;i<40&&await health(c.baseUrl);i++)await sleep(100);assert.equal(await health(c.baseUrl),false);
    result.processLoss=await runGateway('processLoss',c.baseUrl,{sid:result.startup.sessionId});
    Object.assign(result,await runGateway('cancel',c.baseUrl,{sid:result.startup.sessionId}));
    checked(await command(['stop','--dir',target,'--yes']));assert.equal(await health(c.baseUrl),false);
    result.concurrent=await runGateway('concurrent',c.baseUrl);
    result.componentRemoval=await runGateway('remove',c.baseUrl);assert.equal(ownRuntimePids().length,0);
    assert.equal(processArgs(sentinel.pid)[1],sentinelScript);assert.equal(await health(sentinelBase),true);
    assert.equal(cancelled,1,'stream cancellation must reach upstream');assert.equal(requests,8,'unexpected retry/duplicate paid-shaped request');
    finalResult={...result,successfulFakeRequests:requests,upstreamCancellations:cancelled,ok:true};
  }finally{
    const errors=[];
    if(sentinel&&sentinel.exitCode===null&&sentinel.signalCode===null){const closed=new Promise(r=>sentinel.once('close',r));sentinel.kill('SIGTERM');await closed;}
    if(fs.existsSync(path.join(target,'manage.cjs'))){
      try{checked(await command(['uninstall','--dir',target,'--yes','--purge'],{entry:path.join(target,'manage.cjs')}));assert.equal(ownRuntimePids().length,0,'own fixture runtime cleanup');}
      catch(e){errors.push(e);}
    }
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    if(!errors.length)fs.rmSync(root,{recursive:true,force:true});else throw new AggregateError(errors,'fixture cleanup failed; retained '+root);
  }
  console.log(JSON.stringify({...finalResult,fixtureCleanup:true},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
