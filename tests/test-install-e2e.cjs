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
    const p=spawn(bin,args,{...opts,env:{...testEnv,...opts.env}});
    let stdout='',stderr='';
    p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
    const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('installer timed out'));},360000);
    p.on('error',reject);p.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
  });
}
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
(async()=>{
  const sourceCli=path.join(sourceKit,'node_modules/@musistudio/claude-code-router/dist/cli.js');
  const sourceBytes=fs.readFileSync(sourceCli),sourceStat=fs.statSync(sourceCli);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kit-e2e-'));
  const home=path.join(tmp,'client-home');fs.mkdirSync(home);
  testEnv={...process.env,HOME:home,CCR_BRIDGE_START_TIMEOUT:'30'};
  for(const k of Object.keys(testEnv))if(k.startsWith('CCAPP_')||k.startsWith('ANTHROPIC_')||k.startsWith('CLAUDE_'))delete testEnv[k];
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
  const upstream=http.createServer((req,res)=>{
    let data='';req.on('data',b=>data+=b);req.on('end',()=>{
      const body=JSON.parse(data);
      assert.equal(body.model,'test-model');
      assert.equal(req.headers.authorization,'Bearer test-upstream-only');
      const result={id:'test-id',model:'test-model',choices:[{index:0,message:{role:'assistant',content:'KIT_LOCAL_TEST_OK'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    });
  });
  let installed=false;
  try{
    const upPort=await listen(upstream);
    const probe=net.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r));
    fs.writeFileSync(cfg,JSON.stringify({endpoint:`http://127.0.0.1:${upPort}/v1/chat/completions`,apiKey:'test-upstream-only',model:'test-model',port}),{mode:0o600});
    let r=await exec(['install','--dir',target,'--settings',settings,'--config',cfg,'--yes']);
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);installed=true;
    assert(!r.stdout.includes('test-upstream-only'));
    console.log('PASS fresh '+(bundled?'bundled offline-copy':'npm-ci')+' install, patch, hook and startup with spaces/apostrophe in path');
    const connection=JSON.parse(fs.readFileSync(path.join(target,'connection.json')));
    assert.equal(connection.model,'test-model');assert(connection.apiKey.length>=40);
    assert(!r.stdout.includes(connection.apiKey));
    const state=path.join(target,'runtime-home','.claude-code-router');
    const config=JSON.parse(fs.readFileSync(path.join(state,'config.json')));
    assert.equal(config.Providers[0].api_key,'test-upstream-only');
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
    console.log('PASS installed real bridge routes local upstream JSON into client SSE');
    const before=fs.readFileSync(path.join(state,'.claude-code-router.pid'),'utf8');
    r=await exec(['install','--dir',target,'--settings',settings,'--yes','--start']);
    assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(settings)),merged);
    assert.equal(fs.readFileSync(path.join(state,'.claude-code-router.pid'),'utf8'),before);
    console.log('PASS repeat install is idempotent and does not restart bridge');
    r=await command('bash',[path.join(target,'status.sh')]);assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('正常'));assert(!r.stdout.includes(connection.apiKey));
    console.log('PASS installed status wrapper works and keeps keys hidden');
    r=await exec(['install','--dir',target,'--settings',settings,'--config',cfg,'--yes']);assert.notEqual(r.status,0);assert(r.stderr.includes('不会覆盖'));
    fs.appendFileSync(path.join(target,'start-bridge.sh'),'\n# user edit\n');
    r=await exec(['install','--dir',target,'--settings',settings,'--yes']);assert.notEqual(r.status,0);assert(r.stderr.includes('被修改'));
    console.log('PASS installer rejects configuration overwrite and modified scripts');
    r=await command('bash',[path.join(target,'uninstall.sh'),'--yes']);
    assert.equal(r.status,0,r.stderr);installed=false;
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
    console.log('PASS all installer end-to-end checks');
  }finally{
    if(installed){const r=await exec(['uninstall','--dir',target,'--yes']);if(r.status!==0)console.error('cleanup uninstall failed:',r.stderr);}
    await new Promise(r=>upstream.close(r));
    // 所有进程已停止，清理只属于本测试的临时目录。
    fs.rmSync(tmp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
