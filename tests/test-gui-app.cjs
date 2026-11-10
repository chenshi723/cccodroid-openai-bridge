#!/usr/bin/env node
'use strict';
// Opt-in real App route + bundled component + private real CCR. No remote inference.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const app=process.env.OPENAI_BRIDGE_APP_SOURCE;
if(!app||!process.env.PREFIX)throw new Error('Set OPENAI_BRIDGE_APP_SOURCE and PREFIX; this integration is opt-in.');
const source=path.resolve(process.env.OPENAI_BRIDGE_TEST_SOURCE||path.join(__dirname,'..'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gui-app-')),home=path.join(root,'home'),prefix=path.join(root,'usr'),workspace=path.join(root,'workspace');
for(const d of [home,workspace,path.join(prefix,'bin'),path.join(prefix,'lib')])fs.mkdirSync(d,{recursive:true});
for(const name of ['node','bash','sh','flock','timeout','setsid','readlink','tee','base64','date','sleep','mv','rm','dirname','curl','cat','git','env','head','tr','wc','chmod','touch']){
  const from=path.join(process.env.PREFIX,'bin',name);if(fs.existsSync(from))fs.symlinkSync(from,path.join(prefix,'bin',name));
}
const component=path.join(prefix,'lib/openai-bridge');
fs.mkdirSync(component);
for(const name of ['installer.cjs','component.cjs','gui-models.cjs','package.json','package-lock.json'])fs.copyFileSync(path.join(source,name),path.join(component,name));
fs.cpSync(path.join(source,'runtime'),path.join(component,'runtime'),{recursive:true});
fs.cpSync(path.join(source,'node_modules'),path.join(component,'node_modules'),{recursive:true,verbatimSymlinks:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD'].includes(key)));
Object.assign(env,{HOME:home,PREFIX:prefix,CCAPP_HOME:home,CCAPP_PREFIX:prefix,CCAPP_WORKSPACE:workspace,CCAPP_TEST:'1',CCAPP_LOG:path.join(root,'gateway.log'),CCAPP_SEED:path.join(home,'no-seed'),OPENAI_BRIDGE_GUI_APP:path.resolve(app),OPENAI_BRIDGE_GUI_CONFIGURING:process.argv.includes('--configuring')?'1':''});
const record=path.join(root,'components/openai-bridge.json');fs.mkdirSync(path.dirname(record));
fs.writeFileSync(record,JSON.stringify({id:'openai-bridge',state:'ok',files:['lib/openai-bridge/component.cjs']}));
const target=path.join(home,'.local/share/ccr-bridge-kit');
const fakeKey='fixture-private-upstream-never-print';
if(process.argv.includes('--multi-upstream'))env.OPENAI_BRIDGE_GUI_MULTI='1';
let remoteConnections=0;
const upstream=net.createServer(socket=>{remoteConnections++;socket.destroy();});
function exec(args,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env,...options,stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('GUI App fixture timed out'));},180000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',status=>{clearTimeout(timer);resolve({status,out,err});});
  });
}
async function childTest(){
  const assert=(await import('node:assert/strict')).default,fs=await import('node:fs'),path=await import('node:path'),http=await import('node:http');
  const {pathToFileURL}=await import('node:url');
  const dir=path.join(process.env.OPENAI_BRIDGE_GUI_APP,'gateway/gw');
  const {routeComponents}=await import(pathToFileURL(path.join(dir,'components.mjs')));
  const providers=await import(pathToFileURL(path.join(dir,'providers.mjs')));
  const {SETTINGS}=await import(pathToFileURL(path.join(dir,'settings-store.mjs')));
  const initial={provider:providers.PROVIDER.id,setting:SETTINGS.provider};
  const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1');await routeComponents(req,res,u,u.pathname);}catch{res.writeHead(500);res.end('{}');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const frontend=fs.readFileSync(path.join(process.env.OPENAI_BRIDGE_GUI_APP,'gateway/web/app/bridge-config.js'),'utf8');
  const apiPath=/const API = "([^"]+)"/.exec(frontend)?.[1];
  assert.equal(apiPath,'/api/components/openai-bridge/config','the actual browser form must call the real component route');
  const url='http://127.0.0.1:'+server.address().port+apiPath;
  const request=async(body)=>{const r=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const text=await r.text();assert(!text.includes('fixture-private-upstream-never-print'));assert(!text.includes('"apiKey":'));assert(!text.includes('"keyTail":'));assert(!text.includes('"connectionPath":'));return {status:r.status,body:JSON.parse(text)};};
  try{
    const before=await request();assert.equal(before.status,200);assert.equal(before.body.configured,false);
    const input={endpoint:process.env.OPENAI_BRIDGE_FAKE_ENDPOINT,apiKey:'fixture-private-upstream-never-print',model:'fixture-gui-model',consent:true};
    const saved=await request(input);console.log('GUI save result '+JSON.stringify(saved));assert.equal(saved.status,200);assert.equal(saved.body.ok,true);assert.equal(saved.body.configured,true);assert.equal(saved.body.local.state,'ready');assert.match(saved.body.providerId,/^custom-[1-9][0-9]*$/);
    const target=path.join(process.env.HOME,'.local/share/ccr-bridge-kit');
    const manifest=JSON.parse(fs.readFileSync(path.join(target,'.ccr-bridge-kit.json'),'utf8'));
    assert.equal(manifest.guiManaged,true);
    const connection=JSON.parse(fs.readFileSync(path.join(target,'connection.json'),'utf8'));
    const provider=providers.PROVIDERS_CFG.providers[saved.body.providerId];
    assert.equal(provider.baseUrl,connection.baseUrl);assert.equal(provider.apiKey,connection.apiKey);assert.notEqual(provider.apiKey,input.apiKey);
    assert.equal(provider.defaultModel,'fixture-gui-model');assert.equal(providers.PROVIDER.id,initial.provider);assert.equal(SETTINGS.provider,initial.setting);
    const checked=await request();assert.equal(checked.status,200);assert.equal(checked.body.providerId,saved.body.providerId);assert.equal(checked.body.local.state,'ready');
    if(process.env.OPENAI_BRIDGE_GUI_MULTI){
      assert.equal(checked.body.capabilities.multiUpstream,true);
      const first={name:'relay',endpoint:input.endpoint,apiKey:'',models:[{id:input.model}]};
      const second={name:'relay-2',endpoint:input.endpoint,apiKey:'fixture-secondary-account-key',models:[{id:'relay-2/'+input.model,model:input.model}]};
      const models=[{id:input.model,contextWindow:128000},{id:'relay-2/'+input.model,contextWindow:1048576}];
      const full=await request({endpoint:input.endpoint,apiKey:'',model:models[1].id,models,upstreams:[first,second],consent:true});
      assert.equal(full.status,200,JSON.stringify(full.body));assert.equal(full.body.providerId,saved.body.providerId);
      assert.deepEqual(full.body.models,models);assert.equal(full.body.upstreams.length,2);
      assert(!JSON.stringify(full.body).includes(second.apiKey));
      const runtimeFile=path.join(target,'runtime-home/.claude-code-router/config.json'),runtime=JSON.parse(fs.readFileSync(runtimeFile));
      assert.equal(runtime.Providers[0].api_key,input.apiKey);assert.equal(runtime.Providers[1].api_key,second.apiKey);
      assert.equal(runtime.MODEL_ROUTES[models[1].id],'relay-2,'+input.model);
      // 暂时锁住恢复，后面的持久化/移除验收不消耗真实重启预算。
      const state=path.dirname(runtimeFile),fault=path.join(state,'recovery.failed'),attempts=path.join(state,'recovery.attempts');
      fs.writeFileSync(fault,'recovery limit reached\n',{mode:0o600});fs.writeFileSync(attempts,'3\n',{mode:0o600});
      const only={...second,apiKey:''};
      const removed=await request({endpoint:input.endpoint,apiKey:'',model:models[1].id,models:[models[1]],upstreams:[only],consent:true});
      assert.equal(removed.status,200,JSON.stringify(removed.body));assert.equal(removed.body.localError,'RECOVERY_EXHAUSTED');
      assert.equal(removed.body.upstreams[0].name,'relay-2');assert.equal(removed.body.providerId,saved.body.providerId);
      const retained=JSON.parse(fs.readFileSync(runtimeFile));assert.equal(retained.Providers.length,1);assert.equal(retained.Providers[0].api_key,second.apiKey);
      const after=await request();assert.equal(after.status,200,JSON.stringify(after.body));assert.deepEqual(after.body.models,[models[1]]);
      assert.equal(fs.readFileSync(attempts,'utf8'),'3\n');assert.equal(providers.PROVIDER.id,initial.provider);assert.equal(SETTINGS.provider,initial.setting);
      console.log(JSON.stringify({ok:true,scope:'real App route + component multi-upstream + private real CCR',separateSameOriginKeys:true,primaryRemoval:true,stableAliases:true,windowPreserved:true,localIdentityPreserved:true,recoveryPreserved:true}));return;
    }
    if(process.env.OPENAI_BRIDGE_GUI_CONFIGURING){
      // 从第一次启动后的真实恢复预算开始，不能为测试清零，也不把第四次配置重启误当成临时标记失败。
      const disabled=path.join(target,'disabled');fs.writeFileSync(disabled,'configuring\n',{mode:0o600});
      const interrupted=await request();assert.equal(interrupted.status,200);assert.equal(interrupted.body.localError,'COMPONENT_DISABLED');assert.equal(fs.readFileSync(disabled,'utf8'),'configuring\n');
      const resumed=await request({...input,apiKey:''});assert.equal(resumed.status,200,JSON.stringify(resumed.body));assert.equal(resumed.body.localReady,true,JSON.stringify(resumed.body));
      assert.equal(resumed.body.providerId,saved.body.providerId);assert.equal(fs.existsSync(disabled),false);
      const fault=path.join(target,'runtime-home/.claude-code-router/recovery.failed'),attempts=path.join(target,'runtime-home/.claude-code-router/recovery.attempts');
      fs.writeFileSync(disabled,'configuring\n',{mode:0o600});fs.writeFileSync(fault,'recovery limit reached\n',{mode:0o600});fs.writeFileSync(attempts,'3\n',{mode:0o600});
      const blocked=await request({...input,apiKey:''});assert.equal(blocked.status,200,JSON.stringify(blocked.body));assert.equal(blocked.body.localError,'RECOVERY_EXHAUSTED');assert.equal(blocked.body.localReady,false);assert.equal(fs.existsSync(disabled),false);
      assert.equal(fs.readFileSync(fault,'utf8'),'recovery limit reached\n');assert.equal(fs.readFileSync(attempts,'utf8'),'3\n');
      assert.equal(providers.PROVIDER.id,initial.provider);assert.equal(SETTINGS.provider,initial.setting);
      console.log(JSON.stringify({ok:true,scope:'real App route + real CCR interrupted-configuring recovery; no upstream request',interruptedConfiguringRecovered:true,recoveryLockStillAuthoritative:true,providerIdentityPreserved:true}));return;
    }
    const updated=await request({endpoint:input.endpoint,model:'fixture-gui-second',consent:true});assert.equal(updated.status,200);assert.equal(updated.body.ok,true);assert.equal(updated.body.providerId,saved.body.providerId);assert.equal(updated.body.local.state,'ready');
    assert.equal(providers.PROVIDERS_CFG.providers[saved.body.providerId].defaultModel,'fixture-gui-second');assert.equal(providers.PROVIDER.id,initial.provider);assert.equal(SETTINGS.provider,initial.setting);
    const models=[{id:'fixture-gui-first',contextWindow:1048576},{id:'fixture-gui-second',contextWindow:128000},{id:'fixture-gui-unknown',contextWindow:200000}];
    const multi=await request({endpoint:input.endpoint,model:models[0].id,models,consent:true});
    assert.equal(multi.status,200,JSON.stringify(multi.body));assert.equal(multi.body.localReady,true);assert.deepEqual(multi.body.models,models);
    const modelApi=await import(pathToFileURL(path.join(dir,'models.mjs')));
    for(const m of models){
      let output;const u=new URL('http://127.0.0.1/api/models?provider='+multi.body.providerId+'&model='+m.id);
      await modelApi.routeModels({method:'GET'},{writeHead(){},end(text){output=JSON.parse(text);}},u,u.pathname);
      assert.equal(output.contextWindow,m.contextWindow);assert.deepEqual(output.models.map(x=>x.id),models.map(x=>x.id));
    }
    // 实际本地 CCR 仍健康但恢复锁存在：GUI/网关必须与 start/ensure 的阻断语义一致。
    const stateDir=path.join(target,'runtime-home/.claude-code-router'),fault=path.join(stateDir,'recovery.failed'),attempts=path.join(stateDir,'recovery.attempts');
    const localHealthy=await fetch(connection.baseUrl+'/health');assert.equal(localHealthy.status,200);await localHealthy.body?.cancel();
    fs.writeFileSync(fault,'recovery limit reached\n',{mode:0o600});fs.writeFileSync(attempts,'3\n',{mode:0o600});
    const blocked=await request();assert.equal(blocked.body.localReady,false);assert.equal(blocked.body.localError,'RECOVERY_EXHAUSTED');assert.equal(blocked.body.local.state,'error');
    for(let i=0;i<3;i++){
      const locked=await request({endpoint:input.endpoint,model:models[0].id,models,consent:true});
      assert.equal(locked.status,200,JSON.stringify(locked.body));assert.equal(locked.body.configured,true);assert.equal(locked.body.localReady,false);assert.equal(locked.body.localError,'RECOVERY_EXHAUSTED');
      assert.equal(fs.readFileSync(fault,'utf8'),'recovery limit reached\n');assert.equal(fs.readFileSync(attempts,'utf8'),'3\n');
    }
    const denied=await request({endpoint:'https://elsewhere.example.invalid/v1',model:'fixture-gui-second',consent:true});assert.equal(denied.status,400);assert.equal(denied.body.field,'apiKey');
    const settings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude/settings.json'),'utf8'));assert.equal(settings.hooks.SessionStart.length,1);
    console.log(JSON.stringify({ok:true,scope:'real App route + component GUI + private real CCR; no model request',normalLocalReady:true,providerCreated:true,providerUpdated:true,currentProviderPreserved:true,oldKeyNotReturned:true,changedOriginKeyRequired:true,multiModels:3,individualWindows:true,healthyResidualBlocked:true,recoveryLockedSaves:3,recoveryFlagsPreserved:true}));
  }finally{await new Promise(r=>server.close(r));}
}
(async()=>{
  try{
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    env.OPENAI_BRIDGE_FAKE_ENDPOINT='https://127.0.0.1:'+upstream.address().port+'/v1';
    const script='('+childTest.toString()+')().catch(error=>{console.error(error.stack);process.exitCode=1;});';
    const result=await exec(['--input-type=module','-e',script]);
    assert(!result.out.includes(fakeKey));assert(!result.err.includes(fakeKey));
    if(result.status!==0)process.stderr.write(result.err+result.out);
    assert.equal(result.status,0,'real GUI App integration failed; isolated fixture retained only until cleanup');
    assert.equal(remoteConnections,0,'saving/status must not contact the configured upstream');
    process.stdout.write(result.out);console.log('PASS GUI real App route, real local CCR readiness and owned provider; upstream connections=0');
  }finally{
    if(fs.existsSync(path.join(target,'.ccr-bridge-kit.json'))){
      const reg=JSON.parse(fs.readFileSync(path.join(home,'.cccodroid/services/openai-bridge.json'),'utf8'));
      const r=await exec([path.join(component,'component.cjs'),'uninstall','--dir',target,'--endpoint',reg.endpoint,'--instance',reg.instanceId,'--yes','--purge']);
      assert.equal(r.status,0,'fixture uninstall failed; private test root retained for safe cleanup');
    }
    await new Promise(r=>upstream.close(r));
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
