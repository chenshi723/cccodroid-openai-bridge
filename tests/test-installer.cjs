#!/usr/bin/env node
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const child=require('node:child_process');
const api=require('../installer.cjs');
const target='/private/example/bridge with apostrophe\'s';
const valid={endpoint:'https://api.example.com/v1/chat/completions',apiKey:'test-only',model:'model-test'};

test('merges exactly one own SessionStart hook without changing other settings',()=>{
  const src={env:{CUSTOM:'keep'},permissions:{allow:['Read']},hooks:{SessionStart:[{matcher:'startup',hooks:[{type:'command',command:'printf existing'}]}],Stop:[{hooks:[{type:'command',command:'printf stop'}]}]}};
  const copy=structuredClone(src),out=api.mergeHook(src,target);
  assert.deepEqual(src,copy);
  assert.deepEqual(out.env,src.env);
  assert.deepEqual(out.hooks.Stop,src.hooks.Stop);
  assert.deepEqual(out.hooks.SessionStart[0],src.hooks.SessionStart[0]);
  assert.equal(out.hooks.SessionStart.length,2);
  assert.deepEqual(api.mergeHook(out,target),out);
});
test('uninstall restores semantic settings and preserves user hooks',()=>{
  const src={env:{CUSTOM:'keep'},hooks:{SessionStart:[{hooks:[{type:'command',command:'printf existing'}]}]}};
  assert.deepEqual(api.removeHook(api.mergeHook(src,target),target),src);
  assert.deepEqual(api.removeHook(api.mergeHook({},target),target),{});
});
test('uninstall removes only its exact hook from a mixed group',()=>{
  const own=api.hookEntry(target).hooks[0];
  const src={hooks:{SessionStart:[{matcher:'startup',hooks:[own,{type:'command',command:'keep'}]}]}};
  assert.deepEqual(api.removeHook(src,target).hooks.SessionStart,[{matcher:'startup',hooks:[{type:'command',command:'keep'}]}]);
});
test('modified own hook is not silently replaced',()=>{
  const src=api.mergeHook({},target);
  src.hooks.SessionStart[0].hooks[0].timeout=999;
  assert.throws(()=>api.mergeHook(src,target),/定制/);
  assert.deepEqual(api.removeHook(src,target),src);
});
test('shell quoting preserves spaces, quotes, dollar signs and unicode',()=>{
  const value="a'b 中文 $HOME `uname` ; end";
  const r=child.spawnSync('bash',['-c','printf %s '+api.quote(value)],{encoding:'utf8'});
  assert.equal(r.status,0);
  assert.equal(r.stdout,value);
});
test('accepts valid HTTPS endpoint and local HTTP test endpoint',()=>{
  assert.equal(api.validateConfig(valid,3459).model,'model-test');
  assert.equal(api.validateConfig({...valid,endpoint:'http://127.0.0.1:12345/v1/chat/completions'},3459).apiKey,'test-only');
});
test('rejects insecure remote HTTP, credentials and URL query secrets',()=>{
  for(const endpoint of ['http://example.com/v1/chat/completions','https://user:pass@example.com/a','https://example.com/a?key=secret','https://example.com/a#fragment','file:///etc/passwd']){
    assert.throws(()=>api.validateConfig({...valid,endpoint},3459));
  }
});
test('rejects missing keys, bad model and invalid ports',()=>{
  for(const c of [{...valid,apiKey:''},{...valid,apiKey:'a\nb'},{...valid,model:''},{...valid,model:'a,b'}])assert.throws(()=>api.validateConfig(c,3459));
  for(const p of [0,1023,65536,3459.5,NaN])assert.throws(()=>api.validateConfig(valid,p));
});
test('router config uses fresh local key and never mutates input',()=>{
  const out=api.routerConfig(valid,3459,'local-test-only');
  assert.equal(out.APIKEY,'local-test-only');
  assert.equal(out.Providers[0].api_key,'test-only');
  assert.equal(out.HOST,'127.0.0.1');
  assert.equal(out.LOG_LEVEL,'info');
  assert.equal(out.Router.default,'relay,model-test');
});
test('settings with invalid JSON, wrong schema or all hooks disabled are rejected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kit-unit-'));
  const file=path.join(dir,'settings.json');
  try{
    for(const v of ['{bad','[]','{"hooks":[]}','{"hooks":{"SessionStart":{}}}','{"disableAllHooks":true}']){
      fs.writeFileSync(file,v);
      assert.throws(()=>api.readSettings(file));
    }
    fs.writeFileSync(file,'{"disableAllHooks":true}');
    assert.equal(api.readSettings(file,true).disableAllHooks,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('settings symbolic links are rejected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kit-unit-'));
  try{
    fs.writeFileSync(path.join(dir,'actual'),'{}');
    fs.symlinkSync(path.join(dir,'actual'),path.join(dir,'linked'));
    assert.throws(()=>api.readSettings(path.join(dir,'linked')),/符号链接/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('safeTarget refuses root, HOME, shared storage and target containing settings',()=>{
  for(const d of ['/','/sdcard/cccodroid/unsafe','/storage/emulated/0/unsafe',os.homedir()])assert.throws(()=>api.safeTarget(d,'/private/settings.json'));
  assert.throws(()=>api.safeTarget('/private/install','/private/install/settings.json'));
});
test('atomic writes replace complete content with private permissions and no temp remnants',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kit-unit-'));
  try{
    const f=path.join(dir,'settings.json');
    api.atomic(f,'first');api.atomic(f,'second');
    assert.equal(fs.readFileSync(f,'utf8'),'second');
    assert.equal(fs.statSync(f).mode&0o777,0o600);
    assert.deepEqual(fs.readdirSync(dir),['settings.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('parser accepts supported flags and rejects unknown or missing values',()=>{
  assert.deepEqual(api.parse(['--yes','--start','--port','3459']),{yes:true,start:true,port:'3459'});
  assert.deepEqual(api.parse(['--bundled-runtime','/private/component']),{'bundled-runtime':'/private/component'});
  assert.throws(()=>api.parse(['--api-key','secret']));
  assert.throws(()=>api.parse(['--dir']));
});
test('preinstalled dependencies copy privately without symlinking the mutable runtime',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kit-bundled-'));
  try{
    const source=path.join(dir,'source'),dest=path.join(dir,'dest');
    const pkg=path.join(source,'node_modules/@musistudio/claude-code-router');
    fs.mkdirSync(pkg,{recursive:true});
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'1.0.73'}));
    fs.writeFileSync(path.join(pkg,'cli.js'),'original');
    fs.symlinkSync('cli.js',path.join(pkg,'local-link'));
    api.copyBundledRuntime(source,dest);
    const copied=path.join(dest,'node_modules/@musistudio/claude-code-router/cli.js');
    fs.writeFileSync(copied,'modified-private-copy');
    assert.equal(fs.readFileSync(path.join(pkg,'cli.js'),'utf8'),'original');
    assert.equal(fs.readlinkSync(path.join(dest,'node_modules/@musistudio/claude-code-router/local-link')),'cli.js');
    fs.symlinkSync('/private/outside',path.join(pkg,'unsafe-link'));
    assert.throws(()=>api.copyBundledRuntime(source,path.join(dir,'unsafe-dest')),/链接越界/);
    assert.equal(fs.existsSync(path.join(dir,'unsafe-dest')),false);
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'3.0.0'}));
    assert.throws(()=>api.copyBundledRuntime(source,path.join(dir,'wrong-version')),/版本不匹配/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
