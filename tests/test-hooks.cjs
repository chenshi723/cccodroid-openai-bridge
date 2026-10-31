#!/usr/bin/env node
// 只用临时副本、假 CCR 和随机回环端口；不读取真实设置、密钥或运行进程的配置。
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wrapped=(url,key='0'.repeat(32))=>'http://127.0.0.1:45000/u/'+(key?key+'/':'')+Buffer.from(url).toString('base64url');
let passed=0;
function run(bin,args,env,limit=5000){
  return new Promise((resolve,reject)=>{
    const started=Date.now(),child=spawn(bin,args,{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('isolated command timed out'));},limit);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr,ms:Date.now()-started});});
  });
}
async function until(check,label,limit=5000){
  const end=Date.now()+limit;
  while(Date.now()<end){if(await check())return;await sleep(50);}
  throw new Error('Timeout: '+label);
}
async function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-hooks-'));
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const state=path.join(dir,'runtime-home/.claude-code-router');
  fs.mkdirSync(state,{recursive:true});
  for(const file of ['start-bridge.sh','bridge-common.sh','watchdog.sh','health.cjs'])fs.copyFileSync(path.join(root,'runtime',file),path.join(dir,file));
  const cli=path.join(dir,'node_modules/@musistudio/claude-code-router/dist/cli.js');
  fs.mkdirSync(path.dirname(cli),{recursive:true});
  fs.writeFileSync(cli,String.raw`const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const state=path.join(process.env.HOME,'.claude-code-router');
fs.writeFileSync(path.join(state,'.claude-code-router.pid'),String(process.pid));
fs.appendFileSync(path.join(state,'fake-starts'),'start\n');
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}));});
server.listen(Number(process.env.SERVICE_PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
  fs.writeFileSync(path.join(dir,'patch-ccr.js'),String.raw`const fs=require('node:fs');fs.appendFileSync(__dirname+'/patch-runs','patch\n');setTimeout(()=>process.exit(0),Number(process.env.HOOK_TEST_PATCH_DELAY||0));`);
  const entry=path.join(dir,'component-source/component.cjs');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'// fake component entry');
  fs.writeFileSync(path.join(dir,'port'),String(port));
  fs.writeFileSync(path.join(dir,'.ccr-bridge-kit.json'),JSON.stringify({id:'ccr-bridge-kit',target:dir,componentEntry:entry}));
  const env={...process.env,HOME:path.join(dir,'client-home'),CCR_BRIDGE_INTERVAL:'0.2',CCR_BRIDGE_GRACE:'0',CCR_BRIDGE_FAIL_LIMIT:'1',CCR_BRIDGE_START_TIMEOUT:'5',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+port};
  for(const name of ['CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','SERVICE_PORT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[name];
  const healthy=()=>fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(200)}).then(r=>r.ok,()=>false);
  const hook=more=>run('bash',[path.join(dir,'start-bridge.sh'),'--hook'],{...env,...more});
  const alive=(file,script)=>{
    try{const pid=Number(fs.readFileSync(path.join(state,file),'utf8'));const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');return args[1]===script?pid:null;}catch{return null;}
  };
  const clean=async()=>{
    for(const [file,script] of [['watchdog.pid',path.join(dir,'watchdog.sh')],['.claude-code-router.pid',cli]]){
      const pid=alive(file,script);if(!pid)continue;
      try{process.kill(pid,'SIGTERM');}catch{}
      for(let i=0;i<30&&alive(file,script);i++)await sleep(50);
      if(alive(file,script)){try{process.kill(pid,'SIGKILL');}catch{}}
      await until(()=>!alive(file,script),'fixture process cleanup');
    }
    fs.rmSync(dir,{recursive:true,force:true});
  };
  return {dir,state,port,env,entry,cli,healthy,hook,alive,clean};
}
async function test(name,body){
  const f=await fixture();
  try{await body(f);passed++;console.log('PASS hook '+passed+': '+name);}catch(error){for(const file of ['bridge.out','start.log']){const log=path.join(f.state,file);if(fs.existsSync(log))console.error(file+': '+fs.readFileSync(log,'utf8'));}throw error;}finally{await f.clean();}
}
(async()=>{
  await test('unrelated URLs skip before Node, logs, patching or locks',async f=>{
    const sentinel=path.join(f.dir,'no-node');fs.mkdirSync(sentinel);
    const bash=process.env.PREFIX?path.join(process.env.PREFIX,'bin/bash'):'/bin/bash';
    const minimal=path.join(f.dir,'minimal');fs.mkdirSync(minimal);
    // dirname is the only external command needed to resolve the script path.
    const result=await run(bash,['-c','command -v dirname'],f.env);
    fs.symlinkSync(result.stdout.trim(),path.join(minimal,'dirname'));
    fs.writeFileSync(path.join(f.dir,'port'),'3459');
    for(const url of ['', 'https://api.anthropic.com', 'http://127.0.0.1:34590', 'http://127.0.0.1:3459@elsewhere.invalid', 'http://127.0.0.1:3459.evil.invalid']){
      const r=await run(bash,[path.join(f.dir,'start-bridge.sh'),'--hook'],{...f.env,PATH:minimal,ANTHROPIC_BASE_URL:url},2000);
      assert.equal(r.status,0,r.stderr);assert.equal(r.stdout+r.stderr,'');
      assert.equal(fs.existsSync(path.join(f.state,'start.log')),false);
      assert.equal(fs.existsSync(path.join(f.dir,'patch-runs')),false);
    }
  });
  await test('matching cold Hook returns while patch verification runs in background',async f=>{
    const r=await f.hook({HOOK_TEST_PATCH_DELAY:'1800'});
    assert.equal(r.status,0,r.stderr);assert.ok(r.ms<1500,'hook blocked '+r.ms+' ms');
    assert.equal(await f.healthy(),false);
    await until(f.healthy,'background CCR ready');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
  });
  await test('the same endpoint with a /v1 path starts exactly one watchdog',async f=>{
    const results=await Promise.all(Array.from({length:4},()=>f.hook({ANTHROPIC_BASE_URL:f.env.ANTHROPIC_BASE_URL+'/v1'})));
    for(const r of results)assert.equal(r.status,0,r.stderr);
    await until(f.healthy,'concurrent Hook ready');await sleep(300);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
  });
  await test('wrapped foreign endpoints and malformed wrappers skip without Node or state',async f=>{
    const bash=process.env.PREFIX?path.join(process.env.PREFIX,'bin/bash'):'/bin/bash';
    const minimal=path.join(f.dir,'minimal');fs.mkdirSync(minimal);
    for(const name of ['dirname','base64']){
      const result=await run(bash,['-c','command -v '+name],f.env);
      fs.symlinkSync(result.stdout.trim(),path.join(minimal,name));
    }
    const base=f.env.ANTHROPIC_BASE_URL;
    const invalid=[
      ...['https://api.anthropic.com',base+'0',base+'@elsewhere.invalid',base+'.evil.invalid',base+'\n',base+'\0',wrapped(base)].map(url=>wrapped(url)),
      wrapped(base).replace('http://127.0.0.1:45000','http://elsewhere.invalid:45000'),
      wrapped(base).replace(':45000/',':0/'),wrapped(base).replace(':45000/',':65536/'),
      wrapped(base).replace('/u/'+ '0'.repeat(32)+'/','/u/not-a-valid-key/'),
      wrapped(base)+'=',wrapped(base)+'/v1',wrapped(base)+'?query',
      'http://127.0.0.1:45000/u/'+'0'.repeat(32)+'/a',
      wrapped(base)+'A'.repeat(8192)
    ];
    for(const url of invalid){
      const r=await run(bash,[path.join(f.dir,'start-bridge.sh'),'--hook'],{...f.env,PATH:minimal,ANTHROPIC_BASE_URL:url},2000);
      assert.equal(r.status,0,r.stderr);assert.equal(r.stdout+r.stderr,'');
      assert.equal(fs.existsSync(path.join(f.state,'start.log')),false);
      assert.equal(fs.existsSync(path.join(f.dir,'patch-runs')),false);
    }
  });
  await test('App streamfix wrapping starts the matching cold bridge asynchronously',async f=>{
    const r=await f.hook({ANTHROPIC_BASE_URL:wrapped(f.env.ANTHROPIC_BASE_URL),HOOK_TEST_PATCH_DELAY:'1800'});
    assert.equal(r.status,0,r.stderr);assert.ok(r.ms<1500,'wrapped Hook blocked '+r.ms+' ms');
    assert.equal(await f.healthy(),false);
    await until(f.healthy,'App-wrapped background CCR ready');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
  });
  for(const [name,url] of [
    ['keyed wrapper with inner trailing slash',base=>wrapped(base+'/')],
    ['keyed wrapper with /v1 and outer trailing slash',base=>wrapped(base+'/v1')+'/'],
    ['legacy unkeyed wrapper',base=>wrapped(base,null)]
  ]){
    await test(name+' starts its own cold bridge',async f=>{
      assert.equal(await f.healthy(),false);
      const r=await f.hook({ANTHROPIC_BASE_URL:url(f.env.ANTHROPIC_BASE_URL)});
      assert.equal(r.status,0,r.stderr);
      await until(f.healthy,name+' cold dispatch');
      assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
    });
  }
  await test('wrapped paths and legacy unkeyed wrappers retain single-instance dispatch',async f=>{
    const urls=[wrapped(f.env.ANTHROPIC_BASE_URL+'/'),wrapped(f.env.ANTHROPIC_BASE_URL+'/v1')+'/',wrapped(f.env.ANTHROPIC_BASE_URL,null)];
    const results=await Promise.all(urls.map(url=>f.hook({ANTHROPIC_BASE_URL:url})));
    for(const r of results)assert.equal(r.status,0,r.stderr);
    await until(f.healthy,'wrapped concurrent Hook ready');await sleep(300);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
  });
  await test('a held service lock does not block the matching Hook',async f=>{
    const holder=spawn('flock',[path.join(f.state,'service.lock'),'sleep','2'],{env:f.env,stdio:'ignore'});
    try{await sleep(150);const r=await f.hook();assert.equal(r.status,0,r.stderr);assert.ok(r.ms<1500,'hook waited for service lock');assert.equal(await f.healthy(),false);}finally{holder.kill('SIGTERM');}
  });
  await test('port collision leaves Hook fast and never kills the unrelated server',async f=>{
    const server=net.createServer();await new Promise(resolve=>server.listen(f.port,'127.0.0.1',resolve));
    try{const r=await f.hook();assert.equal(r.status,0,r.stderr);assert.ok(r.ms<1500,'hook waited for occupied port');assert.equal(server.listening,true);await sleep(250);}finally{await f.clean();await new Promise(resolve=>server.close(resolve));}
  });
  await test('missing component entry blocks Hook, manual start and direct watchdog',async f=>{
    fs.unlinkSync(f.entry);
    const hook=await f.hook();assert.equal(hook.status,0,hook.stderr);
    const manual=await run('bash',[path.join(f.dir,'start-bridge.sh')],f.env);assert.notEqual(manual.status,0);
    const watch=await run('bash',[path.join(f.dir,'watchdog.sh')],f.env);assert.equal(watch.status,0,watch.stderr);
    assert.match(fs.readFileSync(path.join(f.state,'start.log'),'utf8'),/组件已卸载/);
    assert.equal(fs.existsSync(path.join(f.dir,'patch-runs')),false);assert.equal(await f.healthy(),false);
  });
  await test('invalid manifest fails closed before patching',async f=>{
    fs.writeFileSync(path.join(f.dir,'.ccr-bridge-kit.json'),'{invalid');
    const r=await f.hook();assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(f.dir,'patch-runs')),false);assert.equal(await f.healthy(),false);
  });
  await test('component removed during patch prevents the pending spawn',async f=>{
    const r=await f.hook({HOOK_TEST_PATCH_DELAY:'900'});assert.equal(r.status,0,r.stderr);
    await until(()=>fs.existsSync(path.join(f.dir,'patch-runs')),'patch began');fs.unlinkSync(f.entry);
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'watchdog exits after component removal');
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(await f.healthy(),false);
  });
  await test('running watchdog exits on component removal and cannot restart CCR',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'initial ready');
    const pid=f.alive('.claude-code-router.pid',f.cli);assert.ok(pid);fs.unlinkSync(f.entry);
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'watchdog stops rearming');
    assert.equal(await f.healthy(),true,'active request process should not be forcibly killed');
    process.kill(pid,'SIGTERM');await until(async()=>!await f.healthy(),'fake CCR stopped');
    assert.equal((await f.hook()).status,0);await sleep(400);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
  });
  await test('one unexpected exit recovers without starting duplicate watchdogs',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'initial ready');
    const watch=f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh'));
    process.kill(f.alive('.claude-code-router.pid',f.cli),'SIGTERM');
    await until(()=>fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim().split('\n').length===2,'bounded recovery');
    await until(f.healthy,'recovered CCR ready');
    assert.equal(f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),watch);
    assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('persistent crashes exhaust a durable budget and Hook cannot rearm',async f=>{
    fs.writeFileSync(f.cli,"const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(path.join(process.env.HOME,'.claude-code-router','fake-starts'),'start\\n');process.exitCode=1;\n");
    assert.equal((await f.hook()).status,0);
    await until(()=>fs.existsSync(path.join(f.state,'recovery.failed')),'durable recovery failure');
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'watchdog stopped at limit');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim().split('\n').length,3);
    assert.equal((await f.hook()).status,0);await sleep(500);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim().split('\n').length,3);
    const manual=await run('bash',[path.join(f.dir,'start-bridge.sh')],f.env);
    assert.notEqual(manual.status,0);assert.match(manual.stderr,/恢复达到上限/);
    fs.rmSync(path.join(f.state,'recovery.failed'));
    const restarted=await run('bash',[path.join(f.dir,'watchdog.sh')],f.env);
    assert.notEqual(restarted.status,0);assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),true);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim().split('\n').length,3);
  });
  await test('sustained healthy service replenishes the recovery budget',async f=>{
    assert.equal((await f.hook({CCR_BRIDGE_RECOVERY_STABLE:'1'})).status,0);await until(f.healthy,'stable initial ready');
    await until(()=>!fs.existsSync(path.join(f.state,'recovery.attempts')),'healthy stable budget reset');
    process.kill(f.alive('.claude-code-router.pid',f.cli),'SIGTERM');
    await until(()=>fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim().split('\n').length===2,'recovery after stable reset');
    await until(f.healthy,'stable service recovered');
    assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('persistent patch errors also exhaust the durable budget',async f=>{
    fs.writeFileSync(path.join(f.dir,'patch-ccr.js'),"const fs=require('node:fs');fs.appendFileSync(__dirname+'/patch-runs','patch\\n');process.exitCode=1;\n");
    assert.equal((await f.hook()).status,0);
    await until(()=>fs.existsSync(path.join(f.state,'recovery.failed')),'patch failure budget');
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'watchdog stopped after patch failures');
    assert.equal(fs.readFileSync(path.join(f.dir,'patch-runs'),'utf8').trim().split('\n').length,3);
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);
  });
  await test('uninstalled tombstone blocks retained Hook and direct watchdog',async f=>{
    fs.writeFileSync(path.join(f.dir,'disabled'),'uninstalled\n');
    assert.equal((await f.hook()).status,0);
    const watch=await run('bash',[path.join(f.dir,'watchdog.sh')],f.env);assert.equal(watch.status,0);
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);
    assert.equal(await f.healthy(),false);
  });
  console.log('PASS: '+passed+' isolated Hook lifecycle tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
