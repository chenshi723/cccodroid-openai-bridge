#!/usr/bin/env node
// 无第三方依赖的安装器；不读取打包者的配置，不把密钥放进命令行或日志。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const readline = require('node:readline/promises');
const {Writable} = require('node:stream');

const VERSION = '1.0.4';
const CCR_VERSION = '1.0.73';
const MARKER = '.ccr-bridge-kit.json';
const SOURCE = __dirname;
const RUNTIME_FILES = ['bridge-common.sh','start-bridge.sh','watchdog.sh','patch-ccr.js','health.cjs'];
const COMMANDS = new Set(['install','status','start','stop','uninstall','connection']);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function atomic(file, content, mode=0o600) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp = path.join(path.dirname(file),'.kit-'+crypto.randomUUID()+'.tmp');
  try {
    fs.writeFileSync(temp,content,{flag:'wx',mode});
    fs.renameSync(temp,file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function json(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function object(value) { return value !== null && typeof value==='object' && !Array.isArray(value); }
function same(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
function exists(file) { try { fs.lstatSync(file); return true; } catch(e) { if(e.code==='ENOENT')return false; throw e; } }
function backup(file) {
  const dest = file+'.bridge-kit-backup-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');
  fs.copyFileSync(file,dest,fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest,0o600);
  return dest;
}
function run(command,args,options={}) {
  const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,...options});
  if(r.error)throw new Error(`${command} 执行失败：${r.error.message}`);
  return r;
}
function checkTools(bundled) {
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('需要 Node.js 22 或更新版本。');
  const tools=['flock','setsid','timeout','readlink','tee'];
  if(!bundled)tools.push('npm');
  const r=run('bash',['-c','for x in "$@"; do command -v "$x" >/dev/null || { printf "missing: %s\\n" "$x"; exit 1; }; done; [[ ${BASH_VERSINFO[0]} -ge 4 ]]','bridge-tools',...tools]);
  if(r.status!==0)throw new Error('缺少运行依赖（Bash 4+、flock、setsid、timeout 等）：'+r.stdout+r.stderr);
  if(!fs.existsSync('/proc/self/cmdline'))throw new Error('当前安装包只支持具有 /proc 的 Android/Linux，不支持 Windows/macOS。');
}
function safeTarget(input,settings) {
  const target=path.resolve(input);
  const home=path.resolve(os.homedir());
  if(target==='/'||target===home||path.basename(target)==='.claude')throw new Error('安装目录必须是专用子目录，不能是根目录、HOME 或 .claude。');
  if(settings===target || settings.startsWith(target+path.sep))throw new Error('Claude 设置不能放进安装目录，避免卸载误删。');
  let p=target;
  while(!exists(p))p=path.dirname(p);
  const resolved=path.join(fs.realpathSync(p),path.relative(p,target));
  if(/^\/(sdcard|storage|mnt\/media_rw)(\/|$)/.test(resolved))throw new Error('不能安装到共享存储。请使用应用私有目录；ZIP 可以保存在共享目录。');
  if(exists(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('安装目标不能是符号链接。');
  return target;
}
function readSettings(file,allowDisabled=false) {
  if(!exists(file))return {};
  if(fs.lstatSync(file).isSymbolicLink())throw new Error('设置文件是符号链接，拒绝自动修改。');
  const value=json(file);
  if(!object(value)||value.hooks!==undefined&&!object(value.hooks))throw new Error('Claude 设置必须是 JSON 对象，hooks 也必须是对象。');
  if(value.disableAllHooks===true&&!allowDisabled)throw new Error('Claude 已禁用所有 hooks，请先由使用者自行启用。');
  if(value.hooks?.SessionStart!==undefined&&!Array.isArray(value.hooks.SessionStart))throw new Error('已有 SessionStart 不是数组，未修改任何设置。');
  return value;
}
function hookEntry(target) {
  return {matcher:'startup|resume',hooks:[{type:'command',command:'bash '+quote(path.join(target,'start-bridge.sh'))+' --hook',timeout:20}]};
}
function legacyHookEntry(target) {
  return {hooks:[{type:'command',command:'bash '+quote(path.join(target,'start-bridge.sh')),timeout:120}]};
}
function mergeHook(settings,target) {
  const result=structuredClone(settings);
  result.hooks??={};
  result.hooks.SessionStart??=[];
  const entry=hookEntry(target), expected=entry.hooks[0], legacy=legacyHookEntry(target).hooks[0];
  let current=false, old=false;
  for(const group of result.hooks.SessionStart){
    for(const hook of Array.isArray(group?.hooks)?group.hooks:[]){
      if(hook?.command===expected.command){
        if(!same(hook,expected)||group?.matcher!==entry.matcher)throw new Error('已有同路径 hook 被定制，拒绝覆盖。');
        current=true;
      }else if(hook?.command===legacy.command){
        if(!same(hook,legacy))throw new Error('已有同路径 hook 被定制，拒绝覆盖。');
        old=true;
      }
    }
  }
  if(old || current){
    result.hooks.SessionStart=result.hooks.SessionStart.flatMap(g=>{
      if(!Array.isArray(g?.hooks))return [g];
      const hooks=g.hooks.filter(h=>h?.command!==legacy.command&&h?.command!==expected.command);
      if(hooks.length===g.hooks.length)return [g];
      return hooks.length?[{...g,hooks}]:[];
    });
  }
  result.hooks.SessionStart.push(entry);
  return result;
}
function removeHook(settings,target) {
  const result=structuredClone(settings);
  if(!result.hooks?.SessionStart)return result;
  const expected=hookEntry(target).hooks[0], legacy=legacyHookEntry(target).hooks[0];
  result.hooks.SessionStart=result.hooks.SessionStart.flatMap(g=>{
    if(!Array.isArray(g?.hooks))return [g];
    const hooks=g.hooks.filter(h=>!same(h,expected)&&!same(h,legacy));
    if(hooks.length===g.hooks.length)return [g];
    return hooks.length?[{...g,hooks}]:[];
  });
  if(!result.hooks.SessionStart.length)delete result.hooks.SessionStart;
  if(!Object.keys(result.hooks).length)delete result.hooks;
  return result;
}
function copyBundledRuntime(source,dest) {
  const modules=path.join(source,'node_modules');
  const pkg=json(path.join(modules,'@musistudio/claude-code-router/package.json'));
  if(pkg.version!==CCR_VERSION)throw new Error('预装 CCR 版本不匹配。');
  function check(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){
        const link=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),link);
        if(path.isAbsolute(link)||!resolved.startsWith(modules+path.sep))throw new Error('预装依赖链接越界。');
      }else if(entry.isDirectory())check(file);
    }
  }
  check(modules);
  fs.cpSync(modules,path.join(dest,'node_modules'),{recursive:true,verbatimSymlinks:true});
}
function validateConfig(value,port) {
  if(!object(value))throw new Error('配置输入必须是 JSON 对象。');
  const endpoint=String(value.endpoint||'').trim();
  let url;
  try{url=new URL(endpoint);}catch{throw new Error('endpoint 不是有效 URL。');}
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('上游必须使用 HTTPS（仅本机测试允许 HTTP）。');
  if(url.username||url.password||url.search||url.hash)throw new Error('上游 URL 不能含认证信息、查询参数或片段；密钥应填写在 apiKey。');
  const apiKey=String(value.apiKey||'').trim();
  if(!apiKey||/[\r\n\0]/.test(apiKey))throw new Error('apiKey 不能为空或含换行。');
  const model=String(value.model||'').trim();
  if(!model||/[,\r\n\0]/.test(model))throw new Error('model 不能为空或包含逗号/换行。');
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口须为 1024–65535 的整数。');
  return {endpoint:url.href,apiKey,model};
}
function routerConfig(c,port,key) {
  const route='relay,'+c.model;
  return {HOST:'127.0.0.1',PORT:port,APIKEY:key,LOG:true,LOG_LEVEL:'info',API_TIMEOUT_MS:600000,NON_INTERACTIVE_MODE:true,
    Providers:[{name:'relay',api_base_url:c.endpoint,api_key:c.apiKey,models:[c.model]}],
    Router:{default:route,background:route,think:route,longContext:route,longContextThreshold:60000,webSearch:route}};
}
function portFree(port) {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.once('error',()=>resolve(false));
    server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));
  });
}
async function choosePort() {
  for(let p=3459;p<3490;p++)if(await portFree(p))return p;
  throw new Error('3459–3489 端口均占用，请用 --port 指定空闲端口。');
}
async function ask(label,def='') {
  const r=readline.createInterface({input:process.stdin,output:process.stdout});
  try{return (await r.question(label+(def?' ['+def+']':'')+'：')).trim()||def;}finally{r.close();}
}
async function askSecret() {
  let hidden=false;
  const output=new Writable({write(chunk,enc,cb){if(!hidden)process.stdout.write(chunk);cb();}});
  const r=readline.createInterface({input:process.stdin,output,terminal:true});
  try{
    process.stdout.write('上游 API Key（不回显）：');
    hidden=true;
    const key=await r.question('');
    hidden=false;
    process.stdout.write('\n');
    return key.trim();
  }finally{r.close();}
}
function cleanEnv() {
  const env={...process.env};
  for(const k of ['CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT'])delete env[k];
  return env;
}
function wrapper(target,command) {
  return '#!/bin/bash\nHERE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}\")" && pwd -P) || exit 1\nexec node "$HERE/manage.cjs" '+command+' --dir "$HERE" "$@"\n';
}
function loadManifest(target) {
  const p=path.join(target,MARKER);
  if(!exists(p))throw new Error('该目录不是由本安装器管理的安装：'+target);
  const m=json(p);
  if(m.id!=='ccr-bridge-kit'||m.version!==VERSION||path.resolve(m.target)!==target)throw new Error('安装标记不匹配，拒绝操作。');
  return m;
}
function managedIntact(target,m) {
  for(const [name,hash] of Object.entries(m.files)){
    const p=path.join(target,name);
    if(!exists(p)||fs.lstatSync(p).isSymbolicLink()||sha(fs.readFileSync(p))!==hash)throw new Error('安装文件被修改，拒绝静默覆盖：'+p);
  }
}
function showConnection(target,showKey=false) {
  const m=loadManifest(target);
  const keyfile=path.join(target,'connection.json');
  const c=json(keyfile);
  console.log('本机服务地址：'+c.baseUrl);
  console.log('模型：'+c.model);
  console.log('本地桥密钥文件（请勿转发）：'+keyfile);
  if(showKey)console.log('本地桥 API Key：'+c.apiKey);
  console.log('Claude 设置：'+m.settings);
}
async function health(target) {
  const c=json(path.join(target,'connection.json'));
  return await new Promise(resolve=>{
    const req=http.get(c.baseUrl+'/health',{timeout:2500},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>{
        try{resolve(res.statusCode===200&&JSON.parse(body).status==='ok');}catch{resolve(false);}
      });
    });
    req.on('timeout',()=>{req.destroy();resolve(false);});req.on('error',()=>resolve(false));
  });
}
async function install(options) {
  const bundled=options['bundled-runtime']?path.resolve(options['bundled-runtime']):null;
  checkTools(bundled);
  const settings=path.resolve(options.settings||path.join(os.homedir(),'.claude','settings.json'));
  const target=safeTarget(options.dir||path.join(os.homedir(),'.local','share','ccr-bridge-kit'),settings);
  if(exists(target)){
    const m=loadManifest(target);
    managedIntact(target,m);
    if(m.settings!==settings)throw new Error('重复安装不能更换 settings 路径。');
    if(options.config||options.port)throw new Error('重复安装不会覆盖现有密钥/端口；如需重配，请先卸载并备份自己的配置。');
    const original=readSettings(settings),merged=mergeHook(original,target);
    if(!same(original,merged)){if(exists(settings))backup(settings);atomic(settings,JSON.stringify(merged,null,2)+'\n');}
    console.log('已安装，文件与配置均未覆盖。');
    showConnection(target);
    if(options.start){const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:110000,stdio:'inherit'});if(r.status!==0)throw new Error('启动失败，请查看安装目录中的日志。');}
    return;
  }
  const original=readSettings(settings);
  mergeHook(original,target); // 提前验证已有 hook，不要装到一半才发现冲突。
  let port=options.port===undefined?undefined:Number(options.port);
  let config;
  if(options.config){
    const p=path.resolve(options.config);
    config=json(p);
    if(port===undefined&&config.port!==undefined)port=Number(config.port);
  }else{
    if(!process.stdin.isTTY)throw new Error('非交互安装需要 --config 指向私有 JSON 配置；不要把 API Key 写进命令行。');
    config={endpoint:await ask('上游完整 OpenAI Chat Completions URL（含路径）'),apiKey:await askSecret(),model:await ask('模型名')};
  }
  port??=await choosePort();
  config=validateConfig(config,port);
  if(!await portFree(port))throw new Error('端口已占用：'+port+'；请改用 --port。');
  console.log('安装目录：'+target);
  console.log(bundled?'将复制组件内固定版本 CCR 1.0.73 到专用运行目录；不联网安装、不测试远端模型。':'将联网从 npm 下载固定版本 CCR 1.0.73；不向模型服务发送测试请求。');
  if(!options.yes){
    if(!process.stdin.isTTY)throw new Error('非交互安装还需要 --yes。');
    if((await ask('继续安装？输入 yes'))!=='yes')throw new Error('已取消，未修改设置。');
  }
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  const stage=fs.mkdtempSync(path.join(path.dirname(target),'.ccr-kit-stage-'));
  let deployed=false;
  try{
    for(const name of RUNTIME_FILES)fs.copyFileSync(path.join(SOURCE,'runtime',name),path.join(stage,name));
    for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(SOURCE,name),path.join(stage,name));
    fs.copyFileSync(__filename,path.join(stage,'manage.cjs'));
    for(const [file,cmd] of [['stop.sh','stop'],['uninstall.sh','uninstall'],['status.sh','status']])atomic(path.join(stage,file),wrapper(target,cmd),0o700);
    for(const name of ['LICENSE-CCR.txt','LICENSE','README.md'])if(exists(path.join(SOURCE,name)))fs.copyFileSync(path.join(SOURCE,name),path.join(stage,name));
    if(bundled){
      copyBundledRuntime(bundled,stage);
    }else{
      const npm=run('npm',['ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--loglevel=error'],{cwd:stage,timeout:300000,stdio:'inherit',env:cleanEnv()});
      if(npm.status!==0)throw new Error('npm 依赖安装失败，未修改 Claude 设置。');
    }
    const pkg=json(path.join(stage,'node_modules/@musistudio/claude-code-router/package.json'));
    if(pkg.version!==CCR_VERSION)throw new Error('CCR 版本不匹配。');
    const patch=run(process.execPath,[path.join(stage,'patch-ccr.js')],{timeout:20000});
    if(![0,2].includes(patch.status))throw new Error('补丁应用失败，未修改 Claude 设置：'+patch.stderr);
    const state=path.join(stage,'runtime-home','.claude-code-router');
    const localKey=crypto.randomBytes(24).toString('hex');
    atomic(path.join(stage,'port'),String(port)+'\n');
    atomic(path.join(state,'config.json'),JSON.stringify(routerConfig(config,port,localKey),null,2)+'\n');
    atomic(path.join(stage,'connection.json'),JSON.stringify({baseUrl:'http://127.0.0.1:'+port,apiKey:localKey,model:config.model},null,2)+'\n');
    const files={};
    for(const name of [...RUNTIME_FILES,'manage.cjs','stop.sh','uninstall.sh','status.sh','package.json','package-lock.json','port']){
      const p=path.join(stage,name);fs.chmodSync(p,name.endsWith('.sh')?0o700:0o600);files[name]=sha(fs.readFileSync(p));
    }
    const current=readSettings(settings);
    if(!same(current,original))throw new Error('安装期间 Claude 设置被其他程序修改，已停止，未覆盖。');
    const merged=mergeHook(current,target);
    const saved=exists(settings)?backup(settings):null;
    atomic(path.join(stage,MARKER),JSON.stringify({id:'ccr-bridge-kit',version:VERSION,target,settings,settingsBackup:saved,componentEntry:path.join(SOURCE,'component.cjs'),hook:hookEntry(target),files},null,2)+'\n');
    fs.renameSync(stage,target);deployed=true;
    try{atomic(settings,JSON.stringify(merged,null,2)+'\n');}
    catch(e){throw new Error('安装文件已保留，但钩子写入失败；修正权限后重新执行安装器即可。'+e.message);}
    console.log('安装完成；已合并 SessionStart 钩子，未修改客户端全局认证。');
    showConnection(target);
    console.log('先在 App/客户端中填写上述本机服务地址、自己的模型和本地桥密钥，再开始新会话。');
    if(options.start){
      const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:110000,stdio:'inherit'});
      if(r.status!==0)throw new Error('文件已安装，但启动失败；请查看 '+path.join(target,'runtime-home','.claude-code-router','bridge.out'));
      console.log('本地桥健康检查通过。');
    }else console.log('下次会话自动启动；也可运行 bash '+quote(path.join(target,'start-bridge.sh')));
  }finally{
    if(!deployed&&exists(stage))fs.rmSync(stage,{recursive:true,force:true});
  }
}
function purgeTarget(target) {
  if(fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target)!==target)throw new Error('清理目标或父路径有符号链接，拒绝删除。');
  if(!target.startsWith(path.resolve(os.homedir())+path.sep) && !target.startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('清理目标必须位于私有 HOME 或临时目录的专用子目录。');
  const manifest=loadManifest(target);
  safeTarget(target,path.resolve(manifest.settings));
  return target;
}
async function confirmStop(target,options) {
  if(options.yes)return;
  if(!process.stdin.isTTY)throw new Error('此操作可能打断请求，需 --yes 或交互确认。');
  const message=options.purge?'将停止此安装并永久删除整个专用目录（含密钥、配置和日志）：'+target+'。输入 yes':'将停止此安装的看护和桥，可能打断请求。输入 yes';
  if((await ask(message))!=='yes')throw new Error('已取消。');
}
function stopManaged(target) {
  // 共享同一身份校验和 service.lock；绝不按名称批量 pkill。
  const script='source "$1/bridge-common.sh" || exit 1\n'+
    'if watchdog_running; then W=$(< "$STATE/watchdog.pid"); kill -TERM "$W" || exit 1; for _ in {1..40}; do watchdog_running || break; sleep 0.2; done; watchdog_running && exit 1; fi\n'+
    'exec 7> "$STATE/service.lock"; flock -w 10 7 || exit 1\n'+
    'P=$(bridge_pid) || P=; if [[ -n "$P" ]]; then bridge_stop "$P" || exit 1; fi\n';
  const r=run('bash',['-c',script,'bridge-kit-stop',target],{env:cleanEnv(),timeout:30000});
  if(r.status!==0)throw new Error('未能安全停止此安装，文件与钩子均保留：'+r.stderr);
}
async function manage(command,options) {
  const target=path.resolve(options.dir||SOURCE);
  const m=loadManifest(target);
  if(options.purge){
    if(command!=='uninstall')throw new Error('--purge 只适用于 uninstall。');
    purgeTarget(target);
  }
  if(command==='connection'){showConnection(target,options['show-key']);return;}
  if(command==='status'){
    console.log('安装版本：'+m.version+' / CCR '+CCR_VERSION);
    console.log('本地 HTTP 健康：'+(await health(target)?'正常（不代表上游推理成功）':'未运行或未就绪'));
    showConnection(target);return;
  }
  if(command==='start'){
    const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:110000,stdio:'inherit'});
    if(r.status!==0)throw new Error('启动失败。');return;
  }
  await confirmStop(target,options);
  if(command==='uninstall')readSettings(m.settings,true);
  stopManaged(target);
  if(command==='stop'){
    console.log('已停止；SessionStart 钩子仍在，下次会话会重新启动。永久停用请卸载。');return;
  }
  const before=readSettings(m.settings,true);
  const after=removeHook(before,target);
  if(!same(before,after)){if(exists(m.settings))backup(m.settings);atomic(m.settings,JSON.stringify(after,null,2)+'\n');}
  console.log('已停止并移除本安装的钩子，其他配置未动。');
  if(options.purge){
    purgeTarget(target);
    fs.rmSync(target,{recursive:true});
    console.log('已删除整个专用安装目录（含依赖、密钥、配置和日志）：'+target);
  }else console.log('安装目录和密钥保留：'+target+'；如需永久删除，确认备份后使用 uninstall --yes --purge。');
}
function parse(argv) {
  const out={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(!key.startsWith('--'))throw new Error('未知参数：'+key);
    const name=key.slice(2);
    if(['yes','start','show-key','help','purge'].includes(name)){out[name]=true;continue;}
    if(!['dir','settings','config','port','bundled-runtime'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('未知或缺值的参数：'+key);
    out[name]=argv[++i];
  }
  return out;
}
async function main() {
  process.umask(0o077);
  const [cmd='install',...argv]=process.argv.slice(2);
  const options=parse(argv);
  if(options.help){console.log('用法：bash install.sh [--config 私有JSON] [--port 端口] [--dir 安装目录] [--settings 设置路径] [--yes] [--start]\n管理：node manage.cjs status|start|stop|uninstall|connection --dir 安装目录 [--yes] [--show-key] [--purge（仅卸载，永久删除专用目录）]');return;}
  if(!COMMANDS.has(cmd))throw new Error('未知操作：'+cmd);
  if(options.purge&&cmd!=='uninstall')throw new Error('--purge 只适用于 uninstall。');
  if(cmd==='install')await install(options);else await manage(cmd,options);
}
if(require.main===module)main().catch(e=>{console.error('错误：'+e.message);process.exitCode=1;});
module.exports={atomic,mergeHook,removeHook,validateConfig,routerConfig,readSettings,safeTarget,hookEntry,legacyHookEntry,parse,quote,copyBundledRuntime,purgeTarget};
