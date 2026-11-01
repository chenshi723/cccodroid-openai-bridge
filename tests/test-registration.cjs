'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const api=require('../runtime/service-registration.cjs');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-reg-'));
const home=path.join(tmp,'home'),a=path.join(tmp,'a'),b=path.join(tmp,'b');
const one='1'.repeat(32),two='2'.repeat(32);
let count=0;
function test(name,fn){fn();console.log('PASS '+name);count++;}
(async()=>{
try{
  test('registration contains only versioned non-secret instance metadata',()=>{
    const r=api.register(home,a,34591,one);
    assert.deepEqual(Object.keys(r),['schema','id','endpoint','runtimeDir','instanceId']);
    assert.equal(api.check(home,a,34591,one),true);
    assert.equal(fs.statSync(api.fileOf(home)).mode&0o777,0o600);
    assert.deepEqual(api.register(home,a,34591,one),r);
  });
  test('different runtime cannot overwrite or remove another registration',()=>{
    assert.throws(()=>api.register(home,b,34592,two),/未覆盖/);
    assert.equal(api.unregister(home,b,two),false);
    assert.equal(api.unregister(home,a,two),false);
    assert.equal(api.check(home,a,34591,one),true);
    assert.equal(api.unregister(home,a,one),true);
    assert.equal(api.read(home),null);
  });
  test('invalid endpoints and instance IDs are refused',()=>{
    for(const port of [0,1023,65536,3.5,'34591'])assert.throws(()=>api.register(home,a,port,one));
    assert.throws(()=>api.register(home,'relative',34591,one));
    assert.throws(()=>api.register(home,a,34591,'not-an-instance'));
    assert.equal(api.read(home),null);
  });
  test('symlink registry is rejected without replacing its destination',()=>{
    const dest=path.join(tmp,'destination');fs.writeFileSync(dest,'null');
    fs.symlinkSync(dest,api.fileOf(home));
    assert.throws(()=>api.register(home,a,34591,one),/普通文件/);
    assert.equal(fs.readFileSync(dest,'utf8'),'null');
    fs.unlinkSync(api.fileOf(home));
  });
  const lib=path.resolve(__dirname,'../runtime/service-registration.cjs');
  const run=(dir,instance)=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['-e',`try{require(${JSON.stringify(lib)}).register(${JSON.stringify(home)},${JSON.stringify(dir)},34591,${JSON.stringify(instance)});}catch{process.exitCode=1;}`],{stdio:'ignore'});
    p.once('error',reject);p.once('exit',resolve);
  });
  const statuses=await Promise.all([run(a,one),run(b,two)]);
  assert.deepEqual(statuses.sort(),[0,1]);
  const r=api.read(home);assert([a,b].includes(r.runtimeDir));
  assert.equal(fs.readdirSync(path.dirname(api.fileOf(home))).some(n=>n.includes('.tmp-')),false);
  count++;console.log('PASS concurrent registrations publish exactly one complete instance');
  console.log(count+' registration tests passed');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
