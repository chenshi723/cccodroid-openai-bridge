#!/usr/bin/env node
'use strict';
// Disposable fixtures only; no real keys, bridge instances or remote requests.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const vm=require('node:vm');
const api=require('../installer.cjs');
const registration=require('../runtime/service-registration.cjs');
const source=path.resolve(__dirname,'..');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const otherSpelling=file=>file.startsWith('/data/data/')?file.replace('/data/data/','/data/user/0/'):file.startsWith('/data/user/0/')?file.replace('/data/user/0/','/data/data/'):null;
function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-path-alias-')));
  try{return fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
function androidFixture(t,fn){
  return fixture(root=>{
    const alias=otherSpelling(root);
    if(!alias||!fs.existsSync(alias)){t.skip('Android app-root aliases unavailable');return;}
    assert.equal(fs.statSync(alias).ino,fs.statSync(root).ino);
    return fn(root,alias);
  });
}
function instance(root){
  const home=path.join(root,'home'),target=path.join(home,'bridge'),settings=path.join(home,'.claude/settings.json');
  fs.mkdirSync(target,{recursive:true});fs.mkdirSync(path.dirname(settings),{recursive:true});
  fs.mkdirSync(path.join(target,'runtime-home/.claude-code-router'),{recursive:true});
  const id='1'.repeat(32),port=34591,files={};
  for(const name of ['bridge-common.sh','start-bridge.sh','watchdog.sh','patch-ccr.js','health.cjs','service-registration.cjs']){
    const data=fs.readFileSync(path.join(source,'runtime',name));fs.writeFileSync(path.join(target,name),data);files[name]=hash(data);
  }
  fs.writeFileSync(path.join(target,'port'),String(port)+'\n');files.port=hash(String(port)+'\n');
  fs.copyFileSync(path.join(source,'installer.cjs'),path.join(target,'manage.cjs'));files['manage.cjs']=hash(fs.readFileSync(path.join(target,'manage.cjs')));
  const m={id:'ccr-bridge-kit',version:'1.0.5',target,settings,componentEntry:path.join(source,'component.cjs'),service:{schema:1,home,instanceId:id},files};
  save(path.join(target,'.ccr-bridge-kit.json'),m);save(settings,api.mergeHook({env:{KEEP:'fake'}},target));
  registration.register(home,target,port,id);
  const env={...process.env,HOME:home};
  for(const key of ['NODE_OPTIONS','BASH_ENV','CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT'])delete env[key];
  const run=(entry,args)=>spawnSync(process.execPath,[path.join(source,entry),...args],{env,encoding:'utf8',timeout:20000});
  return {home,target,settings,m,id,port,env,run};
}

test('trusted root alias is projected without following descendant links',()=>fixture(root=>{
  const home=path.join(root,'home'),alias=path.join(root,'trusted-home');fs.mkdirSync(home);fs.symlinkSync(home,alias);
  assert.equal(registration.normalizedPath(path.join(alias,'bridge'),[alias]),path.join(home,'bridge'));
  const child=path.join(home,'linked');fs.symlinkSync(root,child);
  assert.equal(registration.normalizedPath(child,[home]),child,'must not realpath a link below the trust root');
  assert.equal(registration.samePath(child,root,[home]),false);
  assert.equal(registration.samePath(alias,home,[home]),false,'an undeclared root alias is not trusted');
  for(const value of ['relative',home+'/.',home+'\0',home+'/../home'])assert.throws(()=>registration.normalizedPath(value,[home]));
}));

test('Android aliases normalize both ways without prefix collisions or foreign homes',t=>androidFixture(t,(root,alias)=>{
  for(const trust of [root,alias]){
    const expected=fs.realpathSync(root);
    assert.equal(registration.normalizedPath(alias,[trust]),expected);
    assert.equal(registration.normalizedPath(root,[trust]),expected);
    assert.equal(registration.normalizedPath(alias+'/missing/file',[trust]),expected+'/missing/file');
    assert.equal(registration.normalizedPath(alias+'-other',[trust]),expected+'-other');
    const foreign=alias.replace(/cc\.fork\.v4|[^/]+(?=\/files\/)/,'foreign.fake.package');
    if(foreign!==alias)assert.equal(registration.normalizedPath(foreign,[trust]),foreign);
  }
}));

for(const entry of ['installer.cjs','component.cjs']){
  for(const recordedAlias of [false,true])test(entry+' uninstalls alias '+(recordedAlias?'metadata':'argument')+' and removes only its own Hook',t=>androidFixture(t,root=>{
    const f=instance(root),alias=otherSpelling(f.target);
    if(recordedAlias){
      f.m.target=alias;f.m.settings=otherSpelling(f.settings);f.m.service.home=otherSpelling(f.home);f.m.componentEntry=otherSpelling(f.m.componentEntry);
      save(path.join(f.target,'.ccr-bridge-kit.json'),f.m);
      save(f.settings,api.mergeHook({env:{KEEP:'fake'}},alias));
      save(registration.fileOf(f.home),registration.value(alias,f.port,f.id));
    }
    const r=f.run(entry,['uninstall','--dir',recordedAlias?f.target:alias,'--endpoint','http://127.0.0.1:'+f.port,'--instance',f.id,'--yes']);
    assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)),{env:{KEEP:'fake'}});
    assert.equal(fs.existsSync(registration.fileOf(f.home)),false);
    assert.equal(fs.readFileSync(path.join(f.target,'disabled'),'utf8'),'uninstalled\n');
    assert.equal(fs.existsSync(f.target),true,'ordinary uninstall must preserve private data');
  }));
  test(entry+' alias ensure reaches recovery gate without clearing faults or changing metadata',t=>androidFixture(t,root=>{
    const f=instance(root);f.m.target=otherSpelling(f.target);f.m.service.home=otherSpelling(f.home);f.m.componentEntry=otherSpelling(f.m.componentEntry);
    save(path.join(f.target,'.ccr-bridge-kit.json'),f.m);
    const state=path.join(f.target,'runtime-home/.claude-code-router'),fault=path.join(state,'recovery.failed'),attempts=path.join(state,'recovery.attempts');
    fs.writeFileSync(fault,'fixture failure\n');fs.writeFileSync(attempts,'3\n');
    const manifest=fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json'));
    const r=f.run(entry,['ensure','--dir',otherSpelling(f.target),'--endpoint','http://127.0.0.1:'+f.port,'--instance',f.id]);
    assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.match(r.stderr,/启动失败或恢复次数已达上限/);
    assert.doesNotMatch(r.stderr,/路径不规范|标记不匹配|注册不匹配/);
    assert.equal(fs.readFileSync(fault,'utf8'),'fixture failure\n');assert.equal(fs.readFileSync(attempts,'utf8'),'3\n');
    assert.deepEqual(fs.readFileSync(path.join(f.target,'.ccr-bridge-kit.json')),manifest);
  }));
  test(entry+' still rejects alias paths hiding instance, state or registration symlinks',t=>androidFixture(t,root=>{
    for(const kind of ['target','runtime-home','registry']){
      const dir=path.join(root,kind);fs.mkdirSync(dir);const f=instance(dir);
      const victim=kind==='target'?f.target:kind==='runtime-home'?path.join(f.target,'runtime-home'):path.dirname(registration.fileOf(f.home));
      fs.renameSync(victim,victim+'-actual');fs.symlinkSync(victim+'-actual',victim);
      const r=f.run(entry,['uninstall','--dir',otherSpelling(f.target),'--endpoint','http://127.0.0.1:'+f.port,'--instance',f.id,'--yes']);
      assert.notEqual(r.status,0,r.stdout+r.stderr);assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
    }
  }));
}

test('alias component entry permits managed runtime upgrade without resetting recovery',t=>androidFixture(t,root=>{
  const f=instance(root),file=path.join(f.target,'bridge-common.sh');
  fs.appendFileSync(file,'\n# disposable previous runtime\n');f.m.files['bridge-common.sh']=hash(fs.readFileSync(file));
  f.m.target=otherSpelling(f.target);f.m.componentEntry=otherSpelling(f.m.componentEntry);f.m.service.home=otherSpelling(f.home);
  save(path.join(f.target,'.ccr-bridge-kit.json'),f.m);
  const state=path.join(f.target,'runtime-home/.claude-code-router');
  fs.writeFileSync(path.join(state,'recovery.failed'),'fixture failure\n');fs.writeFileSync(path.join(state,'recovery.attempts'),'3\n');
  const r=f.run('component.cjs',['ensure','--dir',otherSpelling(f.target),'--endpoint','http://127.0.0.1:'+f.port,'--instance',f.id]);
  assert.notEqual(r.status,0);assert.match(r.stderr,/启动失败或恢复次数已达上限/);
  assert.deepEqual(fs.readFileSync(file),fs.readFileSync(path.join(source,'runtime/bridge-common.sh')));
  assert.equal(fs.existsSync(path.join(f.target,'disabled')),false);
  assert.equal(fs.readFileSync(path.join(state,'recovery.failed'),'utf8'),'fixture failure\n');
  assert.equal(fs.readFileSync(path.join(state,'recovery.attempts'),'utf8'),'3\n');
}));

test('Hook merge deduplicates exact alias Hooks and rejects customized alias Hooks',t=>androidFixture(t,root=>{
  const f=instance(root),alias=otherSpelling(f.target),original={hooks:{SessionStart:[api.hookEntry(alias)]}};
  const merged=api.mergeHook(original,f.target);
  assert.deepEqual(merged.hooks.SessionStart,[api.hookEntry(f.target)]);
  const customized=structuredClone(original);customized.hooks.SessionStart[0].hooks[0].timeout=99;
  assert.throws(()=>api.mergeHook(customized,f.target),/被定制/);
  assert.deepEqual(api.removeHook(customized,f.target),customized,'do not remove a customized alias command');
}));

test('shell PID checks accept only the same alias script path',t=>androidFixture(t,root=>{
  const f=instance(root),cli=path.join(f.target,'node_modules/@musistudio/claude-code-router/dist/cli.js');
  fs.mkdirSync(path.dirname(cli),{recursive:true});fs.writeFileSync(cli,'setInterval(()=>{},1000);\n');
  const child=spawn(process.execPath,[otherSpelling(cli),'start'],{env:f.env,stdio:'ignore'});
  try{
    const r=spawnSync('bash',['-c','source "$1/bridge-common.sh" && bridge_process "$2"','fixture',f.target,String(child.pid)],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(r.status,0,r.stderr);
  }finally{child.kill('SIGTERM');}
}));

test('bind-mount-style aliases converge even if realpath retains their spelling',()=>{
  const code=fs.readFileSync(path.join(source,'runtime/service-registration.cjs'),'utf8'),module={exports:{}};
  const fakeFs={realpathSync:p=>p,lstatSync:p=>({dev:7,ino:p==='/data/data/test.app'||p==='/data/user/0/test.app'?42:99,isDirectory:()=>true})};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='node:fs'?fakeFs:require(name)});
  const normalize=module.exports.normalizedPath;
  for(const trust of ['/data/data/test.app/files/home','/data/user/0/test.app/files/home']){
    assert.equal(normalize('/data/data/test.app/files/home/bridge',[trust]),'/data/data/test.app/files/home/bridge');
    assert.equal(normalize('/data/user/0/test.app/files/home/bridge',[trust]),'/data/data/test.app/files/home/bridge');
    assert.equal(normalize('/data/user/0/other.app/files/home/bridge',[trust]),'/data/user/0/other.app/files/home/bridge');
  }
});

test('registration accepts only the same Android alias instance and preserves its spelling',t=>androidFixture(t,root=>{
  const f=instance(root),file=registration.fileOf(f.home),before=fs.readFileSync(file);
  assert.equal(registration.check(f.home,otherSpelling(f.target),f.port,f.id),true);
  registration.register(f.home,otherSpelling(f.target),f.port,f.id);
  assert.deepEqual(fs.readFileSync(file),before,'checking aliases must not rewrite registration');
  assert.equal(registration.unregister(f.home,otherSpelling(f.target),'2'.repeat(32)),false);
  assert.equal(registration.unregister(f.home,otherSpelling(f.target),f.id),true);
}));
