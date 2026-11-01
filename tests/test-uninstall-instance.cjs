#!/usr/bin/env node
'use strict';
// Disposable fixtures only: no real keys/config, HTTP listeners, live services or /proc scans.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const api=require('../installer.cjs');
const registration=require('../runtime/service-registration.cjs');
const source=path.resolve(__dirname,'..');
const instanceId='1'.repeat(32),otherId='2'.repeat(32),port=34591;
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const fixture=(fn)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-uninstall-unit-'));
  const home=path.join(root,'home'),target=path.join(home,"bridge with quote's"),settings=path.join(home,'settings.json');
  fs.mkdirSync(target,{recursive:true});
  const registry=registration.fileOf(home),lock=path.join(path.dirname(registry),'openai-bridge.lock');
  fs.mkdirSync(path.dirname(registry),{recursive:true});
  fs.writeFileSync(lock,'',{mode:0o600});
  const original={env:{KEEP:'fixture'},hooks:{SessionStart:[{hooks:[{type:'command',command:'fixture-user-hook'}]}]}};
  save(settings,api.mergeHook(original,target));
  fs.mkdirSync(path.join(target,'runtime-home','.claude-code-router'),{recursive:true});
  const runtimeFiles=['bridge-common.sh','start-bridge.sh','watchdog.sh','patch-ccr.js','health.cjs','service-registration.cjs'];
  for(const name of runtimeFiles)fs.copyFileSync(path.join(source,'runtime',name),path.join(target,name));
  fs.writeFileSync(path.join(target,'port'),String(port)+'\n');
  // This old private manager ignores unknown flags. Scoped uninstall must never execute it.
  fs.writeFileSync(path.join(target,'manage.cjs'),"require('node:fs').writeFileSync(__dirname+'/legacy-manager-called',JSON.stringify(process.argv.slice(2)));\n");
  const manifest={id:'ccr-bridge-kit',version:'1.0.5',target,settings,service:{schema:1,home,instanceId},files:{}};
  for(const name of [...runtimeFiles,'port','manage.cjs'])manifest.files[name]=hash(fs.readFileSync(path.join(target,name)));
  save(path.join(target,'.ccr-bridge-kit.json'),manifest);
  save(registry,registration.value(target,port,instanceId));
  const allowed=['PATH','PREFIX','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD'];
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.includes(key)));
  env.HOME=home;
  const run=(entry,args,extra={})=>spawnSync(process.execPath,[path.join(source,entry),...args],{env:{...env,...extra},encoding:'utf8',timeout:20000});
  const scoped=['uninstall','--dir',target,'--endpoint','http://127.0.0.1:'+port,'--instance',instanceId,'--yes'];
  const f={root,home,target,settings,registry,lock,original,manifest,env,run,scoped};
  try{
    const result=fn(f);
    if(result&&typeof result.then==='function')return result.finally(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.rmSync(root,{recursive:true,force:true});return result;
  }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
};
function snapshot(root){
  const result={};
  const visit=(dir)=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name),name=path.relative(root,file),st=fs.lstatSync(file);
      if(entry.isDirectory()){result[name]={type:'dir',mode:st.mode&0o777,ino:st.ino};visit(file);}
      else result[name]={type:entry.isSymbolicLink()?'link':'file',mode:st.mode&0o777,ino:st.ino,data:entry.isSymbolicLink()?fs.readlinkSync(file):fs.readFileSync(file,'base64')};
    }
  };
  visit(root);return result;
}
function deniedUnchanged(f,entry,args=f.scoped){
  const before=snapshot(f.root),r=f.run(entry,args);
  assert.equal(r.error,undefined,r.error?.message);
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.match(r.stderr,/错误/);
  assert.deepEqual(snapshot(f.root),before,r.stdout+r.stderr);
  return r;
}
for(const entry of ['installer.cjs','component.cjs']){
  test(entry+' rejects incomplete or ambiguous instance flags before any mutation',()=>{
    fixture(f=>{
      deniedUnchanged(f,entry,['uninstall','--dir',f.target,'--endpoint','http://127.0.0.1:'+port,'--yes']);
      deniedUnchanged(f,entry,['uninstall','--dir',f.target,'--instance',instanceId,'--yes']);
      for(const name of ['endpoint','instance','dir'])deniedUnchanged(f,entry,[...f.scoped,'--'+name,name==='instance'?instanceId:name==='dir'?f.target:'http://127.0.0.1:'+port]);
      const invalid=[...f.scoped];invalid[6]='invalid-instance';deniedUnchanged(f,entry,invalid);
      const wrong=[...f.scoped];wrong[6]=otherId;deniedUnchanged(f,entry,wrong);
      for(const command of ['start','status','stop'])deniedUnchanged(f,entry,[command,...f.scoped.slice(1)]);
      deniedUnchanged(f,entry,['ensure','--dir',f.target]);
      deniedUnchanged(f,entry,['ensure','--dir',f.target,'--endpoint','http://127.0.0.1:'+port]);
      deniedUnchanged(f,entry,['ensure','--dir',f.target,'--instance',instanceId]);
    });
  });
  test(entry+' requires the exact canonical loopback endpoint',()=>{
    fixture(f=>{
      for(const endpoint of ['http://localhost:'+port,'http://127.0.0.1:'+port+'/','http://127.0.0.1:'+port+'/v1','http://127.0.0.1:0'+port,'HTTP://127.0.0.1:'+port,'http://127.0.0.1:'+(port+1),'https://127.0.0.1:'+port,'http://127.0.0.1:'+port+'?x=1','http://u@127.0.0.1:'+port,'http://127.0.0.1:'+port+'#x']){
        const args=[...f.scoped];args[4]=endpoint;
        deniedUnchanged(f,entry,args);
      }
    });
  });
  test(entry+' rejects mismatched manifest service, home, target, port and instance',()=>{
    for(const change of [m=>{delete m.service;},m=>{m.service.schema=2;},m=>{m.service.home+='-other';},m=>{m.service.home+='/.';},m=>{m.service.instanceId=otherId;},m=>{m.target+='-other';},m=>{m.version='1.0.4';},m=>{delete m.files['bridge-common.sh'];},m=>{m.files['../outside']='0'.repeat(64);}])fixture(f=>{
      change(f.manifest);save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);
      deniedUnchanged(f,entry);
    });
    for(const text of ['034591\n','34591.0\n','34591 \n','34591\n\n','1023\n','65536\n',String(port+1)+'\n'])fixture(f=>{
      fs.writeFileSync(path.join(f.target,'port'),text);
      // Even a manifest acknowledging the file cannot authorize a noncanonical/wrong port.
      f.manifest.files.port=hash(text);save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);
      deniedUnchanged(f,entry);
    });
  });
  test(entry+' rejects missing, foreign, altered or symlink service registrations unchanged',()=>{
    for(const change of [r=>{r.instanceId=otherId;},r=>{r.runtimeDir+='-other';},r=>{r.endpoint='http://127.0.0.1:'+(port+1);},r=>{r.schema=2;},r=>{r.id='foreign';},r=>{r.extra=true;}])fixture(f=>{
      const value=registration.value(f.target,port,instanceId);change(value);save(f.registry,value);
      deniedUnchanged(f,entry);
    });
    fixture(f=>{fs.unlinkSync(f.registry);deniedUnchanged(f,entry);});
    fixture(f=>{const actual=f.registry+'.actual';fs.renameSync(f.registry,actual);fs.symlinkSync(actual,f.registry);deniedUnchanged(f,entry);});
    fixture(f=>{const dir=path.dirname(f.registry),actual=dir+'-actual';fs.renameSync(dir,actual);fs.symlinkSync(actual,dir);deniedUnchanged(f,entry);});
  });
  test(entry+' rejects linked or changed runtime metadata before stopping anything',()=>{
    for(const name of ['port','.ccr-bridge-kit.json','bridge-common.sh','manage.cjs'])fixture(f=>{
      const file=path.join(f.target,name),actual=file+'.actual';fs.renameSync(file,actual);fs.symlinkSync(actual,file);
      deniedUnchanged(f,entry);
    });
    fixture(f=>{fs.appendFileSync(path.join(f.target,'bridge-common.sh'),'# altered\n');deniedUnchanged(f,entry);});
    fixture(f=>{fs.renameSync(f.target,f.target+'-actual');fs.symlinkSync(f.target+'-actual',f.target);deniedUnchanged(f,entry);});
    fixture(f=>{const link=f.home+'-alias';fs.symlinkSync(f.home,link);const args=[...f.scoped];args[2]=path.join(link,path.basename(f.target));deniedUnchanged(f,entry,args);});
    fixture(f=>{const actual=f.settings+'.actual';fs.renameSync(f.settings,actual);fs.symlinkSync(actual,f.settings);deniedUnchanged(f,entry);});
    fixture(f=>{fs.unlinkSync(f.lock);deniedUnchanged(f,entry);});
    fixture(f=>{const actual=f.lock+'.actual';fs.renameSync(f.lock,actual);fs.symlinkSync(actual,f.lock);deniedUnchanged(f,entry);});
  });
  test(entry+' scoped uninstall stops only the verified fixture and preserves its private runtime',()=>{
    fixture(f=>{
      const beforeManager=fs.readFileSync(path.join(f.target,'manage.cjs')),beforeCommon=fs.readFileSync(path.join(f.target,'bridge-common.sh'));
      const foreign=path.join(f.home,'foreign-runtime');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'keep'),'foreign-fixture');
      const foreignBefore=snapshot(foreign),r=f.run(entry,f.scoped);
      assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);
      assert.match(r.stdout,/已停止并移除本安装/);
      assert.equal(fs.existsSync(f.registry),false);
      assert.equal(fs.readFileSync(path.join(f.target,'disabled'),'utf8'),'uninstalled\n');
      assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.settings,'utf8')),f.original);
      assert.equal(fs.existsSync(path.join(f.target,'legacy-manager-called')),false);
      assert.deepEqual(fs.readFileSync(path.join(f.target,'manage.cjs')),beforeManager);
      assert.deepEqual(fs.readFileSync(path.join(f.target,'bridge-common.sh')),beforeCommon);
      assert.deepEqual(snapshot(foreign),foreignBefore);
    });
  });
  test(entry+' supports explicitly authorized scoped purge of only its fixture',()=>{
    fixture(f=>{
      const r=f.run(entry,[...f.scoped,'--purge']);
      assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);
      assert.equal(fs.existsSync(f.target),false);assert.equal(fs.existsSync(f.registry),false);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.settings,'utf8')),f.original);
    });
  });
}

test('fixed component keeps manual no-instance uninstall delegated to an old private manager',()=>{
  fixture(f=>{
    // Even a pre-service older marker remains manually cleanable by its own old manager.
    f.manifest.version='1.0.4';delete f.manifest.service;
    save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);
    const r=f.run('component.cjs',['uninstall','--dir',f.target,'--yes']);
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target,'legacy-manager-called'),'utf8')),['uninstall','--dir',f.target,'--yes']);
    assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
  });
});

test('current installer preserves manual cleanup without instance metadata or registration',()=>{
  fixture(f=>{
    delete f.manifest.service;save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);fs.unlinkSync(f.registry);
    const r=f.run('installer.cjs',['uninstall','--dir',f.target,'--yes']);
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(fs.existsSync(path.join(f.target,'disabled')),true);
    assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings,'utf8')),f.original);
  });
});

test('scoped uninstall refuses a self-rehashed private common instead of executing it',()=>{
  fixture(f=>{
    const userFile=path.join(f.root,'fake-user-note'),marker=path.join(f.target,'tampered-common-called');
    fs.writeFileSync(userFile,'keep fake user data\n');
    const common=path.join(f.target,'bridge-common.sh');
    fs.appendFileSync(common,`printf 'private code ran\\n' > ${api.quote(marker)}\nprintf 'overwritten\\n' > ${api.quote(userFile)}\n`);
    f.manifest.files['bridge-common.sh']=hash(fs.readFileSync(common));
    save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);
    const before=snapshot(f.root),r=f.run('component.cjs',f.scoped);
    assert.equal(fs.existsSync(marker),false,'uninstall executed a self-authorized private shell script');
    assert.equal(fs.readFileSync(userFile,'utf8'),'keep fake user data\n');
    assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.deepEqual(snapshot(f.root),before);
  });
});

test('scoped uninstall refuses a symlink service lock without truncating its fake user target',()=>{
  fixture(f=>{
    const userFile=path.join(f.root,'fake-user-lock-target');
    fs.writeFileSync(userFile,'keep fake lock target\n');
    fs.symlinkSync(userFile,path.join(f.target,'runtime-home/.claude-code-router/service.lock'));
    const before=snapshot(f.root),r=f.run('component.cjs',f.scoped);
    assert.equal(fs.readFileSync(userFile,'utf8'),'keep fake lock target\n','service.lock followed a symlink and truncated a user file');
    assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.deepEqual(snapshot(f.root),before);
  });
});

test('fixed current stop never sources private code even on the explicit no-instance cleanup path',()=>fixture(f=>{
  const marker=path.join(f.target,'untrusted-common-called'),common=path.join(f.target,'bridge-common.sh');
  fs.appendFileSync(common,`printf 'executed\\n' > ${api.quote(marker)}\n`);
  f.manifest.files['bridge-common.sh']=hash(fs.readFileSync(common));save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);
  const r=f.run('installer.cjs',['uninstall','--dir',f.target,'--yes']);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(fs.existsSync(marker),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)),f.original);
}));

test('scoped uninstall preserves existing service lock inode and nonempty contents',()=>fixture(f=>{
  const lock=path.join(f.target,'runtime-home/.claude-code-router/service.lock');
  fs.writeFileSync(lock,'nonempty lock sentinel\n');const before=fs.statSync(lock);
  const r=f.run('component.cjs',f.scoped);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(fs.statSync(lock).ino,before.ino);
  assert.equal(fs.readFileSync(lock,'utf8'),'nonempty lock sentinel\n');
}));

test('scoped uninstall rejects malformed or redirected stop metadata promptly and unchanged',()=>{
  for(const mutate of [
    f=>fs.writeFileSync(path.join(f.target,'.ccr-bridge-kit.json'),'x'.repeat(65537)),
    f=>save(path.join(f.target,'.ccr-bridge-kit.json'),null),
    f=>fs.writeFileSync(path.join(f.target,'runtime-home/.claude-code-router/watchdog.pid'),'not-a-pid\n'),
    f=>fs.writeFileSync(path.join(f.target,'runtime-home/.claude-code-router/.claude-code-router.pid'),'0'.repeat(100000)),
    f=>{fs.unlinkSync(path.join(f.target,'port'));assert.equal(spawnSync('mkfifo',[path.join(f.target,'port')]).status,0);},
    f=>{fs.unlinkSync(path.join(f.target,'.ccr-bridge-kit.json'));assert.equal(spawnSync('mkfifo',[path.join(f.target,'.ccr-bridge-kit.json')]).status,0);},
    f=>{const dir=path.join(f.target,'runtime-home'),actual=path.join(f.root,'foreign-state');fs.renameSync(dir,actual);fs.symlinkSync(actual,dir);},
    f=>{const file=path.join(f.root,'fake-private-data');fs.writeFileSync(file,'user data\n');fs.symlinkSync(file,path.join(f.target,'runtime-home/.claude-code-router/watchdog.pid'));},
    f=>{f.manifest.files['connection.json']='0'.repeat(64);save(path.join(f.target,'.ccr-bridge-kit.json'),f.manifest);assert.equal(spawnSync('mkfifo',[path.join(f.target,'connection.json')]).status,0);}
  ])fixture(f=>{
    mutate(f);
    // Snapshot only regular files/links: never read a FIFO in the test helper either.
    const before=safeSnapshot(f.root),r=f.run('component.cjs',f.scoped);
    assert.equal(r.error,undefined,r.error?.message);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.deepEqual(safeSnapshot(f.root),before,r.stdout+r.stderr);
  });
});
test('scoped uninstall refuses a hard-linked service lock where the filesystem supports links',t=>fixture(f=>{
  const file=path.join(f.root,'fake-lock-data');fs.writeFileSync(file,'user data\n');
  try{fs.linkSync(file,path.join(f.target,'runtime-home/.claude-code-router/service.lock'));}
  catch(error){if(['EACCES','EPERM','ENOTSUP'].includes(error.code)){t.skip('filesystem denies hard links');return;}throw error;}
  deniedUnchanged(f,'component.cjs');
}));
function safeSnapshot(root){
  const result={};
  function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name),st=fs.lstatSync(file),name=path.relative(root,file);
    if(st.isDirectory()){result[name]={type:'dir',ino:st.ino};visit(file);}
    else result[name]={type:st.isSymbolicLink()?'link':st.isFile()?'file':'special',ino:st.ino,data:st.isSymbolicLink()?fs.readlinkSync(file):st.isFile()?fs.readFileSync(file,'base64'):null};
  }}
  visit(root);return result;
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message){
  for(let i=0;i<150;i++){if(predicate())return;await delay(20);}
  assert.fail(message);
}
async function dispose(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGKILL');await exited;
}
function fakeBridge(f,{relative=false,ignoreTerm=false,args=[]}={}){
  const cli='node_modules/@musistudio/claude-code-router/dist/cli.js',file=path.join(f.target,cli),ready=path.join(f.target,'fake-bridge-ready');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,`const fs=require('node:fs');${ignoreTerm?"process.on('SIGTERM',()=>{});":''}fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
  const child=spawn(process.execPath,[relative?cli:file,'start',...args],{cwd:f.target,env:f.env,stdio:'ignore'});
  fs.writeFileSync(path.join(f.target,'runtime-home/.claude-code-router/.claude-code-router.pid'),String(child.pid)+'\n');
  return {child,ready};
}
for(const relative of [false,true])test('fixed stop safely terminates an existing '+(relative?'relative-cwd':'absolute-path')+' disposable Node runtime',()=>fixture(async f=>{
  const {child,ready}=fakeBridge(f,{relative});
  try{
    await until(()=>fs.existsSync(ready),'fake bridge did not start');
    const r=f.run('component.cjs',f.scoped);
    assert.equal(r.status,0,r.stdout+r.stderr);
    await until(()=>child.exitCode!==null||child.signalCode!==null,'fake bridge did not stop');
    assert.equal(fs.existsSync(path.join(f.target,'runtime-home/.claude-code-router/.claude-code-router.pid')),false);
    assert.equal(fs.existsSync(f.registry),false);
  }finally{await dispose(child);}
}));

test('fixed stop uses bounded KILL escalation only for the same disposable bridge identity',()=>fixture(async f=>{
  const {child,ready}=fakeBridge(f,{ignoreTerm:true});
  try{
    await until(()=>fs.existsSync(ready),'fake bridge did not start');
    const r=f.run('component.cjs',f.scoped);
    assert.equal(r.status,0,r.stdout+r.stderr);
    await until(()=>child.signalCode!==null,'fake bridge did not stop');
    assert.equal(child.signalCode,'SIGKILL');
  }finally{await dispose(child);}
}));

test('fixed stop terminates only a matching locked disposable watchdog without executing its file',()=>fixture(async f=>{
  const file=path.join(f.target,'watchdog.sh'),ready=path.join(f.target,'fake-watchdog-ready'),state=path.join(f.target,'runtime-home/.claude-code-router');
  // The interpreter holds an already-open fixture script; restore trusted bytes before uninstall.
  fs.writeFileSync(file,'#!/bin/bash\nexec 8> "$1/watchdog.lock"\nflock -n 8 || exit 1\nprintf ready > "$2"\ntrap \'exit 0\' TERM\nwhile :; do sleep .1; done\n');
  // Exact production argv has no extra arguments; embed only disposable absolute paths instead.
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('"$1/watchdog.lock"',api.quote(path.join(state,'watchdog.lock'))).replace('"$2"',api.quote(ready)));
  const child=spawn('bash',[file],{env:f.env,stdio:'ignore'});
  try{
    await until(()=>fs.existsSync(ready),'fake watchdog did not start');
    fs.copyFileSync(path.join(source,'runtime/watchdog.sh'),file);
    fs.writeFileSync(path.join(state,'watchdog.pid'),String(child.pid)+'\n');
    const r=f.run('component.cjs',f.scoped);
    assert.equal(r.status,0,r.stdout+r.stderr);
    await until(()=>child.exitCode!==null||child.signalCode!==null,'fake watchdog did not stop');
    assert.equal(fs.existsSync(path.join(state,'watchdog.pid')),false);
  }finally{await dispose(child);}
}));

test('fixed stop refuses a matching watchdog with missing ownership lock and preserves its process',()=>fixture(async f=>{
  const file=path.join(f.target,'watchdog.sh'),ready=path.join(f.target,'fake-unlocked-watchdog-ready'),state=path.join(f.target,'runtime-home/.claude-code-router');
  fs.writeFileSync(file,`#!/bin/bash\nprintf ready > ${api.quote(ready)}\nwhile :; do sleep .1; done\n`);
  const child=spawn('bash',[file],{env:f.env,stdio:'ignore'});
  try{
    await until(()=>fs.existsSync(ready),'fake watchdog did not start');
    fs.copyFileSync(path.join(source,'runtime/watchdog.sh'),file);
    fs.writeFileSync(path.join(state,'watchdog.pid'),String(child.pid)+'\n');
    const settings=fs.readFileSync(f.settings),r=f.run('component.cjs',f.scoped);
    assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);process.kill(child.pid,0);
    assert.equal(fs.existsSync(f.registry),true);assert.deepEqual(fs.readFileSync(f.settings),settings);
  }finally{await dispose(child);}
}));

test('service lock contention has a finite refusal and never signals its disposable bridge',()=>fixture(async f=>{
  const {child,ready}=fakeBridge(f),state=path.join(f.target,'runtime-home/.claude-code-router'),held=path.join(f.target,'fake-service-lock-held');
  const holder=spawn('bash',['-c',`exec 3> ${api.quote(path.join(state,'service.lock'))}; flock 3 || exit; printf held > ${api.quote(held)}; exec sleep 25`],{env:f.env,stdio:'ignore'});
  try{
    await until(()=>fs.existsSync(ready)&&fs.existsSync(held),'disposable bridge or lock holder did not start');
    const settings=fs.readFileSync(f.settings),started=Date.now(),r=f.run('component.cjs',f.scoped);
    assert.notEqual(r.status,0,r.stdout+r.stderr);assert(Date.now()-started<15000,'lock refusal was not bounded');
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);process.kill(child.pid,0);
    assert.equal(fs.existsSync(f.registry),true);assert.deepEqual(fs.readFileSync(f.settings),settings);
  }finally{await dispose(holder);await dispose(child);}
}));

test('fixed stop never signals a PID file pointing at an unrelated disposable process',()=>fixture(async f=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:f.env,stdio:'ignore'});
  try{
    fs.writeFileSync(path.join(f.target,'runtime-home/.claude-code-router/.claude-code-router.pid'),String(child.pid)+'\n');
    const r=f.run('component.cjs',f.scoped);
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    process.kill(child.pid,0);
  }finally{await dispose(child);}
}));

for(const kind of ['bridge','watchdog'])test('fixed stop rejects Python masquerading as '+(kind==='bridge'?'Node':'Bash')+' via argv0 with matching runtime arguments',()=>fixture(async f=>{
  const state=path.join(f.target,'runtime-home/.claude-code-router'),file=kind==='bridge'?path.join(f.target,'node_modules/@musistudio/claude-code-router/dist/cli.js'):path.join(f.target,'watchdog.sh');
  const ready=path.join(f.target,'python-spoof-ready'),signaled=path.join(f.target,'python-spoof-signaled');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,`import pathlib, signal, sys, time\n${kind==='watchdog'?`import fcntl\nlock = open(${JSON.stringify(path.join(state,'watchdog.lock'))}, 'w')\nfcntl.flock(lock, fcntl.LOCK_EX)\n`:''}def stopped(*args):\n    pathlib.Path(${JSON.stringify(signaled)}).write_text('TERM')\n    sys.exit(0)\nsignal.signal(signal.SIGTERM, stopped)\npathlib.Path(${JSON.stringify(ready)}).write_text('ready')\nwhile True:\n    time.sleep(0.1)\n`);
  const child=spawn('python3',[file,...(kind==='bridge'?['start']:[])],{argv0:kind==='bridge'?'node':'bash',cwd:f.target,env:f.env,stdio:'ignore'});
  try{
    await until(()=>fs.existsSync(ready),'spoofed Python fixture did not start');
    if(kind==='watchdog')fs.copyFileSync(path.join(source,'runtime/watchdog.sh'),file);
    const pidFile=path.join(state,kind==='bridge'?'.claude-code-router.pid':'watchdog.pid');
    fs.writeFileSync(pidFile,String(child.pid)+'\n');
    const cmdline=fs.readFileSync('/proc/'+child.pid+'/cmdline','utf8').split('\0').filter(Boolean);
    assert.deepEqual(cmdline,[kind==='bridge'?'node':'bash',file,...(kind==='bridge'?['start']:[])]);
    const r=f.run('component.cjs',f.scoped);
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(fs.existsSync(signaled),false,'argv0 spoof caused a signal to the wrong executable');
    process.kill(child.pid,0);
    assert.equal(fs.readFileSync(pidFile,'utf8'),String(child.pid)+'\n');
  }finally{await dispose(child);}
}));

// Intercept only this disposable installer's own filesystem calls, not private runtime code.
function fsRace(f,trigger,change,args=f.scoped,setup=''){
  const hook=path.join(f.root,'filesystem-race.cjs');
  fs.writeFileSync(hook,`'use strict';const fs=require('node:fs'),cp=require('node:child_process');
const target=${JSON.stringify(f.target)},registry=${JSON.stringify(f.registry)},settings=${JSON.stringify(f.settings)},marker=target+'/.ccr-bridge-kit.json',state=target+'/runtime-home/.claude-code-router';
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v)+'\\n'),before={};
for(const name of ['writeFileSync','renameSync','unlinkSync','openSync','readFileSync'])before[name]=fs[name];
${setup}
let changed=false;
function mutate(op,args,after){if(!changed&&(${trigger})){changed=true;${change}}}
for(const name of ['writeFileSync','renameSync','unlinkSync','openSync','readFileSync'])fs[name]=function(...args){mutate(name,args,false);const result=before[name].apply(this,args);mutate(name,args,true);return result;};
`);
  return f.run('component.cjs',args,{NODE_OPTIONS:'--require='+hook});
}
for(const [name,change] of [
  ['replacement registration',"const r=JSON.parse(fs.readFileSync(registry));r.instanceId='2'.repeat(32);save(registry,r);"],
  ['private common and its self-authorized hash',"fs.appendFileSync(target+'/bridge-common.sh','\\nprintf unsafe > '+JSON.stringify(target+'/race-private-called')+'\\n');const m=JSON.parse(fs.readFileSync(marker));m.files['bridge-common.sh']=require('node:crypto').createHash('sha256').update(fs.readFileSync(target+'/bridge-common.sh')).digest('hex');save(marker,m);"],
  ['replacement target directory',"fs.renameSync(target,target+'-old');fs.cpSync(target+'-old',target,{recursive:true});"]
])test('disabled staging rechecks '+name+' before rename, stop or unregister',()=>fixture(f=>{
  const settings=fs.readFileSync(f.settings);
  const r=fsRace(f,"after&&op==='writeFileSync'&&String(args[0]).includes('/.kit-')",change);
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
  assert.equal(fs.existsSync(path.join(f.target,'race-private-called')),false);
  assert.equal(fs.existsSync(f.registry),true);assert.deepEqual(fs.readFileSync(f.settings),settings);
}));

test('source identity is rechecked if the component source is swapped while disabled is staged',()=>fixture(f=>{
  const kit=path.join(f.root,'fixed-component-copy');fs.mkdirSync(kit);
  for(const name of ['installer.cjs','component.cjs'])fs.copyFileSync(path.join(source,name),path.join(kit,name));
  fs.cpSync(path.join(source,'runtime'),path.join(kit,'runtime'),{recursive:true});
  const hook=path.join(f.root,'source-race.cjs');
  fs.writeFileSync(hook,`const fs=require('node:fs'),write=fs.writeFileSync;let changed=false;fs.writeFileSync=function(file){const r=write.apply(this,arguments);if(!changed&&String(file).includes('/.kit-')){changed=true;const source=${JSON.stringify(path.join(kit,'runtime/bridge-common.sh'))};fs.renameSync(source,source+'.old');fs.copyFileSync(source+'.old',source);}return r;};`);
  const r=spawnSync(process.execPath,[path.join(kit,'component.cjs'),...f.scoped],{env:{...f.env,NODE_OPTIONS:'--require='+hook},encoding:'utf8',timeout:20000});
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
  assert.equal(fs.existsSync(f.registry),true);
}));

test('service lock nofollow also rejects replacement between lstat and open without truncation',()=>fixture(f=>{
  const userFile=path.join(f.root,'raced-fake-lock-target');fs.writeFileSync(userFile,'keep raced target\n');
  const lock=path.join(f.target,'runtime-home/.claude-code-router/service.lock');fs.writeFileSync(lock,'existing lock\n');
  const r=fsRace(f,"!after&&op==='openSync'&&String(args[0]).endsWith('/service.lock')",`fs.unlinkSync(state+'/service.lock');fs.symlinkSync(${JSON.stringify(userFile)},state+'/service.lock');`);
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.equal(fs.readFileSync(userFile,'utf8'),'keep raced target\n');
  assert.equal(fs.existsSync(f.registry),true);
}));

test('registration is rechecked after process identity reads and before sending TERM',()=>fixture(async f=>{
  const {child,ready}=fakeBridge(f);
  try{
    await until(()=>fs.existsSync(ready),'fake bridge did not start');
    const setup=`const read=fs.readSync;let identityRead=false;fs.readSync=function(fd){try{if(fs.readlinkSync('/proc/self/fd/'+fd)==='/proc/${child.pid}/cmdline')identityRead=true;}catch{}return read.apply(this,arguments);};`;
    const r=fsRace(f,"!after&&identityRead",`save(registry,${JSON.stringify(registration.value(f.target,port,otherId))});`,f.scoped,setup);
    assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(f.registry)).instanceId,otherId);
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);process.kill(child.pid,0);
  }finally{await dispose(child);}
}));

test('settings backup rechecks a replacement registration before the settings rename',()=>fixture(f=>{
  const settings=fs.readFileSync(f.settings);
  const r=fsRace(f,"after&&op==='writeFileSync'&&String(args[0]).includes('.bridge-kit-backup-')",`save(registry,${JSON.stringify(registration.value(f.target,port,otherId))});`);
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.registry)).instanceId,otherId);
  assert.deepEqual(fs.readFileSync(f.settings),settings);
  assert.equal(fs.readFileSync(path.join(f.target,'disabled'),'utf8'),'uninstalled\n');
}));

test('settings staging never overwrites a concurrent user settings edit',()=>fixture(f=>{
  const r=fsRace(f,"after&&op==='writeFileSync'&&String(args[0]).includes('/.kit-')&&String(args[1]).includes('fixture-user-hook')","save(settings,{env:{KEEP:'concurrent-user-edit'}});");
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)),{env:{KEEP:'concurrent-user-edit'}});
  assert.equal(fs.readFileSync(path.join(f.target,'disabled'),'utf8'),'uninstalled\n');
}));

// Deterministically inject concurrent metadata changes at the lock/stop boundaries in a child.
// The production code remains unmodified; the preload can only touch this disposable fixture.
function race(f,phase,change){
  const hook=path.join(f.root,'fixture-race.cjs');
  fs.writeFileSync(hook,`'use strict';
const fs=require('node:fs'),cp=require('node:child_process');
const target=${JSON.stringify(f.target)},registry=${JSON.stringify(f.registry)},marker=target+'/.ccr-bridge-kit.json';
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v)+'\\n');
const original=cp.spawnSync;let changed=false;
cp.spawnSync=function(bin,args,options){
  const result=original.apply(this,arguments);
  if(!changed&&(${phase==='lock'?"bin==='flock'&&args[1]==='5'":"bin==='flock'&&args[1]==='10'&&fs.existsSync(target+'/runtime-home/.claude-code-router/service.lock')"})){changed=true;${change}}
  return result;
};
`);
  return f.run('component.cjs',f.scoped,{NODE_OPTIONS:'--require='+hook});
}
test('scoped uninstall holds the shared registration lock through every side effect and releases it',()=>{
  fixture(f=>{
    const change="const busy=original('flock',['-n',registry.replace(/\\.json$/,'.lock'),'true']);if(busy.status!==1)throw new Error('registration lock not held');";
    const r=race(f,'lock',change);
    assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(fs.existsSync(f.registry),false);
    const available=spawnSync('flock',['-n',f.lock,'true'],{env:f.env,encoding:'utf8',timeout:2000});
    assert.equal(available.status,0,available.stderr);
  });
});
for(const [name,change] of [
  ['replacement registration',"const r=JSON.parse(fs.readFileSync(registry));r.instanceId='2'.repeat(32);save(registry,r);"],
  ['changed registered endpoint',"const r=JSON.parse(fs.readFileSync(registry));r.endpoint='http://127.0.0.1:34592';save(registry,r);"],
  ['missing registration','fs.unlinkSync(registry);'],
  ['replacement manifest',"const m=JSON.parse(fs.readFileSync(marker));m.service.instanceId='2'.repeat(32);save(marker,m);"],
  ['replacement directory',"fs.renameSync(target,target+'-old');fs.cpSync(target+'-old',target,{recursive:true});"],
  ['replacement lock',"fs.renameSync(registry.replace(/\\.json$/,'.lock'),registry+'.old-lock');fs.writeFileSync(registry.replace(/\\.json$/,'.lock'),'');"]
])test('registration-lock recheck refuses '+name+' before disabled/stop/unregister',()=>{
  fixture(f=>{
    const settings=fs.readFileSync(f.settings),manager=fs.readFileSync(path.join(f.target,'manage.cjs'));
    const r=race(f,'lock',change);
    assert.equal(r.error,undefined,r.error?.message);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
    assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
    assert.equal(fs.existsSync(path.join(f.target,'legacy-manager-called')),false);
    assert.deepEqual(fs.readFileSync(f.settings),settings);
    assert.deepEqual(fs.readFileSync(path.join(f.target,'manage.cjs')),manager);
  });
});

test('registration is rechecked after stop and a replacement is never unregistered',()=>{
  fixture(f=>{
    const settings=fs.readFileSync(f.settings);
    const r=race(f,'stop',"const r=JSON.parse(fs.readFileSync(registry));r.instanceId='2'.repeat(32);save(registry,r);");
    assert.equal(r.error,undefined,r.error?.message);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(f.registry)).instanceId,otherId);
    assert.equal(fs.existsSync(path.join(f.target,'disabled')),true);
    assert.equal(fs.existsSync(path.join(f.target,'stop-called')),false);
    assert.deepEqual(fs.readFileSync(f.settings),settings);
  });
});
