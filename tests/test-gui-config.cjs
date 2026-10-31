#!/usr/bin/env node
'use strict';
// Only disposable fake bundles, fake secrets and isolated HOME. No real keys/config/processes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'..'),api=require('../installer.cjs');
const upstreamKey='fixture-upstream-key-DO-NOT-OUTPUT';
const input={endpoint:'https://api.example.invalid/v1',apiKey:upstreamKey,model:'fixture-model'};
const fixture=(fn)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gui-unit-')),home=path.join(root,'home'),kit=path.join(root,'component');
  fs.mkdirSync(home);fs.mkdirSync(path.join(kit,'runtime'),{recursive:true});
  for(const file of ['installer.cjs','component.cjs','package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(kit,file));
  fs.copyFileSync(path.join(source,'runtime/service-registration.cjs'),path.join(kit,'runtime/service-registration.cjs'));
  const common='BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || return 1\nSTATE="$BR/runtime-home/.claude-code-router"\n'+
    'watchdog_running() { printf "watchdog-checked\\n" >> "$BR/stop-called"; return 1; }\n'+
    'bridge_pid() { return 1; }\n';
  fs.writeFileSync(path.join(kit,'runtime/bridge-common.sh'),common);
  fs.writeFileSync(path.join(kit,'runtime/start-bridge.sh'),'printf "start\\n" >> "$(dirname -- "$0")/start-called"\nexit 0\n');
  fs.writeFileSync(path.join(kit,'runtime/watchdog.sh'),'# fixture watchdog, never launched\n');
  fs.writeFileSync(path.join(kit,'runtime/health.cjs'),'// fixture health, never launched\n');
  fs.writeFileSync(path.join(kit,'runtime/patch-ccr.js'),'process.exitCode=0;\n');
  const pkg=path.join(kit,'node_modules/@musistudio/claude-code-router');fs.mkdirSync(pkg,{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'1.0.73'}));
  fs.writeFileSync(path.join(pkg,'fake-copy'),'bundle-is-read-only');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','PREFIX','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD'].includes(k)));
  env.HOME=home;
  const target=path.join(home,'.local/share/ccr-bridge-kit'),settings=path.join(home,'.claude/settings.json'),registry=path.join(home,'.cccodroid/services/openai-bridge.json');
  const run=(command,body,extra={})=>spawnSync(process.execPath,[path.join(kit,'component.cjs'),command,...(extra.args||[])],{env:{...env,...extra.env},input:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),encoding:'utf8',timeout:20000});
  const f={root,home,kit,target,settings,registry,env,run};
  try{return fn(f);}finally{fs.rmSync(root,{recursive:true,force:true});}
};
function snapshot(root){
  const result={};function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name),key=path.relative(root,p),st=fs.lstatSync(p);
    if(e.isDirectory()){result[key]={kind:'dir',ino:st.ino,mode:st.mode&0o777};visit(p);}
    else result[key]={kind:e.isSymbolicLink()?'link':'file',ino:st.ino,mode:st.mode&0o777,data:e.isSymbolicLink()?fs.readlinkSync(p):fs.readFileSync(p,'base64')};
  }}visit(root);return result;
}
function result(r){assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.stderr,'');return JSON.parse(r.stdout);}
function saved(f,body=input){const r=f.run('gui-configure',body),value=result(r);assert.equal(value.configured,true);assert.equal(value.hasKey,true);assert.equal(value.localReady,false);assert.equal(value.localError,'LOCAL_START_FAILED');return {r,value};}
function deny(f,body,code='RUNTIME_CONFLICT',options={}){
  const before=snapshot(f.home),r=f.run('gui-configure',body,options);
  assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(r.stdout,'');
  assert.equal(JSON.parse(r.stderr).error.code,code);assert.deepEqual(snapshot(f.home),before);
  assert(!r.stderr.includes(upstreamKey));return r;
}
function config(f){return JSON.parse(fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json'),'utf8'));}
function write(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}

test('GUI status without installation is nonsecret, read-only and never creates runtime',()=>fixture(f=>{
  const before=snapshot(f.home),r=f.run('gui-status'),v=result(r);
  assert.deepEqual(v,{schema:1,id:'openai-bridge',configured:false,endpoint:'',model:'',hasKey:false,localReady:false});
  assert.deepEqual(snapshot(f.home),before);
}));

test('first GUI save copies bundle privately, registers own instance, merges Hook and returns only connection path',()=>fixture(f=>{
  const bundle=snapshot(f.kit),{r,value}=saved(f);
  assert.equal(value.endpoint,'https://api.example.invalid/v1/chat/completions');assert.equal(value.model,input.model);
  assert.equal(value.connectionPath,path.join(f.target,'connection.json'));
  const c=JSON.parse(fs.readFileSync(value.connectionPath,'utf8')),m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json'))),reg=JSON.parse(fs.readFileSync(f.registry));
  assert.equal(m.guiManaged,true);
  assert.match(c.apiKey,/^[0-9a-f]{48}$/);assert.notEqual(c.apiKey,upstreamKey);
  assert.equal(config(f).Providers[0].api_key,upstreamKey);assert.equal(config(f).APIKEY,c.apiKey);
  assert.equal(reg.runtimeDir,f.target);assert.equal(reg.instanceId,m.service.instanceId);assert.equal(reg.endpoint,c.baseUrl);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)),api.mergeHook({},f.target));
  assert.equal(fs.statSync(value.connectionPath).mode&0o777,0o600);
  assert.equal(fs.statSync(path.join(f.target,'runtime-home/.claude-code-router/config.json')).mode&0o777,0o600);
  assert(!r.stdout.includes(upstreamKey));assert(!r.stdout.includes(c.apiKey));assert(!r.stdout.includes('apiKey'));
  assert.equal(fs.existsSync(path.join(f.target,'start-called')),true);assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
  assert.deepEqual(snapshot(f.kit),bundle);
  fs.writeFileSync(path.join(f.target,'node_modules/@musistudio/claude-code-router/fake-copy'),'private-change');
  assert.equal(fs.readFileSync(path.join(f.kit,'node_modules/@musistudio/claude-code-router/fake-copy'),'utf8'),'bundle-is-read-only');
}));

test('regular CLI configure never marks a manual installation as GUI-managed or lets GUI take it over',()=>fixture(f=>{
  const file=path.join(f.root,'fixture-cli-config.json');write(file,input);
  const r=f.run('configure',undefined,{args:['--config',file,'--yes']});
  assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);
  const m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json'),'utf8'));
  assert.equal(Object.hasOwn(m,'guiManaged'),false);
  assert.equal(fs.existsSync(f.registry),true);
  deny(f,{...input,model:'gui-must-not-touch'});
  const before=snapshot(f.home),status=f.run('gui-status');
  assert.equal(status.status,1,status.stdout+status.stderr);assert.equal(JSON.parse(status.stderr).error.code,'RUNTIME_CONFLICT');
  assert.deepEqual(snapshot(f.home),before);assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
}));

test('GUI status exposes no old key or connection path and never starts/stops/writes',()=>fixture(f=>{
  saved(f);const before=snapshot(f.home),r=f.run('gui-status'),v=result(r),c=JSON.parse(fs.readFileSync(path.join(f.target,'connection.json')));
  assert.deepEqual(v,{schema:1,id:'openai-bridge',configured:true,endpoint:'https://api.example.invalid/v1/chat/completions',model:input.model,hasKey:true,localReady:false});
  assert(!r.stdout.includes(upstreamKey));assert(!r.stdout.includes(c.apiKey));assert(!('connectionPath'in v));
  assert.deepEqual(snapshot(f.home),before);
}));

test('GUI endpoint normalization accepts root/v1/full completion path but never guesses private paths',()=>{
  for(const endpoint of ['https://api.example.invalid','https://api.example.invalid/','https://api.example.invalid/v1/','https://api.example.invalid/v1/chat/completions','https://api.example.invalid/proxy/chat/completions/'])fixture(f=>{
    const {value}=saved(f,{...input,endpoint});assert.match(value.endpoint,/\/chat\/completions$/);
  });
  fixture(f=>{for(const endpoint of ['https://api.example.invalid/proxy','https://u:p@api.example.invalid/v1','https://api.example.invalid/v1?key=secret','https://api.example.invalid/v1#secret','http://api.example.invalid/v1','http://127.0.0.1:3459/v1','file:///v1','not a url','https://api.example.invalid\\evil/v1','https://api.example.invalid/v1\n'])deny(f,{...input,endpoint},'INVALID_INPUT');});
});

test('GUI rejects malformed/oversized/unexpected stdin and argv key before any writes',()=>fixture(f=>{
  for(const body of ['{bad','[]','null',JSON.stringify({...input,apiKey:4}),JSON.stringify({...input,port:4444}),'x'.repeat(17000),{...input,model:'bad,model'},{...input,model:'x'.repeat(201)},{...input,apiKey:'bad\nkey'},{...input,apiKey:'bad key'},{...input,apiKey:'x'.repeat(1025)}])deny(f,body,'INVALID_INPUT');
  deny(f,{...input,apiKey:''},'KEY_REQUIRED');
  deny(f,input,'INVALID_INPUT',{args:['--api-key',upstreamKey]});
  const r=f.run('gui-status',undefined,{args:['--dir',f.target]});assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).error.code,'INVALID_INPUT');
}));

test('GUI edit empty key retains same-origin secret/local key/registration and restarts only own runtime',()=>fixture(f=>{
  saved(f);const c=fs.readFileSync(path.join(f.target,'connection.json'),'utf8'),reg=fs.readFileSync(f.registry),m=fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json'));
  const foreign=path.join(f.home,'unrelated-runtime');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'keep'),'foreign-fixture');const foreignBefore=snapshot(foreign);
  const {value}=saved(f,{endpoint:'https://api.example.invalid/proxy/chat/completions',apiKey:'',model:'fixture-model-two'});
  assert.equal(value.model,'fixture-model-two');assert.equal(config(f).Providers[0].api_key,upstreamKey);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'connection.json'))).apiKey,JSON.parse(c).apiKey);
  assert.deepEqual(fs.readFileSync(f.registry),reg);assert.deepEqual(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')),m);
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
  assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false,'fixed stop must not source the private common');
  assert.equal(fs.existsSync(path.join(f.target,'runtime-home/.claude-code-router/service.lock')),true);
  assert.deepEqual(snapshot(foreign),foreignBefore);
}));

test('GUI edit no-op saves do not stop, while replacing secret keeps local bridge key',()=>fixture(f=>{
  saved(f);const c=JSON.parse(fs.readFileSync(path.join(f.target,'connection.json')));
  saved(f,{...input,apiKey:''});assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
  assert.equal(fs.existsSync(path.join(f.target,'runtime-home/.claude-code-router/service.lock')),false);
  saved(f,{...input,apiKey:'fixture-replacement-key'});assert.equal(config(f).Providers[0].api_key,'fixture-replacement-key');
  assert.equal(config(f).APIKEY,c.apiKey);assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
  assert.equal(fs.existsSync(path.join(f.target,'runtime-home/.claude-code-router/service.lock')),true);
}));

test('GUI edit requires fresh key for changed hostname, scheme or port before stopping',()=>fixture(f=>{
  saved(f);for(const endpoint of ['https://new.example.invalid/v1','https://api.example.invalid:8443/v1'])deny(f,{...input,endpoint,apiKey:''},'KEY_HOST_CHANGED');
  const {value}=saved(f,{...input,endpoint:'https://new.example.invalid/v1',apiKey:'fixture-new-host-key'});
  assert.equal(value.endpoint,'https://new.example.invalid/v1/chat/completions');assert.equal(config(f).Providers[0].api_key,'fixture-new-host-key');
}));

test('GUI never overwrites unknown/default manual runtime or another registered instance',()=>{
  fixture(f=>{fs.mkdirSync(f.target,{recursive:true});fs.writeFileSync(path.join(f.target,'keep'),'manual-data');deny(f,input);});
  fixture(f=>{fs.mkdirSync(path.dirname(f.registry),{recursive:true});write(f.registry,{schema:1,id:'openai-bridge',endpoint:'http://127.0.0.1:34599',runtimeDir:path.join(f.home,'manual-bridge'),instanceId:'2'.repeat(32)});deny(f,input);});
  for(const mutate of [
    f=>{const m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')));delete m.guiManaged;write(path.join(f.target,'.ccr-bridge-kit.json'),m);},
    f=>{const m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')));m.guiManaged=false;write(path.join(f.target,'.ccr-bridge-kit.json'),m);},
    f=>{const m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')));m.version='1.0.4';write(path.join(f.target,'.ccr-bridge-kit.json'),m);},
    f=>{const m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')));delete m.service;write(path.join(f.target,'.ccr-bridge-kit.json'),m);},
    f=>{const m=JSON.parse(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')));m.componentEntry='/manual/component.cjs';write(path.join(f.target,'.ccr-bridge-kit.json'),m);},
    f=>fs.appendFileSync(path.join(f.target,'start-bridge.sh'),'# user edit\n'),
    f=>fs.writeFileSync(path.join(f.target,'disabled'),'uninstalled\n'),
    f=>{const r=JSON.parse(fs.readFileSync(f.registry));r.instanceId='2'.repeat(32);write(f.registry,r);},
    f=>{const c=config(f);c.Providers[0].api_base_url='https://unexpected.invalid/private';write(path.join(f.target,'runtime-home/.claude-code-router/config.json'),c);},
    f=>{const file=path.join(f.target,'connection.json');fs.renameSync(file,file+'.actual');fs.symlinkSync(file+'.actual',file);}
  ])fixture(f=>{saved(f);mutate(f);deny(f,{...input,model:'changed'});const before=snapshot(f.home),r=f.run('gui-status');assert.equal(r.status,1);assert.deepEqual(snapshot(f.home),before);assert(!r.stderr.includes(upstreamKey));});
});

test('GUI refuses an upgraded component runtime mismatch without rewriting private runtime',()=>fixture(f=>{
  saved(f);fs.appendFileSync(path.join(f.kit,'runtime/start-bridge.sh'),'# newer runtime incompatible\n');deny(f,{...input,model:'changed'});
}));

test('GUI ready status uses only validated literal loopback health and does not disclose secrets',()=>fixture(f=>{
  const common=path.join(f.kit,'runtime/bridge-common.sh');fs.writeFileSync(common,fs.readFileSync(common,'utf8').replace('bridge_pid() { return 1; }','bridge_pid() { return 0; }'));
  const hook=path.join(f.root,'local-health.cjs');fs.writeFileSync(hook,`const http=require('node:http'),events=require('node:events');http.get=(options,callback)=>{if(options.hostname!=='127.0.0.1'||options.path!=='/health'||options.agent!==false)throw new Error('not a literal local health check');const req=new events.EventEmitter();req.destroy=()=>{};process.nextTick(()=>{const res=new events.EventEmitter();res.statusCode=200;callback(res);res.emit('data',Buffer.from('{"status":"ok"}'));res.emit('end');});return req;};`);
  const r=f.run('gui-configure',input,{env:{NODE_OPTIONS:'--require='+hook}}),v=result(r);assert.equal(v.localReady,true);assert.equal('localError'in v,false);
  const before=snapshot(f.home),status=result(f.run('gui-status',undefined,{env:{NODE_OPTIONS:'--require='+hook}}));assert.equal(status.localReady,true);assert.deepEqual(snapshot(f.home),before);assert(!r.stdout.includes(upstreamKey));
}));

function models(f,body,options={}){
  // Test-only module stub: exercise the actual stdin/dispatch/old-key resolver without network.
  const hook=path.join(f.root,'models-stub.cjs');
  fs.writeFileSync(hook,`const Module=require('node:module'),load=Module._load;
Module._load=function(name,parent){if(name==='./gui-models.cjs'&&parent.filename===${JSON.stringify(path.join(f.kit,'installer.cjs'))})return {async listModels(input,{resolveSavedKey}){
  const key=input.apiKey||await resolveSavedKey(input.endpoint);
  if(key!==${JSON.stringify(upstreamKey)})throw Object.assign(new Error('must not echo '+key),{guiCode:'MODELS_AUTH'});
  return {schema:1,id:'openai-bridge',models:[{id:'fixture-listed-model'}],truncated:false};
}};return load.apply(this,arguments);};`);
  return f.run('gui-models',body,{...options,env:{NODE_OPTIONS:'--require='+hook,...options.env}});
}

test('GUI models accepts endpoint/key only and never installs, probes health or writes state',()=>fixture(f=>{
  const before=snapshot(f.home),r=models(f,{endpoint:input.endpoint,apiKey:upstreamKey});
  assert.deepEqual(result(r),{schema:1,id:'openai-bridge',models:[{id:'fixture-listed-model'}],truncated:false});
  assert.deepEqual(snapshot(f.home),before);assert(!r.stdout.includes(upstreamKey));
  for(const body of [null,[],{...input},{endpoint:input.endpoint,apiKey:upstreamKey,consent:true},{endpoint:'http://unsafe.invalid/v1',apiKey:upstreamKey},{endpoint:input.endpoint,apiKey:'bad\nkey'},'x'.repeat(17000)]){
    const bad=models(f,body);assert.equal(bad.status,1,bad.stdout+bad.stderr);
    assert.equal(JSON.parse(bad.stderr).error.code,'INVALID_INPUT');assert.deepEqual(snapshot(f.home),before);
  }
  const argv=models(f,{endpoint:input.endpoint,apiKey:upstreamKey},{args:['--key',upstreamKey]});
  assert.equal(argv.status,1);assert.equal(JSON.parse(argv.stderr).error.code,'INVALID_INPUT');assert(!argv.stderr.includes(upstreamKey));
}));

test('GUI models blank key only reuses a healthy same-origin GUI secret without health or writes',()=>fixture(f=>{
  saved(f);const before=snapshot(f.home),r=models(f,{endpoint:'https://api.example.invalid/another/chat/completions'});
  assert.equal(result(r).models[0].id,'fixture-listed-model');assert.deepEqual(snapshot(f.home),before);
  assert(!r.stdout.includes(upstreamKey));assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
  for(const endpoint of ['https://other.example.invalid/v1','https://api.example.invalid:8443/v1']){
    const denied=models(f,{endpoint});assert.equal(denied.status,1);
    assert.equal(JSON.parse(denied.stderr).error.code,'KEY_HOST_CHANGED');assert.deepEqual(snapshot(f.home),before);
  }
}));

test('GUI models blank key rejects missing/manual/tampered runtime without any state changes',()=>{
  fixture(f=>{const before=snapshot(f.home),r=models(f,{endpoint:input.endpoint});assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).error.code,'KEY_REQUIRED');assert.deepEqual(snapshot(f.home),before);});
  for(const mutate of [
    f=>{const file=path.join(f.target,'.ccr-bridge-kit.json'),m=JSON.parse(fs.readFileSync(file));delete m.guiManaged;write(file,m);},
    f=>fs.appendFileSync(path.join(f.target,'bridge-common.sh'),'# user edit\n'),
    f=>{const reg=JSON.parse(fs.readFileSync(f.registry));reg.instanceId='f'.repeat(32);write(f.registry,reg);}
  ])fixture(f=>{saved(f);mutate(f);const before=snapshot(f.home),r=models(f,{endpoint:input.endpoint});assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).error.code,'RUNTIME_CONFLICT');assert.deepEqual(snapshot(f.home),before);assert(!r.stderr.includes(upstreamKey));});
});

function race(f,phase,change,body={...input,model:'fixture-model-changed'}){
  const hook=path.join(f.root,'gui-race.cjs');
  fs.writeFileSync(hook,`'use strict';const fs=require('node:fs'),cp=require('node:child_process');
const target=${JSON.stringify(f.target)},registry=${JSON.stringify(f.registry)},home=${JSON.stringify(f.home)},marker=target+'/.ccr-bridge-kit.json',configFile=target+'/runtime-home/.claude-code-router/config.json',connectionFile=target+'/connection.json';
const original=cp.spawnSync;let changed=false;const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v)+'\\n');
cp.spawnSync=function(bin,args,options){const r=original.apply(this,arguments);
if(!changed&&(${phase==='lock'?"bin==='flock'&&args[0]==='-w'&&args[1]==='5'":phase==='stop'?"bin==='flock'&&args[0]==='-w'&&args[1]==='10'&&fs.existsSync(target+'/runtime-home/.claude-code-router/service.lock')":"bin===process.execPath&&args[0].endsWith('/patch-ccr.js')"})){changed=true;${change}}
return r;};`);
  return f.run('gui-configure',body,{env:{NODE_OPTIONS:'--require='+hook}});
}

test('GUI rechecks registration after taking shared lock before any disabled/stop/config write',()=>fixture(f=>{
  saved(f);const beforeConfig=fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json')),beforeConnection=fs.readFileSync(path.join(f.target,'connection.json'));
  const r=race(f,'lock',"const v=JSON.parse(fs.readFileSync(registry));v.instanceId='2'.repeat(32);save(registry,v);");
  assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(JSON.parse(r.stderr).error.code,'RUNTIME_CONFLICT');
  assert.equal(JSON.parse(fs.readFileSync(f.registry)).instanceId,'2'.repeat(32));
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
  assert.deepEqual(fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json')),beforeConfig);assert.deepEqual(fs.readFileSync(path.join(f.target,'connection.json')),beforeConnection);
}));

test('GUI refuses stale blank-key retention if private config changed while waiting for lock',()=>fixture(f=>{
  saved(f);const r=race(f,'lock',"const v=JSON.parse(fs.readFileSync(configFile));v.Providers[0].api_key='fixture-concurrent-key';save(configFile,v);",{...input,apiKey:'',model:'changed'});
  assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(config(f).Providers[0].api_key,'fixture-concurrent-key');
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
}));

test('GUI checks registration again after stopping and never writes a replacement instance config',()=>fixture(f=>{
  saved(f);const before=fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json'));
  const r=race(f,'stop',"const v=JSON.parse(fs.readFileSync(registry));v.instanceId='2'.repeat(32);save(registry,v);");
  assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(JSON.parse(fs.readFileSync(f.registry)).instanceId,'2'.repeat(32));
  assert.deepEqual(fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json')),before);
  assert.equal(fs.readFileSync(path.join(f.target,'disabled'),'utf8'),'configuring\n');
  assert.equal(fs.readFileSync(path.join(f.target,'start-called'),'utf8'),'start\n');
}));

test('GUI stop failure rolls back own config and clears only its temporary tombstone',()=>fixture(f=>{
  saved(f);const beforeConfig=fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json')),beforeConnection=fs.readFileSync(path.join(f.target,'connection.json'));
  const r=race(f,'stop','r.status=1;');assert.equal(r.status,1,r.stdout+r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.target,'runtime-home/.claude-code-router/config.json')),beforeConfig);assert.deepEqual(fs.readFileSync(path.join(f.target,'connection.json')),beforeConnection);
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
}));

test('GUI first install does not deploy if another registration appears during bundle patch',()=>fixture(f=>{
  const r=race(f,'patch',"save(registry,{schema:1,id:'openai-bridge',endpoint:'http://127.0.0.1:34599',runtimeDir:home+'/foreign',instanceId:'2'.repeat(32)});",input);
  assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(JSON.parse(r.stderr).error.code,'RUNTIME_CONFLICT');
  assert.equal(fs.existsSync(f.target),false);assert.equal(fs.existsSync(f.settings),false);
  assert.equal(JSON.parse(fs.readFileSync(f.registry)).instanceId,'2'.repeat(32));
  const share=path.join(f.home,'.local/share');assert.equal(fs.readdirSync(share).some(v=>v.startsWith('.ccr-kit-stage-')),false);
}));

for(const [name,existing,text,removed] of [
  ['new temporary disabled marker',false,'component removed or disabled\n',true],
  ['existing recovery exhaustion',true,'recovery limit reached\n',false],
  ['new unrelated recovery fault',false,'patch verification failed\n',false]
])test('GUI edit preserves recovery budget and handles '+name,()=>fixture(f=>{
  saved(f);const fault=path.join(f.target,'runtime-home/.claude-code-router/recovery.failed');
  if(existing)fs.writeFileSync(fault,text);
  const attempts=path.join(f.target,'runtime-home/.claude-code-router/recovery.attempts');fs.writeFileSync(attempts,'2\n');
  const r=race(f,'stop',`fs.writeFileSync(target+'/runtime-home/.claude-code-router/recovery.failed',${JSON.stringify(text)});`);
  const v=result(r);assert.equal(v.configured,true);assert.equal(v.localReady,false);
  assert.equal(fs.existsSync(fault),!removed);if(!removed)assert.equal(fs.readFileSync(fault,'utf8'),text);
  assert.equal(fs.readFileSync(attempts,'utf8'),'2\n');assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
}));
