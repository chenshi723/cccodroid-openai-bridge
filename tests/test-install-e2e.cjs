#!/usr/bin/env node
// 完整联网依赖安装测试：只访问 npm 和本机假上游，HOME/设置/端口全部隔离。
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const net=require('node:net');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const sourceKit=process.env.OPENAI_BRIDGE_TEST_SOURCE?path.resolve(process.env.OPENAI_BRIDGE_TEST_SOURCE):path.resolve(__dirname,'..');
let kit=sourceKit;
const bundled=process.argv.includes('--bundled');
let testEnv;
function exec(args,opts={}){
  if(bundled){
    const [action,...rest]=args;
    return command(process.execPath,[path.join(kit,'component.cjs'),action==='install'?'configure':action,...rest],opts);
  }
  return command(process.execPath,[path.join(kit,'installer.cjs'),...args],opts);
}
function command(bin,args,opts={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{...opts,detached:true,env:{...testEnv,...opts.env}});
    let stdout='',stderr='',timedOut=false;
    p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
    const timer=setTimeout(()=>{timedOut=true;try{process.kill(-p.pid,'SIGKILL');}catch{p.kill('SIGKILL');}},360000);
    p.once('error',e=>{clearTimeout(timer);reject(e);});
    p.once('close',(status,signal)=>{
      clearTimeout(timer);
      if(timedOut)return reject(Error('installer timed out: '+JSON.stringify({status,signal})+'\n'+stderr));
      if(signal)return reject(Error('installer terminated by '+signal+'\n'+stderr));
      resolve({status,signal,timedOut,stdout,stderr});
    });
  });
}
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
(async()=>{
  const sourceCli=path.join(sourceKit,'node_modules/@musistudio/claude-code-router/dist/cli.js');
  const sourceBytes=fs.readFileSync(sourceCli),sourceStat=fs.statSync(sourceCli);
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kit-e2e-')));
  const home=path.join(tmp,'client-home');fs.mkdirSync(home);
  const allowed=new Set(['PATH','PREFIX','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD','LD_LIBRARY_PATH','SSL_CERT_FILE','SSL_CERT_DIR','TERMUX_APP__DATA_DIR']);
  testEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k)));
  Object.assign(testEnv,{HOME:home,NPM_CONFIG_USERCONFIG:path.join(home,'no-npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(home,'no-global-npmrc'),NPM_CONFIG_CACHE:path.join(home,'.npm'),CCR_BRIDGE_START_TIMEOUT:'30'});
  kit=path.join(tmp,'component-source');fs.mkdirSync(kit);
  for(const file of ['installer.cjs','component.cjs','package.json','package-lock.json','LICENSE','LICENSE-CCR.txt','README.md']){
    const from=path.join(sourceKit,file);if(fs.existsSync(from))fs.copyFileSync(from,path.join(kit,file));
  }
  fs.cpSync(path.join(sourceKit,'runtime'),path.join(kit,'runtime'),{recursive:true});
  if(bundled)fs.cpSync(path.join(sourceKit,'node_modules'),path.join(kit,'node_modules'),{recursive:true,verbatimSymlinks:true});
  const target=path.join(tmp,"bridge with quote's");
  const settings=path.join(tmp,'settings.json');
  const cfg=path.join(tmp,'private-config.json');
  const original={env:{KEEP:'value'},hooks:{SessionStart:[{matcher:'startup',hooks:[{type:'command',command:'printf keep-existing'}]}],Stop:[{hooks:[{type:'command',command:'printf keep-stop'}]}]}};
  fs.writeFileSync(settings,JSON.stringify(original));
  const models=['test-model','test-nondefault','Org/Model-X','claude-haiku-explicit'],routedModels=[];
  const secondModels=['second-model','test-model'],secondRouted=[];
  const exposed=[...models,'second-model','relay-2/test-model'];
  const upstream=http.createServer((req,res)=>{
    let data='';req.on('data',b=>data+=b);req.on('end',()=>{
      const body=JSON.parse(data);routedModels.push(body.model);
      assert(models.includes(body.model),'only configured models reach the loopback fixture');
      assert.equal(req.headers.authorization,'Bearer test-upstream-only');
      const result={id:'test-id',model:body.model,choices:[{index:0,message:{role:'assistant',content:'KIT_LOCAL_TEST_OK'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    });
  });
  const secondary=http.createServer((req,res)=>{
    let data='';req.on('data',b=>data+=b);req.on('end',()=>{
      const body=JSON.parse(data);secondRouted.push(body.model);
      assert(secondModels.includes(body.model),'only secondary models reach the second fixture');
      assert.equal(req.headers.authorization,'Bearer test-upstream-two-only');
      const result={id:'test-id-two',model:body.model,choices:[{index:0,message:{role:'assistant',content:'KIT_SECOND_TEST_OK'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    });
  });
  try{
    const upPort=await listen(upstream),upPort2=await listen(secondary);
    const probe=net.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r));
    const providers=[{endpoint:`http://127.0.0.1:${upPort2}/v1/chat/completions`,apiKey:'test-upstream-two-only',model:'second-model',models:secondModels}];
    fs.writeFileSync(cfg,JSON.stringify({endpoint:`http://127.0.0.1:${upPort}/v1/chat/completions`,apiKey:'test-upstream-only',model:'test-model',models,providers,port}),{mode:0o600});
    let r=await exec(['install','--dir',target,'--settings',settings,'--config',cfg,'--yes']);
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
    assert(!r.stdout.includes('test-upstream-only'));assert(!r.stdout.includes('test-upstream-two-only'));
    console.log('PASS fresh '+(bundled?'bundled offline-copy':'npm-ci')+' install, patch, hook and startup with spaces/apostrophe in path');
    const connection=JSON.parse(fs.readFileSync(path.join(target,'connection.json')));
    assert.equal(connection.model,'test-model');assert.deepEqual(connection.models,exposed);assert(connection.apiKey.length>=40);
    assert(!r.stdout.includes(connection.apiKey));
    const state=path.join(target,'runtime-home','.claude-code-router');
    const config=JSON.parse(fs.readFileSync(path.join(state,'config.json')));
    assert.equal(config.Providers.length,2);
    assert.equal(config.Providers[0].api_key,'test-upstream-only');assert.deepEqual(config.Providers[0].models,models);assert.equal(config.Router.default,'relay,test-model');
    assert.equal(config.Providers[1].name,'relay-2');assert.equal(config.Providers[1].api_key,'test-upstream-two-only');assert.deepEqual(config.Providers[1].models,secondModels);
    assert.deepEqual(config.MODEL_ROUTES,{
      'test-model':'relay,test-model','test-nondefault':'relay,test-nondefault','Org/Model-X':'relay,Org/Model-X',
      'claude-haiku-explicit':'relay,claude-haiku-explicit','second-model':'relay-2,second-model','relay-2/test-model':'relay-2,test-model'
    });
    assert.equal(fs.statSync(path.join(state,'config.json')).mode&0o777,0o600);
    assert.equal(fs.statSync(path.join(target,'connection.json')).mode&0o777,0o600);
    const merged=JSON.parse(fs.readFileSync(settings));
    assert.deepEqual(merged.env,original.env);assert.deepEqual(merged.hooks.Stop,original.hooks.Stop);
    assert.deepEqual(merged.hooks.SessionStart[0],original.hooks.SessionStart[0]);
    assert.equal(merged.hooks.SessionStart.length,2);
    assert.equal(merged.hooks.SessionStart[1].matcher,'startup|resume');
    assert.match(merged.hooks.SessionStart[1].hooks[0].command,/start-bridge\.sh' --hook$/);
    console.log('PASS private generated key/config, unrelated settings preserved');
    const serviceFile=path.join(home,'.cccodroid/services/openai-bridge.json');
    let service;
    if(bundled){
      service=JSON.parse(fs.readFileSync(serviceFile,'utf8'));
      assert.equal(service.endpoint,connection.baseUrl);assert.equal(service.runtimeDir,target);
      assert.equal(Object.keys(service).length,5);assert.match(service.instanceId,/^[0-9a-f]{32}$/);
      assert.equal(fs.statSync(serviceFile).mode&0o777,0o600);
    }else assert.equal(fs.existsSync(serviceFile),false);
    for(const url of ['', 'https://api.anthropic.com', connection.baseUrl+'@elsewhere.invalid', connection.baseUrl+'.evil.invalid']){
      const foreign=await command('bash',[path.join(target,'start-bridge.sh'),'--hook'],{env:{...testEnv,ANTHROPIC_BASE_URL:url}});
      assert.equal(foreign.status,0,foreign.stderr);
      assert.equal(fs.existsSync(path.join(state,'watchdog.pid')),false);
      assert.equal(fs.existsSync(path.join(state,'.claude-code-router.pid')),false);
    }
    console.log('PASS foreign/empty endpoint cold Hooks do not start any bridge or watchdog');
    if(bundled){
      const ensure=['ensure','--dir',target,'--endpoint',service.endpoint,'--instance',service.instanceId];
      const bad=await exec([...ensure.slice(0,-1),'0'.repeat(32)]);
      assert.notEqual(bad.status,0);assert.equal(fs.existsSync(path.join(state,'watchdog.pid')),false);
      const results=await Promise.all(Array.from({length:4},()=>exec(ensure)));
      for(const rr of results){assert.equal(rr.status,0,rr.stderr);assert.deepEqual(JSON.parse(rr.stdout),{schema:1,id:'openai-bridge',ready:true,endpoint:service.endpoint,instanceId:service.instanceId});}
      assert.equal((await fetch(connection.baseUrl+'/health')).status,200);
      // Identity failures must precede every destructive action, including --purge.
      const protectedFiles=[serviceFile,settings,path.join(target,'connection.json'),path.join(state,'watchdog.pid'),path.join(state,'.claude-code-router.pid')];
      const protectedBytes=protectedFiles.map(file=>fs.readFileSync(file));
      const invalidIdentities=[
        ['--endpoint',service.endpoint,'--instance','0'.repeat(32)],
        ['--endpoint',service.endpoint+'/v1','--instance',service.instanceId],
        ['--endpoint','http://127.0.0.1:'+(new URL(service.endpoint).port==='65535'?65534:65535),'--instance',service.instanceId],
        ['--endpoint',service.endpoint],
        ['--instance',service.instanceId],
        ['--endpoint',service.endpoint,'--instance','0'.repeat(32),'--purge'],
      ];
      for(const identity of invalidIdentities){
        const denied=await exec(['uninstall','--dir',target,'--yes',...identity]);
        assert.notEqual(denied.status,0,'uninstall must reject '+JSON.stringify(identity));
        assert.equal(fs.existsSync(path.join(target,'disabled')),false,'bad identity must not disable runtime');
        for(let i=0;i<protectedFiles.length;i++)assert.deepEqual(fs.readFileSync(protectedFiles[i]),protectedBytes[i],'bad identity changed '+protectedFiles[i]);
        assert.equal((await fetch(connection.baseUrl+'/health',{signal:AbortSignal.timeout(1000)})).status,200,'bad identity must not stop service');
      }
      console.log('PASS uninstall rejects wrong/partial identity before disabled marker, stop, hook edit, registry removal or purge');
      r=await exec(['stop','--dir',target,'--yes']);assert.equal(r.status,0,r.stderr);
      assert.equal(await fetch(connection.baseUrl+'/health').then(()=>true,()=>false),false);
      fs.writeFileSync(path.join(state,'recovery.failed'),'fixture fault\n');
      const faulted=await exec(ensure);assert.notEqual(faulted.status,0);
      r=await exec(['start','--dir',target,'--reset-recovery','--yes']);assert.equal(r.status,0,r.stderr);
      assert.equal(fs.existsSync(path.join(state,'recovery.failed')),false);
      r=await exec(['stop','--dir',target,'--yes']);assert.equal(r.status,0,r.stderr);
      console.log('PASS registered ensure rejects wrong instance, waits for concurrent cold start and requires explicit recovery reset');
    }
    const started=Date.now();
    const appBaseUrl='http://127.0.0.1:45000/u/'+'0'.repeat(32)+'/'+Buffer.from(connection.baseUrl+'/v1').toString('base64url');
    r=await command('bash',[path.join(target,'start-bridge.sh'),'--hook'],{env:{...testEnv,ANTHROPIC_BASE_URL:appBaseUrl}});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.ok(Date.now()-started<3000,'Hook must not wait for readiness');
    let ready=false;
    for(let i=0;i<100;i++){
      ready=await fetch(connection.baseUrl+'/health',{signal:AbortSignal.timeout(300)}).then(r=>r.ok,()=>false);
      if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,'real CCR did not become ready after cold Hook');
    console.log('PASS App-streamfix-wrapped cold Hook returns promptly and real patched CCR starts asynchronously');
    const response=await fetch(connection.baseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':connection.apiKey},body:JSON.stringify({model:'test-model',max_tokens:32,stream:true,messages:[{role:'user',content:'local test'}]})});
    const body=await response.text();
    assert.equal(response.status,200,body);assert(body.includes('KIT_LOCAL_TEST_OK'),body);assert(body.includes('message_stop'));
    assert.deepEqual(routedModels,['test-model']);
    console.log('PASS installed real bridge routes local upstream JSON into client SSE');
    for(const [model,extra,expected] of [
      ['test-nondefault',{},'test-nondefault'],
      ['Org/Model-X',{thinking:{type:'adaptive'},output_config:{effort:'high'}},'Org/Model-X'],
      ['claude-haiku-explicit',{},'claude-haiku-explicit'],
      ['relay,test-nondefault',{},'test-nondefault'],
      ['unconfigured-model',{},'test-model']
    ]){
      const response=await fetch(connection.baseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':connection.apiKey},signal:AbortSignal.timeout(10000),body:JSON.stringify({model,max_tokens:32,stream:false,messages:[{role:'user',content:'local route test'}],...extra})});
      const text=await response.text();assert.equal(response.status,200,text);
      assert.equal(JSON.parse(text).model,expected);assert.equal(routedModels.at(-1),expected,'actual loopback upstream receives the selected ID, not the default');
    }
    assert.deepEqual(routedModels,['test-model','test-nondefault','Org/Model-X','claude-haiku-explicit','test-nondefault','test-model']);
    console.log('PASS actual patched CCR forwards bare non-default, mixed-case, thinking and haiku IDs; legacy comma route and unknown-ID default remain compatible');
    const primaryRouted=[...routedModels];
    for(const [model,expected] of [['second-model','second-model'],['relay-2/test-model','test-model']]){
      const response=await fetch(connection.baseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':connection.apiKey},signal:AbortSignal.timeout(10000),body:JSON.stringify({model,max_tokens:32,stream:false,messages:[{role:'user',content:'second upstream route test'}]})});
      const text=await response.text();assert.equal(response.status,200,text);
      assert.equal(JSON.parse(text).model,expected);
    }
    assert.deepEqual(secondRouted,['second-model','test-model']);
    assert.deepEqual(routedModels,primaryRouted,'secondary traffic must not reach the primary upstream');
    console.log('PASS second upstream receives only its own models and API key');
    const before=fs.readFileSync(path.join(state,'.claude-code-router.pid'),'utf8');
    r=await exec(['install','--dir',target,'--settings',settings,'--yes','--start']);
    assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(settings)),merged);
    assert.equal(fs.readFileSync(path.join(state,'.claude-code-router.pid'),'utf8'),before);
    console.log('PASS repeat install is idempotent and does not restart bridge');
    r=await command('bash',[path.join(target,'status.sh')]);assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('正常'));assert(!r.stdout.includes(connection.apiKey));
    console.log('PASS installed status wrapper works and keeps keys hidden');
    r=await exec(['install','--dir',target,'--settings',settings,'--config',cfg,'--yes']);assert.notEqual(r.status,0);assert(r.stderr.includes('不会覆盖'));
    const startScript=path.join(target,'start-bridge.sh'),startBytes=fs.readFileSync(startScript);
    fs.appendFileSync(startScript,'\n# user edit\n');
    r=await exec(['install','--dir',target,'--settings',settings,'--yes']);assert.notEqual(r.status,0);assert(r.stderr.includes('被修改'));
    console.log('PASS installer rejects configuration overwrite and modified scripts');
    // Restore only this disposable fixture so valid scoped uninstall also proves
    // the manager's integrity checks rather than failing on our mutation above.
    fs.writeFileSync(startScript,startBytes);
    if(bundled){
      r=await exec(['uninstall','--dir',target,'--yes','--endpoint',service.endpoint,'--instance',service.instanceId]);
      assert.equal(r.status,0,r.stderr);
      console.log('PASS fixed component entry accepts matching endpoint/instance uninstall');
    }
    // The legacy, unscoped private wrapper remains a supported manual cleanup.
    r=await command('bash',[path.join(target,'uninstall.sh'),'--yes']);
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings)),original);
    assert(fs.existsSync(path.join(target,'connection.json')));
    assert(fs.existsSync(path.join(target,'disabled')));
    if(bundled){
      assert.equal(fs.existsSync(serviceFile),false);
      const denied=await exec(['ensure','--dir',target,'--endpoint',service.endpoint,'--instance',service.instanceId]);assert.notEqual(denied.status,0);
    }
    const health=await fetch(connection.baseUrl+'/health').then(()=>true,()=>false);assert.equal(health,false);
    console.log('PASS uninstall stops only isolated runtime, removes own hook, preserves data');
    // Simulate App removing the component entry while leaving the private runtime and Hook.
    const manifest=JSON.parse(fs.readFileSync(path.join(target,'.ccr-bridge-kit.json')));
    const componentEntry=path.join(kit,'component.cjs'), removedEntry=componentEntry+'.removed-for-test';
    assert.equal(manifest.componentEntry,componentEntry);
    fs.renameSync(componentEntry,removedEntry);
    try{
      r=await command('bash',[path.join(target,'start-bridge.sh'),'--hook'],{env:{...testEnv,ANTHROPIC_BASE_URL:connection.baseUrl}});
      assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
      assert.match(fs.readFileSync(path.join(state,'start.log'),'utf8'),/组件已卸载|入口不存在/);
      assert.equal(await fetch(connection.baseUrl+'/health').then(()=>true,()=>false),false);
    }finally{fs.renameSync(removedEntry,componentEntry);}
    console.log('PASS removed component entry prevents private runtime auto-start and logs cleanup hint');
    r=await exec(['uninstall','--dir',target,'--yes','--purge']);
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
    assert.equal(fs.existsSync(target),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings)),original);
    console.log('PASS explicit purge removes private runtime/dependencies/keys/logs, leaves unrelated hooks intact');
    const unknown=path.join(tmp,'not-owned');fs.mkdirSync(unknown);fs.writeFileSync(path.join(unknown,'keep'),'user-data');
    r=await exec(['install','--dir',unknown,'--settings',settings,'--config',cfg,'--yes']);assert.notEqual(r.status,0);assert(r.stderr.includes('不是由本安装器'),r.stderr);
    assert.equal(fs.readFileSync(path.join(unknown,'keep'),'utf8'),'user-data');
    console.log('PASS non-owned directory is not overwritten');
    assert.deepEqual(fs.readFileSync(sourceCli),sourceBytes);
    assert.equal(fs.statSync(sourceCli).ino,sourceStat.ino);
    assert.equal(fs.statSync(sourceCli).mtimeMs,sourceStat.mtimeMs);
    console.log('PASS source dependency bytes, inode and mtime remain unchanged');
  }finally{
    let cleanupError;
    // A failed install assertion can still leave a runtime; use only its own
    // manager, even when normal component uninstall already removed its entry.
    const manager=path.join(target,'manage.cjs');
    if(fs.existsSync(manager)){
      const r=await command(process.execPath,[manager,'uninstall','--dir',target,'--yes','--purge']);
      if(r.status!==0)cleanupError=Error('fixture cleanup failed: '+JSON.stringify({status:r.status,signal:r.signal,timedOut:r.timedOut})+' '+r.stderr);
    }
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    secondary.closeAllConnections();await new Promise(r=>secondary.close(r));
    if(cleanupError)throw cleanupError;
    // 所有进程已停止，清理只属于本测试的临时目录。
    fs.rmSync(tmp,{recursive:true,force:true});
  }
  console.log('PASS all installer end-to-end checks and fixture cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
