'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const os=require('node:os');

// 只折叠调用者信任的根，以及同一 Android 应用的两种系统前缀。
// 不 realpath 整条输入：HOME/组件根以下的链接必须留给无链接校验拒绝。
function normalizedPath(file,roots=[os.homedir()]){
  if(typeof file!=='string'||file.includes('\0')||!path.isAbsolute(file)||path.resolve(file)!==file)throw new Error('路径不是规范绝对路径。');
  const under=(value,root)=>value===root||value.startsWith(root+path.sep);
  for(const root of roots){
    let real;try{real=fs.realpathSync(root);}catch{continue;}
    if(root!==real&&under(file,root))file=path.join(real,path.relative(root,file));
    const match=/^\/data\/(?:data|user\/0)\/[^/]+(?=\/|$)/.exec(real);
    if(!match)continue;
    const app=match[0],identity=fs.lstatSync(fs.realpathSync(app));
    const primary=app.replace(/^\/data\/user\/0\//,'/data/data/');
    let canonical=fs.realpathSync(app);
    try{const st=fs.lstatSync(primary);if(st.isDirectory()&&st.dev===identity.dev&&st.ino===identity.ino)canonical=fs.realpathSync(primary);}catch{}
    for(const alias of [primary,app.replace(/^\/data\/data\//,'/data/user/0/')]){
      if(!under(file,alias))continue;
      let st;try{st=fs.lstatSync(alias);}catch{continue;}
      if(st.isDirectory()&&st.dev===identity.dev&&st.ino===identity.ino)return path.join(canonical,path.relative(alias,file));
    }
  }
  return file;
}
function samePath(a,b,roots){try{return normalizedPath(a,roots)===normalizedPath(b,roots);}catch{return false;}}
function pathAliases(file){
  const canonical=normalizedPath(file),variants=[file,canonical];
  if(/^\/data\/(?:data|user\/0)\//.test(canonical))variants.push(canonical.replace(/^\/data\/data\//,'/data/user/0/'),canonical.replace(/^\/data\/user\/0\//,'/data/data/'));
  return [...new Set(variants)].filter(value=>samePath(value,canonical));
}

const ID='openai-bridge';
const fileOf=home=>path.join(home,'.cccodroid','services',ID+'.json');
function read(home){
  const file=fileOf(home);
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw new Error('服务注册不是有效普通文件。');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function value(target,port,instanceId){
  if(!path.isAbsolute(target)||path.resolve(target)!==target||!Number.isInteger(port)||port<1024||port>65535||!/^[0-9a-f]{32}$/.test(instanceId))throw new Error('服务注册参数不合法。');
  return {schema:1,id:ID,endpoint:'http://127.0.0.1:'+port,runtimeDir:target,instanceId};
}
function same(a,b){return !!a&&Object.keys(a).length===5&&!!b&&['schema','id','endpoint','instanceId'].every(k=>a[k]===b[k])&&samePath(a.runtimeDir,b.runtimeDir);}
function check(home,target,port,instanceId){return same(read(home),value(target,port,instanceId));}
function lock(home,fn){
  const dir=path.dirname(fileOf(home));
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const fd=fs.openSync(path.join(dir,ID+'.lock'),'a',0o600);
  const r=spawnSync('flock',['-w','5','3'],{stdio:['ignore','ignore','pipe',fd],encoding:'utf8',timeout:6000});
  if(r.error||r.status!==0){fs.closeSync(fd);throw new Error('服务注册正在使用，未修改。');}
  try{return fn();}finally{fs.closeSync(fd);}
}
function register(home,target,port,instanceId){return lock(home,()=>registerLocked(home,target,port,instanceId));}
function registerLocked(home,target,port,instanceId){
  const next=value(target,port,instanceId),current=read(home);
  if(current){
    if(same(current,next))return current;
    throw new Error('已有另一项本地桥服务注册；未覆盖。请先卸载原注册实例。');
  }
  const file=fileOf(home),dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=file+'.tmp-'+process.pid+'-'+crypto.randomBytes(6).toString('hex');
  try{
    fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});
    // flock 与原子改名配合：不依赖 Android 可能禁止的硬链接。
    fs.renameSync(temp,file);
  }finally{fs.rmSync(temp,{force:true});}
  return next;
}
function unregister(home,target,instanceId){return lock(home,()=>{
  const current=read(home);
  if(!current||current.id!==ID||current.schema!==1||!samePath(current.runtimeDir,target)||current.instanceId!==instanceId)return false;
  fs.unlinkSync(fileOf(home));
  return true;
});}
module.exports={fileOf,read,value,check,register,unregister,normalizedPath,samePath,pathAliases};
