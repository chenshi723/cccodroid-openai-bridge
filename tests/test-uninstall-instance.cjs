#!/usr/bin/env node
'use strict';
// Disposable metadata fixtures only: no keys/config, HTTP listeners, bridge processes or /proc scans.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
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
  const common='BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || return 1\n'+
    'STATE="$BR/runtime-home/.claude-code-router"\n'+
    'watchdog_running() { printf "watchdog-checked\\n" >> "$BR/stop-called"; return 1; }\n'+
    'bridge_pid() { printf "bridge-checked\\n" >> "$BR/stop-called"; return 1; }\n';
  fs.writeFileSync(path.join(target,'bridge-common.sh'),common);
  fs.writeFileSync(path.join(target,'port'),String(port)+'\n');
  // This old private manager ignores unknown flags. Scoped uninstall must never execute it.
  fs.writeFileSync(path.join(target,'manage.cjs'),"require('node:fs').writeFileSync(__dirname+'/legacy-manager-called',JSON.stringify(process.argv.slice(2)));\n");
  const manifest={id:'ccr-bridge-kit',version:'1.0.5',target,settings,service:{schema:1,home,instanceId},files:{}};
  for(const name of ['bridge-common.sh','port','manage.cjs'])manifest.files[name]=hash(fs.readFileSync(path.join(target,name)));
  save(path.join(target,'.ccr-bridge-kit.json'),manifest);
  save(registry,registration.value(target,port,instanceId));
  const allowed=['PATH','PREFIX','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD'];
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.includes(key)));
  env.HOME=home;
  const run=(entry,args,extra={})=>spawnSync(process.execPath,[path.join(source,entry),...args],{env:{...env,...extra},encoding:'utf8',timeout:20000});
  const scoped=['uninstall','--dir',target,'--endpoint','http://127.0.0.1:'+port,'--instance',instanceId,'--yes'];
  const f={root,home,target,settings,registry,lock,original,manifest,env,run,scoped};
  try{return fn(f);}finally{fs.rmSync(root,{recursive:true,force:true});}
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
      assert.equal(fs.readFileSync(path.join(f.target,'stop-called'),'utf8'),'watchdog-checked\nbridge-checked\n');
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
    assert.equal(fs.readFileSync(path.join(f.target,'stop-called'),'utf8'),'watchdog-checked\nbridge-checked\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings,'utf8')),f.original);
  });
});

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
  if(!changed&&(${phase==='lock'?'bin===\'flock\'':"bin==='bash'&&args[0]==='-c'"})){changed=true;${change}}
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
    assert.equal(fs.readFileSync(path.join(f.target,'stop-called'),'utf8'),'watchdog-checked\nbridge-checked\n');
    assert.deepEqual(fs.readFileSync(f.settings),settings);
  });
});
