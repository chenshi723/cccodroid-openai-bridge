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
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-hooks-')));
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const state=path.join(dir,'runtime-home/.claude-code-router');
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  for(const file of ['start-bridge.sh','bridge-common.sh','watchdog.sh','health.cjs'])fs.copyFileSync(path.join(root,'runtime',file),path.join(dir,file));
  const cli=path.join(dir,'node_modules/@musistudio/claude-code-router/dist/cli.js');
  fs.mkdirSync(path.dirname(cli),{recursive:true});
  fs.writeFileSync(cli,String.raw`const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const state=path.join(process.env.HOME,'.claude-code-router');
fs.writeFileSync(path.join(state,'.claude-code-router.pid'),String(process.pid));
fs.appendFileSync(path.join(state,'fake-starts'),'start\n');
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:fs.existsSync(path.join(state,'fake-unhealthy'))?'not-ok':'ok'}));});
setTimeout(()=>server.listen(Number(process.env.SERVICE_PORT),'127.0.0.1'),Number(process.env.HOOK_TEST_LISTEN_DELAY||0));
process.on('SIGTERM',()=>{fs.appendFileSync(path.join(state,'fake-stops'),String(process.pid)+'\n');const remove=path.join(state,'fake-remove-entry-on-stop');if(fs.existsSync(remove)){fs.unlinkSync(fs.readFileSync(remove,'utf8'));fs.unlinkSync(remove);}server.close(()=>process.exit(0));});
`);
  fs.writeFileSync(path.join(dir,'patch-ccr.js'),String.raw`const fs=require('node:fs');fs.appendFileSync(__dirname+'/patch-runs','patch\n');setTimeout(()=>process.exit(0),Number(process.env.HOOK_TEST_PATCH_DELAY||0));`);
  const entry=path.join(dir,'component-source/component.cjs');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'// fake component entry');
  fs.writeFileSync(path.join(dir,'port'),String(port));
  fs.writeFileSync(path.join(dir,'.ccr-bridge-kit.json'),JSON.stringify({id:'ccr-bridge-kit',target:dir,componentEntry:entry}));
  const env={...process.env,HOME:path.join(dir,'client-home'),CCR_BRIDGE_INTERVAL:'0.2',CCR_BRIDGE_GRACE:'0',CCR_BRIDGE_HEALTH_GRACE:'0',CCR_BRIDGE_FAIL_LIMIT:'1',CCR_BRIDGE_START_TIMEOUT:'5',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+port};
  for(const name of ['CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','SERVICE_PORT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[name];
  const healthy=()=>fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(200)}).then(r=>r.ok,()=>false);
  const hook=more=>run('bash',[path.join(dir,'start-bridge.sh'),'--hook'],{...env,...more});
  const alive=(file,script)=>{
    try{const pid=Number(fs.readFileSync(path.join(state,file),'utf8'));const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');const exe=fs.readlinkSync('/proc/'+pid+'/exe');if(/^\/(?:system|apex\/com\.android\.runtime(?:@[^/]*)?)\/bin\/linker64(?: \(deleted\))?$/.test(exe))args.shift();return args[1]===script?pid:null;}catch{return null;}
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
  if(process.env.HOOK_TEST_FILTER&&!new RegExp(process.env.HOOK_TEST_FILTER).test(name))return;
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
    const watch=await run('bash',[path.join(f.dir,'watchdog.sh')],f.env,15000);assert.equal(watch.status,0,watch.stderr);
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
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'watchdog exits after component removal',15000);
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(await f.healthy(),false);
  });
  await test('running watchdog exits on component removal and cannot restart CCR',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'initial ready');
    const pid=f.alive('.claude-code-router.pid',f.cli);assert.ok(pid);fs.unlinkSync(f.entry);
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'watchdog stops rearming',15000);
    assert.equal(await f.healthy(),true,'active request process should not be forcibly killed');
    process.kill(pid,'SIGTERM');await until(async()=>!await f.healthy(),'fake CCR stopped');
    assert.equal((await f.hook()).status,0);await sleep(400);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.failed'),'utf8'),'component removed or disabled\n');
    const attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');fs.writeFileSync(f.entry,'// reappeared after bounded absence');
    for(let i=0;i<3;i++)assert.equal((await f.hook()).status,0);await sleep(400);
    assert.equal(await f.healthy(),false);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8').trim(),'start');assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
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
  await test('ready bridge gets a separate health grace without spending restart budget',async f=>{
    assert.equal((await f.hook({CCR_BRIDGE_HEALTH_GRACE:'5'})).status,0);await until(f.healthy,'grace initial ready');await sleep(1200);
    const pid=f.alive('.claude-code-router.pid',f.cli),attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');
    fs.writeFileSync(path.join(f.state,'fake-unhealthy'),'brief health outage');await sleep(1400);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.existsSync(path.join(f.state,'fake-stops')),false);
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
    fs.rmSync(path.join(f.state,'fake-unhealthy'));await sleep(700);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
    process.kill(pid,'SIGTERM');await until(()=>fs.readFileSync(path.join(f.state,'fake-starts'),'utf8')==='start\nstart\n','real exit bypasses running health grace');await until(f.healthy,'real exit ready');
  });
  await test('persistent service failure still exhausts budget when local transport works',async f=>{
    assert.equal((await f.hook({CCR_BRIDGE_HEALTH_GRACE:'1'})).status,0);await until(f.healthy,'persistent health ready');await sleep(400);
    fs.writeFileSync(path.join(f.state,'fake-unhealthy'),'persistent service fault');
    await until(()=>fs.existsSync(path.join(f.state,'recovery.failed')),'finite service failure',10000);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\nstart\nstart\n');
  });
  await test('confirmed loopback outage waits without restarts and resumes the same bridge',async f=>{
    // Only the fixture health helper is replaced; its real transport classifier is tested separately.
    fs.writeFileSync(path.join(f.dir,'health.cjs'),`const fs=require('node:fs');process.exitCode=fs.existsSync(__dirname+'/transport-down')?2:0;`);
    assert.equal((await f.hook()).status,0);await until(f.healthy,'transport initial ready');await sleep(400);
    const pid=f.alive('.claude-code-router.pid',f.cli),attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');
    fs.writeFileSync(path.join(f.dir,'transport-down'),'outage');await sleep(1600);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
    assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);assert.equal(fs.existsSync(path.join(f.state,'fake-stops')),false);
    fs.rmSync(path.join(f.dir,'transport-down'));
    await until(()=>fs.readFileSync(path.join(f.state,'bridge.out'),'utf8').includes('local transport and bridge health recovered'),'transport recovery observed');
    assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
    fs.writeFileSync(path.join(f.dir,'transport-down'),'outage again');await sleep(400);
    fs.writeFileSync(path.join(f.dir,'disabled'),'uninstalled\n');
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'disabled during transport wait');
    assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);
  });
  await test('long scheduling gaps invalidate health and failure samples without clearing durable budget',async f=>{
    // Deterministic clock injection: Android ptrace launchers may resume SIGSTOP automatically.
    const text=fs.readFileSync(path.join(root,'runtime/watchdog.sh'),'utf8');
    const begin=text.indexOf('watchdog_healthy() {'),end=text.indexOf('\n# 本机独立回环',begin);
    assert(begin>0&&end>begin);
    const script=text.slice(begin,end)+String.raw`
INTERVAL=5
SECONDS=100
LAST_PROBE=80
FAILURES=2
FAILED_SINCE=50
HEALTHY_SINCE=50
ATTEMPTS=2
BRIDGE_HEALTH_LOG_HEALTHY_SINCE=50
bridge_healthy() { BRIDGE_HEALTH_RC=0; return 0; }
watchdog_healthy || exit 11
[[ $HEALTHY_SINCE = -1 && $FAILED_SINCE = -1 && $FAILURES = 0 && $ATTEMPTS = 2 && $BRIDGE_HEALTH_LOG_HEALTHY_SINCE = -1 ]] || exit 12
SECONDS=200
LAST_PROBE=200
FAILURES=2
FAILED_SINCE=150
HEALTHY_SINCE=150
bridge_healthy() { SECONDS=$((SECONDS+20)); BRIDGE_HEALTH_RC=1; return 1; }
watchdog_healthy && exit 13
[[ $HEALTHY_SINCE = -1 && $FAILED_SINCE = -1 && $FAILURES = 0 && $ATTEMPTS = 2 ]] || exit 14
`;
    const result=await run('bash',['-c',script],f.env);assert.equal(result.status,0,result.stderr);
  });
  await test('persistent crashes exhaust a durable budget and Hook cannot rearm',async f=>{
    fs.writeFileSync(f.cli,"const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(path.join(process.env.HOME,'.claude-code-router','fake-starts'),'start\\n');process.exitCode=1;\n");
    assert.equal((await f.hook()).status,0);
    // 三次独立Node启动在手机调度下可能超过5秒；仍严格断言只消费三次预算。
    await until(()=>fs.existsSync(path.join(f.state,'recovery.failed')),'durable recovery failure',15000);
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
    await until(()=>fs.existsSync(path.join(f.state,'recovery.failed')),'patch failure budget',15000);
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
  await test('entry missing briefly during market update neither locks recovery nor restarts a healthy bridge',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'update initial ready');
    const watch=f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');
    fs.unlinkSync(f.entry);await sleep(800);assert.equal(f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),watch);
    assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
    fs.writeFileSync(f.entry,'// replacement fixed component');await sleep(800);
    assert.equal(f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),watch);assert.equal(await f.healthy(),true);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('entry missing during patch is reconfirmed before touching the existing bridge',async f=>{
    assert.equal((await f.hook({HOOK_TEST_PATCH_DELAY:'900'})).status,0);
    await until(()=>fs.existsSync(path.join(f.dir,'patch-runs')),'update patch began');fs.unlinkSync(f.entry);await sleep(1200);
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
    fs.writeFileSync(f.entry,'// restored fixed component');await until(f.healthy,'update restored ready');assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
  });
  await test('disabled during the missing-entry grace stops promptly without new recovery locks or resurrection',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'disabled update initial ready');
    const attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');
    fs.unlinkSync(f.entry);await sleep(400);fs.writeFileSync(path.join(f.dir,'disabled'),'uninstalled\n');
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'explicit disabled stops waiting');
    fs.writeFileSync(f.entry,'// reappeared after uninstall');assert.equal((await f.hook()).status,0);await sleep(400);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
  });
  await test('manifest identity changing during entry grace fails closed instead of reviving a replacement',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'manifest update initial ready');fs.unlinkSync(f.entry);await sleep(500);
    const file=path.join(f.dir,'.ccr-bridge-kit.json'),m=JSON.parse(fs.readFileSync(file));m.unexpected='replacement';fs.writeFileSync(file,JSON.stringify(m));fs.writeFileSync(f.entry,'// replacement entry');
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'replacement metadata rejected');assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),true);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
  });
  async function patchGap(f,{running=false,patched=0,unhealthy=false}={}){
    if(running){
      assert.equal((await f.hook()).status,0);await until(f.healthy,'gap initial bridge ready');
    }
    fs.writeFileSync(path.join(f.dir,'patch-ccr.js'),`const fs=require('node:fs');fs.appendFileSync(__dirname+'/patch-runs','patch\\n');if(!fs.existsSync(__dirname+'/gap-entered')){fs.unlinkSync(${JSON.stringify(f.entry)});fs.writeFileSync(__dirname+'/gap-entered','ready');}process.exitCode=${patched};`);
    if(running)fs.writeFileSync(path.join(f.state,unhealthy?'fake-unhealthy':'restart.request'),'fixture recovery\n');
    assert.equal((await f.hook()).status,0);
    await until(()=>fs.existsSync(path.join(f.dir,'gap-entered')),'gap patch removed component entry');
    await until(()=>fs.existsSync(path.join(f.state,'bridge.out'))&&fs.readFileSync(path.join(f.state,'bridge.out'),'utf8').includes('最多确认 10 秒'),'gap confirmation began');
    return {attempts:fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),pid:f.alive('.claude-code-router.pid',f.cli)};
  }
  const serviceProbe=f=>run('flock',['-n',path.join(f.state,'service.lock'),'true'],f.env);
  await test('missing entry after patch releases service.lock and retries safely after restoration',async f=>{
    const {attempts}=await patchGap(f);
    assert.equal((await serviceProbe(f)).status,0,'read-only entry confirmation held service.lock');
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
    fs.writeFileSync(f.entry,'// restored after unlocked confirmation');await until(f.healthy,'gap retry bridge ready');await sleep(400);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
    assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('missing entry after patch has one bounded ten-second confirmation and leaves its budget intact',async f=>{
    const {attempts}=await patchGap(f),started=Date.now();
    assert.equal((await serviceProbe(f)).status,0,'bounded confirmation still holds service.lock');
    await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'one bounded missing-entry confirmation',12500);
    assert.ok(Date.now()-started<11500,'confirmation exceeded its ten-second budget');
    const text=fs.readFileSync(path.join(f.state,'bridge.out'),'utf8');assert.equal((text.match(/最多确认 10 秒/g)||[]).length,1);
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.failed'),'utf8'),'component removed or disabled\n');
    fs.writeFileSync(f.entry,'// returned only after bounded confirmation expired');assert.equal((await f.hook()).status,0);await sleep(400);
    assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
  });
  for(const change of ['disabled','recovery.failed','manifest']){
    await test('unlocked entry confirmation respects '+change+' without killing, spawning or clearing budget',async f=>{
      const {attempts,pid}=await patchGap(f,{running:true});assert.ok(pid);
      assert.equal((await serviceProbe(f)).status,0,'gap must not keep service.lock');
      const fault=path.join(f.state,'recovery.failed');
      if(change==='disabled')fs.writeFileSync(path.join(f.dir,'disabled'),'fixture disabled\n');
      if(change==='recovery.failed')fs.writeFileSync(fault,'fixture authoritative failure\n');
      if(change==='manifest'){
        const file=path.join(f.dir,'.ccr-bridge-kit.json'),m=JSON.parse(fs.readFileSync(file));m.replaced='fixture';fs.writeFileSync(file,JSON.stringify(m));
      }
      fs.writeFileSync(f.entry,'// entry returned after concurrent state change');
      await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'gap state change stops watchdog');
      assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(await f.healthy(),true);
      assert.equal(fs.existsSync(path.join(f.state,'fake-stops')),false);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
      assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
      if(change==='disabled')assert.equal(fs.existsSync(fault),false);
      if(change==='recovery.failed')assert.equal(fs.readFileSync(fault,'utf8'),'fixture authoritative failure\n');
      if(change==='manifest')assert.equal(fs.readFileSync(fault,'utf8'),'component removed or disabled\n');
    });
  }
  await test('unlocked confirmation rechecks component identity after service.lock becomes available',async f=>{
    const {attempts}=await patchGap(f);
    const holder=spawn('bash',['-c',String.raw`exec 9> "$1/runtime-home/.claude-code-router/service.lock"; flock -n 9 || exit 21; printf held > "$1/reacquire-held"; while [[ ! -e "$1/reacquire-release" ]]; do sleep 0.05; done; node -e 'const fs=require("node:fs"),file=process.argv[1]+"/.ccr-bridge-kit.json",m=JSON.parse(fs.readFileSync(file));m.changedAfterConfirmation=true;fs.writeFileSync(file,JSON.stringify(m));' "$1"; flock -u 9`,'fixture',f.dir],{env:f.env,stdio:'ignore'});
    try{
      await until(()=>fs.existsSync(path.join(f.dir,'reacquire-held'))||holder.exitCode!==null,'concurrent lock holder ready');
      assert.equal(holder.exitCode,null,'confirmation did not release service.lock');
      fs.writeFileSync(f.entry,'// returned while another ensure holds lock');await sleep(600);
      assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
      fs.writeFileSync(path.join(f.dir,'reacquire-release'),'release');
      await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'changed identity rejected after lock release');
      assert.equal(fs.existsSync(path.join(f.state,'fake-starts')),false);assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
      assert.equal(fs.readFileSync(path.join(f.state,'recovery.failed'),'utf8'),'component removed or disabled\n');
    }finally{holder.kill('SIGTERM');if(holder.exitCode===null&&holder.signalCode===null)await new Promise(resolve=>holder.once('close',resolve));}
  });
  await test('another ensure starting during unlocked confirmation is not stopped or duplicated',async f=>{
    const {attempts}=await patchGap(f);
    const ensured=await run('bash',['-c',String.raw`exec 9> "$1/runtime-home/.claude-code-router/service.lock"; flock -n 9 || exit 21; setsid node "$1/node_modules/@musistudio/claude-code-router/dist/cli.js" start < /dev/null > /dev/null 2>&1 9>&- &`,'fixture',f.dir],{...f.env,HOME:path.join(f.dir,'runtime-home'),SERVICE_PORT:String(f.port)});
    assert.equal(ensured.status,0,'another ensure could not acquire service.lock: '+ensured.stderr);await until(f.healthy,'other ensure bridge ready');
    const pid=f.alive('.claude-code-router.pid',f.cli);fs.writeFileSync(f.entry,'// entry returned after another ensure');await sleep(900);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
    assert.equal(fs.existsSync(path.join(f.state,'fake-stops')),false);assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
  });
  await test('another ensure slow startup during unlocked confirmation is neither killed nor duplicated',async f=>{
    const {attempts}=await patchGap(f);
    const ensured=await run('bash',['-c',String.raw`exec 9> "$1/runtime-home/.claude-code-router/service.lock"; flock -n 9 || exit 21; setsid node "$1/node_modules/@musistudio/claude-code-router/dist/cli.js" start < /dev/null > /dev/null 2>&1 9>&- &`,'fixture',f.dir],{...f.env,HOME:path.join(f.dir,'runtime-home'),SERVICE_PORT:String(f.port),HOOK_TEST_LISTEN_DELAY:'1800'});
    assert.equal(ensured.status,0,ensured.stderr);await until(()=>f.alive('.claude-code-router.pid',f.cli),'other ensure slow bridge PID');
    const pid=f.alive('.claude-code-router.pid',f.cli);assert.equal(await f.healthy(),false);fs.writeFileSync(f.entry,'// entry returned before slow ensure is healthy');
    await until(f.healthy,'other ensure slow bridge finishes startup');await sleep(400);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
    assert.equal(fs.existsSync(path.join(f.state,'fake-stops')),false);assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
  });
  await test('another ensure startup protection stays bounded and persistent failures recover normally',async f=>{
    const {attempts}=await patchGap(f);
    const ensured=await run('bash',['-c',String.raw`source "$1/bridge-common.sh" || exit; exec 9> "$STATE/service.lock"; flock -n 9 || exit 21; setsid node "$CLI" start < /dev/null > /dev/null 2>&1 9>&- &`,'fixture',f.dir],{...f.env,HOOK_TEST_LISTEN_DELAY:'30000'});
    assert.equal(ensured.status,0,ensured.stderr);await until(()=>f.alive('.claude-code-router.pid',f.cli),'never-ready ensure bridge PID');
    const pid=f.alive('.claude-code-router.pid',f.cli),restored=Date.now();fs.writeFileSync(f.entry,'// entry returned but foreign startup never becomes healthy');
    await sleep(900);assert.equal(f.alive('.claude-code-router.pid',f.cli),pid);assert.equal(fs.existsSync(path.join(f.state,'fake-stops')),false);
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
    await until(f.healthy,'persistent other ensure startup recovers after bounded grace',10000);
    assert.ok(Date.now()-restored<9500,'ensure startup protection became unbounded');assert.notEqual(f.alive('.claude-code-router.pid',f.cli),pid);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\nstart\n');assert.equal(fs.readFileSync(path.join(f.state,'fake-stops'),'utf8'),pid+'\n');
    assert.equal(Number(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8')),Number(attempts)+1);assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('entry confirmation before taking service.lock also preserves another ensure slow startup',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'prelock gap initial ready');
    const pid=f.alive('.claude-code-router.pid',f.cli),attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');fs.unlinkSync(f.entry);
    await until(()=>fs.readFileSync(path.join(f.state,'bridge.out'),'utf8').includes('最多确认 10 秒'),'prelock gap confirmation began');
    const ensured=await run('bash',['-c',String.raw`source "$1/bridge-common.sh" || exit; exec 9> "$STATE/service.lock"; flock -n 9 || exit 21; bridge_stop "$2" || exit 22; setsid node "$CLI" start < /dev/null > /dev/null 2>&1 9>&- &`,'fixture',f.dir,String(pid)],{...f.env,HOOK_TEST_LISTEN_DELAY:'1800'});
    assert.equal(ensured.status,0,ensured.stderr);await until(()=>f.alive('.claude-code-router.pid',f.cli),'prelock other ensure PID');
    const replacement=f.alive('.claude-code-router.pid',f.cli);fs.writeFileSync(f.entry,'// returned after prelock replacement');
    await until(f.healthy,'prelock other ensure slow startup complete');await sleep(400);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),replacement);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\nstart\n');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-stops'),'utf8'),pid+'\n');assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
  });
  await test('entry confirmation after stop abandons the pending spawn when another ensure starts slowly',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'post-stop gap initial ready');
    const pid=f.alive('.claude-code-router.pid',f.cli);fs.writeFileSync(path.join(f.state,'fake-remove-entry-on-stop'),f.entry);fs.writeFileSync(path.join(f.state,'fake-unhealthy'),'fixture recovery');
    await until(()=>fs.readFileSync(path.join(f.state,'bridge.out'),'utf8').includes('最多确认 10 秒'),'post-stop gap confirmation began');
    const attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');fs.rmSync(path.join(f.state,'fake-unhealthy'));
    const ensured=await run('bash',['-c',String.raw`source "$1/bridge-common.sh" || exit; exec 9> "$STATE/service.lock"; flock -n 9 || exit 21; setsid node "$CLI" start < /dev/null > /dev/null 2>&1 9>&- &`,'fixture',f.dir],{...f.env,HOOK_TEST_LISTEN_DELAY:'1800'});
    assert.equal(ensured.status,0,ensured.stderr);await until(()=>f.alive('.claude-code-router.pid',f.cli),'post-stop other ensure PID');
    const replacement=f.alive('.claude-code-router.pid',f.cli);fs.writeFileSync(f.entry,'// returned after pending spawn was abandoned');
    await until(f.healthy,'post-stop other ensure slow startup complete');await sleep(400);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),replacement);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\nstart\n');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-stops'),'utf8'),pid+'\n');assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts);
  });
  await test('another ensure replacing an unhealthy bridge clears no durable recovery budget',async f=>{
    const {pid}=await patchGap(f,{running:true,unhealthy:true});
    const ensured=await run('bash',['-c',String.raw`source "$1/bridge-common.sh" || exit; exec 9> "$STATE/service.lock"; flock -n 9 || exit 21; bridge_stop "$2" || exit 22; printf '3\n' > "$STATE/recovery.attempts"; rm -f -- "$STATE/restart.request" "$STATE/fake-unhealthy"; setsid node "$CLI" start < /dev/null > /dev/null 2>&1 9>&- &`,'fixture',f.dir,String(pid)],f.env);
    assert.equal(ensured.status,0,'another ensure could not safely replace the fixture bridge: '+ensured.stderr);await until(f.healthy,'other ensure replacement ready');
    const replacement=f.alive('.claude-code-router.pid',f.cli);assert.notEqual(replacement,pid);fs.writeFileSync(f.entry,'// entry returned after replacement');await sleep(900);
    assert.equal(f.alive('.claude-code-router.pid',f.cli),replacement);assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\nstart\n');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-stops'),'utf8'),pid+'\n');
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),'3\n');assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('unlocked confirmation retains patch exit 2 restart intent',async f=>{
    const {pid}=await patchGap(f,{running:true,patched:2,unhealthy:true});assert.ok(pid);
    fs.writeFileSync(path.join(f.dir,'patch-ccr.js'),"const fs=require('node:fs');fs.appendFileSync(__dirname+'/patch-runs','patch\\n');process.exitCode=0;");
    fs.rmSync(path.join(f.state,'fake-unhealthy'));fs.writeFileSync(f.entry,'// entry returned after changed patch');
    await until(()=>fs.readFileSync(path.join(f.state,'fake-starts'),'utf8')==='start\nstart\n','changed patch restarts once');await until(f.healthy,'changed patch restart ready');await sleep(400);
    assert.equal(fs.readFileSync(path.join(f.state,'fake-stops'),'utf8'),pid+'\n');assert.equal(fs.existsSync(path.join(f.state,'recovery.failed')),false);
  });
  await test('entry confirmation does not count unobserved time as stable health or clear budget',async f=>{
    assert.equal((await f.hook({CCR_BRIDGE_RECOVERY_STABLE:'3'})).status,0);await until(f.healthy,'stable-gap initial ready');
    await sleep(500);const attempts=fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8');fs.unlinkSync(f.entry);
    await until(()=>fs.readFileSync(path.join(f.state,'bridge.out'),'utf8').includes('最多确认 10 秒'),'stable-gap confirmation began');
    await sleep(3300);fs.writeFileSync(f.entry,'// health must be observed again');await sleep(600);
    assert.equal(fs.existsSync(path.join(f.state,'recovery.attempts')),true,'entry wait was incorrectly credited as sustained health');
    assert.equal(fs.readFileSync(path.join(f.state,'recovery.attempts'),'utf8'),attempts,'entry wait was incorrectly credited as sustained health');
    assert.equal(fs.readFileSync(path.join(f.state,'fake-starts'),'utf8'),'start\n');
  });
  await test('health log diagnostics rearm only after sustained successful probes and never after failures',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'health reset initial ready');
    const watch=f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh'));process.kill(watch,'SIGTERM');await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'health reset watchdog stopped');
    fs.mkdirSync(path.join(f.state,'health.log'));
    const r=await run('bash',['-c',String.raw`source "$1/bridge-common.sh" || exit
probe() { bridge_healthy; local rc=$?; printf '%s:%s\n' "$1" "$rc"; [[ "$rc" = "$2" ]] || exit 90; }
printf bad > "$STATE/fake-unhealthy"
probe first 1; printf 'mark:first\n' >&2
for i in {1..8}; do probe repeat 1; done
SECONDS=$((SECONDS+600)); probe long_failure 1; printf 'mark:failure\n' >&2
rm -f -- "$STATE/fake-unhealthy"; SECONDS=1000; probe healthy_start 0
SECONDS=1298; probe short_health 0
printf bad > "$STATE/fake-unhealthy"; probe short_failure 1; printf 'mark:short\n' >&2
rm -f -- "$STATE/fake-unhealthy"; SECONDS=2000; probe restarted_health 0
SECONDS=2298; probe still_short 0
saved_pid=$(< "$PIDFILE"); rm -f -- "$PIDFILE"; SECONDS=2301; probe missing_pid 1
printf '%s\n' "$saved_pid" > "$PIDFILE"; SECONDS=3000; probe after_missing_pid 0
SECONDS=3298; probe before_stable 0
printf bad > "$STATE/fake-unhealthy"; probe interrupted 1; printf 'mark:interrupted\n' >&2
rm -f -- "$STATE/fake-unhealthy"; SECONDS=4000; probe final_health_start 0
SECONDS=4302; probe stable_health 0
printf bad > "$STATE/fake-unhealthy"; probe rearmed 1; printf 'mark:rearmed\n' >&2
for i in {1..8}; do probe final_repeat 1; done
printf 'mark:end\n' >&2`,'fixture',f.dir],f.env,15000);
    assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/rearmed:1/);
    const marks=r.stderr.split(/mark:[^\n]+\n/);assert.equal(marks.length,7,r.stderr);
    for(const index of [0,4]){
      const lines=marks[index].trim().split('\n');assert.equal(lines.length,2,r.stderr);
      assert.match(lines[0],/^\[[0-9TZ:.+-]+\] health HEALTH_STATUS$/);assert.match(lines[1],/^\[[0-9TZ:.+-]+\] health LOG_UNSAFE_FILE$/);
    }
    for(const index of [1,2,3,5,6])assert.equal(marks[index],'','brief health or repeated failure rearmed stderr: '+r.stderr);
    assert.equal(fs.lstatSync(path.join(f.state,'health.log')).isDirectory(),true);
  });
  await test('real common health probe logs only safe bounded timestamped failures and leaves success quiet',async f=>{
    assert.equal((await f.hook()).status,0);await until(f.healthy,'health-log initial ready');
    const watch=f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh'));process.kill(watch,'SIGTERM');await until(()=>!f.alive('watchdog.pid',path.join(f.dir,'watchdog.sh')),'health-log watchdog stopped');
    const file=path.join(f.state,'health.log'),probe=()=>run('bash',['-c','source "$1/bridge-common.sh" && bridge_healthy','health-fixture',f.dir],f.env);
    const before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';assert.equal((await probe()).status,0);assert.equal(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'',before);
    fs.writeFileSync(path.join(f.state,'fake-unhealthy'),'fixture-only');const failed=await probe();assert.equal(failed.status,1);assert.equal(failed.stdout+failed.stderr,'');
    const text=fs.readFileSync(file,'utf8');assert.match(text,/\[[0-9TZ:.+-]+\] health HEALTH_STATUS\n/);assert.equal(text.includes('not-ok'),false);assert.equal(fs.statSync(file).mode&0o777,0o600);assert(fs.statSync(file).size<=65536);
  });
  console.log('PASS: '+passed+' isolated Hook lifecycle tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
