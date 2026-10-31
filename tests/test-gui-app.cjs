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
for(const name of ['installer.cjs','component.cjs','package.json','package-lock.json'])fs.copyFileSync(path.join(source,name),path.join(component,name));
fs.cpSync(path.join(source,'runtime'),path.join(component,'runtime'),{recursive:true});
fs.cpSync(path.join(source,'node_modules'),path.join(component,'node_modules'),{recursive:true,verbatimSymlinks:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD'].includes(key)));
Object.assign(env,{HOME:home,PREFIX:prefix,CCAPP_HOME:home,CCAPP_PREFIX:prefix,CCAPP_WORKSPACE:workspace,CCAPP_TEST:'1',CCAPP_LOG:path.join(root,'gateway.log'),CCAPP_SEED:path.join(home,'no-seed'),OPENAI_BRIDGE_GUI_APP:path.resolve(app)});
const record=path.join(root,'components/openai-bridge.json');fs.mkdirSync(path.dirname(record));
fs.writeFileSync(record,JSON.stringify({id:'openai-bridge',state:'ok',files:['lib/openai-bridge/component.cjs']}));
const target=path.join(home,'.local/share/ccr-bridge-kit');
const fakeKey='fixture-private-upstream-never-print';
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
    const updated=await request({endpoint:input.endpoint,model:'fixture-gui-second',consent:true});assert.equal(updated.status,200);assert.equal(updated.body.ok,true);assert.equal(updated.body.providerId,saved.body.providerId);assert.equal(updated.body.local.state,'ready');
    assert.equal(providers.PROVIDERS_CFG.providers[saved.body.providerId].defaultModel,'fixture-gui-second');assert.equal(providers.PROVIDER.id,initial.provider);assert.equal(SETTINGS.provider,initial.setting);
    const denied=await request({endpoint:'https://elsewhere.example.invalid/v1',model:'fixture-gui-second',consent:true});assert.equal(denied.status,400);assert.equal(denied.body.field,'apiKey');
    const settings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude/settings.json'),'utf8'));assert.equal(settings.hooks.SessionStart.length,1);
    console.log(JSON.stringify({ok:true,scope:'real App route + component GUI + private real CCR; no model request',localReady:true,providerCreated:true,providerUpdated:true,currentProviderPreserved:true,oldKeyNotReturned:true,changedOriginKeyRequired:true}));
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
