#!/usr/bin/env node
'use strict';
// Opt-in HTTPS E2E: real App route -> fixture-CA component entry -> real TLS.
// The disposable entry adds only NODE_EXTRA_CA_CERTS before its unchanged logic;
// actual installer/helper bytes and production App/entry/trust roots are untouched.
// No Chromium, npm/build, private CCR, live config, remote inference, or real key.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const https=require('node:https');
const dns=require('node:dns/promises');
const {spawn,spawnSync}=require('node:child_process');
const fakeKey='fixture-models-e2e-dummy-key-NEVER-PRINT';
const providerKey='fixture-unrelated-provider-dummy-NEVER-PRINT';
const upstreamPrivate='fixture-upstream-private-diagnostic-NEVER-PRINT';
const maxResult=128<<10,maxResponse=1<<20;
const secrets=[fakeKey,providerKey,upstreamPrivate];
const clean=text=>secrets.reduce((s,secret)=>s.replaceAll(secret,'[redacted fixture value]'),String(text));
function noSecrets(text){for(const secret of secrets)assert(!String(text).includes(secret),'public output contains a private fixture value');}
function snapshot(root){
  const entries=[];
  function visit(file){
    const st=fs.lstatSync(file,{bigint:true}),name=path.relative(root,file);
    const meta={name,mode:String(st.mode),ino:String(st.ino),size:String(st.size),mtime:String(st.mtimeNs),ctime:String(st.ctimeNs)};
    if(st.isSymbolicLink())entries.push({...meta,link:fs.readlinkSync(file)});
    else if(st.isDirectory()){entries.push(meta);for(const name of fs.readdirSync(file).sort())visit(path.join(file,name));}
    else {assert(st.isFile(),'fixture must contain only regular files/directories/symlinks');entries.push({...meta,sha:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}
  }
  visit(root);return JSON.stringify(entries);
}
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});}
function track(server){
  const sockets=new Set();
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  // A rejected local fake certificate is expected; never print TLS error details.
  server.on('tlsClientError',()=>{});
  return async()=>{for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));};
}
function fixtures(source,root,stage){
  const home=path.join(root,'home'),prefix=path.join(root,'usr'),workspace=path.join(root,'workspace');
  for(const dir of [home,workspace,path.join(root,'runtime'),path.join(prefix,'bin'),path.join(prefix,'lib')])fs.mkdirSync(dir,{recursive:true});
  fs.symlinkSync(process.execPath,path.join(prefix,'bin/node'));
  // Materialize the release file allowlist, not a hand-picked bundle that could
  // accidentally hide a missing new module in the actual component archive.
  const recipe=JSON.parse(fs.readFileSync(path.join(source,'recipe/recipe.json'),'utf8'));
  for(const name of ['component.cjs','installer.cjs','gui-models.cjs'])
    assert(recipe.files?.['usr/lib/openai-bridge/'+name]?.src===name,'release recipe must include '+name);
  const sync=fs.readFileSync(path.join(source,'recipe/sync.sh'),'utf8');
  assert(/^for name in [^\n;]*\bgui-models\.cjs\b[^\n;]*; do cp -- "\$SOURCE\/\$name" "\$DEST\/\$name"; done$/m.test(sync),'recipe/sync.sh must ship gui-models.cjs to the market recipe');
  const files=[],stagePayloads=[];
  if(stage)assert(fs.lstatSync(stage).isDirectory()&&fs.realpathSync(stage)===stage,'models stage must be a canonical extracted component directory');
  for(const [destination,spec] of Object.entries(recipe.files)){
    assert(destination.startsWith('usr/')&&destination.split('/').every(p=>p&&p!=='.'&&p!=='..'),'invalid release destination');
    assert(typeof spec.src==='string'&&!path.isAbsolute(spec.src)&&spec.src.split('/').every(p=>p&&p!=='.'&&p!=='..'),'invalid release source');
    const candidates=[path.join(source,spec.src),path.join(source,'recipe',spec.src)];
    const repoFrom=candidates.find(file=>fs.existsSync(file));assert(repoFrom,'release source is missing: '+spec.src);
    assert(fs.lstatSync(repoFrom).isFile(),'release source must be a regular file');
    let from=repoFrom;
    if(stage&&destination.startsWith('usr/lib/openai-bridge/')){
      from=path.join(stage,destination.slice('usr/lib/openai-bridge/'.length));
      assert(fs.lstatSync(from).isFile()&&fs.realpathSync(from)===from,'staged payload must be a regular canonical file: '+destination);
      const payload=fs.readFileSync(from);
      assert(payload.equals(fs.readFileSync(repoFrom)),'staged archive payload differs from repository: '+destination);
      stagePayloads.push({destination,sha256:crypto.createHash('sha256').update(payload).digest('hex')});
    }
    const relative=destination.slice(4),to=path.join(prefix,relative);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
    if(spec.mode)fs.chmodSync(to,Number.parseInt(spec.mode,8));
    files.push(relative);
  }
  const record=path.join(root,'components/openai-bridge.json');fs.mkdirSync(path.dirname(record));
  fs.writeFileSync(record,JSON.stringify({id:'openai-bridge',state:'ok',files}),{mode:0o600});
  // All settings/providers are synthetic and seeded before the read-only baseline.
  fs.writeFileSync(path.join(home,'ccapp-providers.json'),JSON.stringify({active:'custom-7',providers:{'custom-7':{
    label:'Unrelated fixture',baseUrl:'https://unrelated.example.invalid',apiKey:providerKey,defaultModel:'fixture-current'
  }}}),{mode:0o600});
  fs.writeFileSync(path.join(home,'ccapp-settings.json'),JSON.stringify({provider:'custom-7',model:'fixture-current',permissionMode:'default',guard:true,permMigrated:1}),{mode:0o600});
  fs.mkdirSync(path.join(home,'.claude'));fs.writeFileSync(path.join(home,'.claude/settings.json'),'{"hooks":{}}\n',{mode:0o600});
  fs.mkdirSync(path.join(home,'.cache'));fs.writeFileSync(path.join(home,'.cache/llama-api-key'),'a'.repeat(48)+'\n',{mode:0o600});
  const foreign=path.join(home,'unrelated-runtime');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'must-not-change'),'fixture-owned-by-another-install\n');
  return {home,prefix,workspace,stagePayloads};
}
function certificates(root,env){
  const dir=path.join(root,'tls');fs.mkdirSync(dir,{mode:0o700});
  const file=name=>path.join(dir,name);
  const run=args=>{const r=spawnSync('openssl',args,{env,encoding:'utf8',timeout:20000});assert(!r.error&&r.status===0,'local openssl fixture generation failed (openssl is required)');};
  run(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Bridge models disposable test CA','-addext','basicConstraints=critical,CA:TRUE',
    '-keyout',file('ca.key'),'-out',file('ca.crt')]);
  run(['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',file('server.key'),'-out',file('server.csr')]);
  fs.writeFileSync(file('server.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  run(['x509','-req','-in',file('server.csr'),'-CA',file('ca.crt'),'-CAkey',file('ca.key'),'-CAcreateserial','-days','1','-extfile',file('server.ext'),'-out',file('server.crt')]);
  run(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost',
    '-keyout',file('untrusted.key'),'-out',file('untrusted.crt')]);
  for(const name of ['ca.key','server.key','untrusted.key'])fs.chmodSync(file(name),0o600);
  return {ca:file('ca.crt'),trusted:{key:fs.readFileSync(file('server.key')),cert:fs.readFileSync(file('server.crt'))},
    untrusted:{key:fs.readFileSync(file('untrusted.key')),cert:fs.readFileSync(file('untrusted.crt'))}};
}
function fixtureEntryCa(source,prefix,ca){
  // Authorized fixture-only trust provisioning. Production componentEnv correctly
  // drops NODE_EXTRA_CA_CERTS. Set it inside the disposable entry so the original
  // spawn of the real installer inherits it at Node startup, without a preload,
  // network mock, custom TLS options, or any production/environment policy edit.
  const kit=path.join(prefix,'lib/openai-bridge'),entry=path.join(kit,'component.cjs');
  const original=fs.readFileSync(path.join(source,'component.cjs'),'utf8');
  assert.equal(fs.readFileSync(entry,'utf8'),original,'fixture entry must first match the release source');
  const match=/^#![^\n]*\n/.exec(original),offset=match?match[0].length:0;
  const assignment='process.env.NODE_EXTRA_CA_CERTS = '+JSON.stringify(ca)+';\n';
  fs.writeFileSync(entry,original.slice(0,offset)+assignment+original.slice(offset));
  assert.equal(fs.readFileSync(entry,'utf8').replace(assignment,''),original,'entry differs only by the explicit temporary CA assignment after its shebang');
  const unchanged={};
  for(const name of ['installer.cjs','gui-models.cjs']){
    const actual=fs.readFileSync(path.join(kit,name)),expected=fs.readFileSync(path.join(source,name));
    assert(actual.equals(expected),'actual '+name+' must remain byte-identical to source');
    unchanged[name]=crypto.createHash('sha256').update(actual).digest('hex');
  }
  return {method:'fixture component.cjs adds one NODE_EXTRA_CA_CERTS assignment after its shebang before unchanged original logic',
    temporaryCaPathOnly:true,usedCcappGlibcPreload:false,usedLdPreloadInjection:false,productionEntryModified:false,productionComponentEnvModified:false,
    installerAndHelperByteIdentical:true,unchangedSha256:unchanged};
}
function runChild(env){
  return new Promise((resolve,reject)=>{
    // The script is a file, never an -e string containing fixture keys in argv.
    const child=spawn(process.execPath,[__filename,'--app-child'],{env,stdio:['ignore','pipe','pipe']});
    let out='',err='',timedOut=false,excess=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},90000);
    const kill=setTimeout(()=>child.kill('SIGKILL'),93000);
    const collect=(kind,chunk)=>{if(kind==='out')out+=chunk;else err+=chunk;if(out.length+err.length>256*1024){excess=true;child.kill('SIGTERM');}};
    child.stdout.on('data',b=>collect('out',b));child.stderr.on('data',b=>collect('err',b));
    child.on('error',error=>{clearTimeout(timer);clearTimeout(kill);reject(error);});
    child.on('close',status=>{clearTimeout(timer);clearTimeout(kill);resolve({status,out,err,timedOut,excess});});
  });
}
async function appChild(){
  const root=process.env.OPENAI_BRIDGE_MODELS_ROOT;
  assert(root&&fs.realpathSync(root)===root,'child requires a canonical disposable root');
  assert(process.env.HOME===path.join(root,'home')&&process.env.CCAPP_HOME===process.env.HOME&&process.env.PREFIX===path.join(root,'usr')&&process.env.CCAPP_PREFIX===process.env.PREFIX&&process.env.CCAPP_TEST==='1','never import App modules with a real HOME/PREFIX');
  assert(process.env.NODE_EXTRA_CA_CERTS===path.join(root,'tls/ca.crt'),'only the disposable CA is trusted by this test child');
  assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED===undefined,'TLS verification must not be disabled');
  const protectedFiles=['ccapp-providers.json','ccapp-settings.json','.claude/settings.json'];
  const protectedBefore=protectedFiles.map(name=>snapshot(path.join(process.env.HOME,name)));
  const {pathToFileURL}=require('node:url');
  const http=require('node:http'),diagnostics=require('node:diagnostics_channel');
  const calls=[];
  // Passive observation only: do not wrap/mock spawn, component, HTTPS, or TLS.
  const observe=message=>queueMicrotask(()=>calls.push({child:message.process,args:message.process.spawnargs?.slice()}));
  diagnostics.subscribe('child_process',observe);
  const stopChildren=()=>{for(const {child} of calls)if(child.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGTERM');}catch{}};
  const onTerm=()=>{stopChildren();process.exit(1);};process.once('SIGTERM',onTerm);
  const dir=path.join(process.env.OPENAI_BRIDGE_APP_SOURCE,'gateway/gw');
  const {routeComponents}=await import(pathToFileURL(path.join(dir,'components.mjs')));
  const providers=await import(pathToFileURL(path.join(dir,'providers.mjs')));
  const {SETTINGS}=await import(pathToFileURL(path.join(dir,'settings-store.mjs')));
  // App imports create their own disposable gateway token/usage files before
  // serving any request. Baseline after that lifecycle work, without exempting
  // any file from subsequent model-request write checks.
  assert(protectedFiles.every((name,i)=>snapshot(path.join(process.env.HOME,name))===protectedBefore[i]),'App import must preserve synthetic providers/settings');
  const before=snapshot(root);
  const providerState=JSON.stringify({current:providers.PROVIDER,all:providers.PROVIDERS_CFG}),settingsState=JSON.stringify(SETTINGS);
  const server=http.createServer(async(req,res)=>{try{
    const u=new URL(req.url,'http://127.0.0.1');await routeComponents(req,res,u,u.pathname);
    if(!res.headersSent){res.writeHead(404,{'content-type':'application/json'});res.end('{"ok":false,"code":"fixture_no_route"}');}
  }catch{if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end('{"ok":false,"code":"fixture_route_failure"}');}});
  const close=track(server);await listen(server);
  const url='http://127.0.0.1:'+server.address().port+'/api/components/openai-bridge/models';
  const base=process.env.OPENAI_BRIDGE_MODELS_BASE;
  const entry=path.join(process.env.PREFIX,'lib/openai-bridge/component.cjs');
  let requests=0;
  function readonly(){
    const after=snapshot(root);
    const prior=new Map(JSON.parse(before).map(entry=>[entry.name,JSON.stringify(entry)]));
    const changed=JSON.parse(after).filter(entry=>prior.get(entry.name)!==JSON.stringify(entry)).map(entry=>entry.name);
    assert(after===before,'models route must not create or write runtime/providers/settings/records/logs; changed fixture paths: '+changed.join(', '));
    assert(JSON.stringify({current:providers.PROVIDER,all:providers.PROVIDERS_CFG})===providerState,'models route must preserve provider state');
    assert(JSON.stringify(SETTINGS)===settingsState,'models route must preserve all settings');
    assert(!fs.existsSync(path.join(process.env.HOME,'.local/share/ccr-bridge-kit')),'models listing must not install/start a private runtime');
  }
  async function request(body,options={}){
    const count=calls.length,start=Date.now(),method=options.method||'POST';
    const response=await fetch(url,{method,headers:{'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});
    const text=await response.text();noSecrets(text);
    assert(Buffer.byteLength(text)<=maxResult,'App models response exceeds 128 KiB');
    const value=JSON.parse(text);
    assert(!/"(?:apiKey|api_key|keyTail|connectionPath|headers|stderr)"\s*:/.test(text),'App must not return credentials, paths or transport diagnostics');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length-count,options.component===false?0:1,'route invokes exactly one real fixed component, with no gui-status/configure/runtime preflight');
    for(const call of calls.slice(count)){
      assert(Array.isArray(call.args)&&call.args.length===3,'component argv contains only executable, fixed entry and command');
      assert(call.args[0]===process.execPath&&call.args[1]===entry&&call.args[2]==='gui-models','App must execute its installed fixed gui-models entry');
      noSecrets(JSON.stringify(call.args));assert(!call.args.some(arg=>arg.includes('https://')),'endpoint must travel on stdin, not argv');
    }
    readonly();requests++;return {status:response.status,value,elapsed:Date.now()-start};
  }
  const input=(name='v1')=>({endpoint:base+'/'+name+'/chat/completions///',apiKey:fakeKey,consent:true});
  const success=async(name,ids,truncated=false)=>{
    const r=await request(input(name));assert.equal(r.status,200,'trusted local HTTPS through real App/component must succeed; App code='+(r.value.code||'none'));
    assert.deepEqual(r.value,{ok:true,models:ids.map(id=>({id})),truncated});return r;
  };
  const error=async(body,code,options={})=>{
    const r=await request(body,options);assert.equal(r.status,options.status||400);assert.equal(r.value.ok,false);assert.equal(r.value.code,code);return r;
  };
  try{
    readonly();assert.equal(calls.length,0,'App test-mode imports must not start processes before the user model request');
    await error(undefined,'method',{method:'GET',status:405,component:false});
    await error({...input(),consent:false},'consent_required',{component:false});
    await error({...input(),endpoint:base.replace('https:','http:')+'/v1/chat/completions'},'invalid_endpoint',{component:false});
    await error({...input(),model:'not-part-of-discovery'},'consent_required',{component:false});
    const missing=await error({endpoint:input().endpoint,consent:true},'KEY_REQUIRED');assert.equal(missing.value.field,'apiKey');
    await success('v1',['fixture-model-a','fixture-model-b']);
    await success('tenant%2Fproject/v2',['fixture-prefix']);
    await success('empty',[]);
    await success('count',Array.from({length:500},(_,i)=>'fixture-model-'+i),true);
    const bytes=await request(input('bytes'));assert.equal(bytes.status,200);assert.equal(bytes.value.ok,true);assert.equal(bytes.value.truncated,true);
    assert(bytes.value.models.length>0&&bytes.value.models.length<500,'UTF-8 byte limit must apply before the 500-id cap');
    assert.deepEqual(bytes.value.models,Array.from({length:bytes.value.models.length},(_,i)=>({id:'模'.repeat(190)+'-'+String(i).padStart(3,'0')})));
    await success('exact',['fixture-exact-limit']);
    for(const name of ['large','large-chunked'])await error(input(name),'MODELS_TOO_LARGE');
    await error(input('invalid'),'MODELS_INVALID_RESPONSE');
    for(const [status,code] of [[401,'MODELS_AUTH'],[403,'MODELS_FORBIDDEN'],[404,'MODELS_NOT_FOUND'],[429,'MODELS_RATE_LIMIT']])await error(input('status-'+status),code);
    for(const status of [301,302,303,307,308])await error(input('redirect-'+status),'MODELS_REDIRECT');
    await error(input('redirect-same'),'MODELS_REDIRECT');
    await error({...input(),endpoint:process.env.OPENAI_BRIDGE_MODELS_UNTRUSTED+'/v1/chat/completions'},'MODELS_NETWORK');
    await error({...input(),endpoint:base.replace('localhost','127.0.0.1')+'/v1/chat/completions'},'MODELS_NETWORK');
    // A response that drips bytes never has an idle 12s window; only a real
    // absolute 12s network deadline beats the App's separate 15s launcher cap.
    const slow=await error(input('slow'),'MODELS_TIMEOUT');
    assert(slow.elapsed>=11000&&slow.elapsed<14900,'component must enforce its absolute 12s deadline, not the App 15s watchdog');
    readonly();console.log(JSON.stringify({ok:true,scope:'real App route + release-mapped component with explicit fixture-only CA assignment + unmodified installer/helper + real HTTPS',requests,
      fixedComponentInvocations:calls.length,noRuntimeOrProviderOrSettingsWrites:true,stdinOnly:true,tlsVerified:true,redirectsRejected:true,deadline12s:true,deadlineElapsedMs:slow.elapsed}));
  }finally{
    await close();stopChildren();diagnostics.unsubscribe('child_process',observe);process.removeListener('SIGTERM',onTerm);
  }
}
async function main(){
  assert(process.argv.length===2,'only the private test-child flag is accepted');
  const app=process.env.OPENAI_BRIDGE_APP_SOURCE;
  assert(app&&path.isAbsolute(app),'Set OPENAI_BRIDGE_APP_SOURCE to the App source checkout; this test is opt-in');
  assert(fs.lstatSync(path.join(app,'gateway/gw/components.mjs')).isFile(),'App route source is required');
  const source=path.resolve(process.env.OPENAI_BRIDGE_TEST_SOURCE||path.join(__dirname,'..'));
  const stage=process.env.OPENAI_BRIDGE_MODELS_STAGE?path.resolve(process.env.OPENAI_BRIDGE_MODELS_STAGE):undefined;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gui-models-app-'));
  const closes=[];
  try{
    const {home,prefix,workspace,stagePayloads}=fixtures(source,root,stage);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','LANG','TZ','TMPDIR','ANDROID_ROOT','ANDROID_DATA','LD_PRELOAD','LD_LIBRARY_PATH'].includes(key)));
    Object.assign(env,{HOME:home,PREFIX:prefix,CCAPP_HOME:home,CCAPP_PREFIX:prefix,CCAPP_WORKSPACE:workspace,CCAPP_RUNTIME:path.join(root,'runtime'),
      CCAPP_TEST:'1',CCAPP_LOG:path.join(root,'gateway.log'),CCAPP_SEED:path.join(home,'no-seed'),OPENAI_BRIDGE_APP_SOURCE:path.resolve(app),OPENAI_BRIDGE_MODELS_ROOT:root});
    const cert=certificates(root,env);
    const caProvisioning=fixtureEntryCa(source,prefix,cert.ca);
    const addresses=await dns.lookup('localhost',{all:true});assert(addresses.length&&addresses.every(a=>['127.0.0.1','::1'].includes(a.address)),'localhost must resolve only to loopback');
    assert(addresses[0].address==='127.0.0.1','fixture expects localhost IPv4; do not change DNS or network verification to bypass this check');
    const received=[];let sentinelRequests=0,untrustedRequests=0,inferenceRequests=0;
    const sentinel=https.createServer(cert.trusted,(_req,res)=>{sentinelRequests++;res.writeHead(500);res.end();});closes.push(track(sentinel));await listen(sentinel);
    const untrusted=https.createServer(cert.untrusted,(_req,res)=>{untrustedRequests++;res.end('{"data":[{"id":"must-not-be-trusted"}]}');});closes.push(track(untrusted));await listen(untrusted);
    const upstream=https.createServer(cert.trusted,(req,res)=>{
      const item={method:req.method,url:req.url,authorization:req.headers.authorization,bodyBytes:0};received.push(item);
      if(req.url.includes('/chat/completions')||req.url.includes('/messages'))inferenceRequests++;
      if(req.url.startsWith('/sentinel/'))sentinelRequests++;
      req.on('data',chunk=>item.bodyBytes+=chunk.length);
      req.on('end',()=>{
        const headers={'content-type':'application/json','x-private-fixture':upstreamPrivate};
        if(req.method!=='GET'||req.headers.authorization!=='Bearer '+fakeKey){res.writeHead(401,headers);res.end(upstreamPrivate);return;}
        if(/^\/redirect-(?:301|302|303|307|308)\/models$/.test(req.url)){
          const code=Number(req.url.split('/')[1].split('-')[1]);res.writeHead(code,{...headers,location:'https://localhost:'+sentinel.address().port+'/sentinel/chat/completions'});res.end(upstreamPrivate);return;
        }
        if(req.url==='/redirect-same/models'){res.writeHead(302,{...headers,location:'https://localhost:'+upstream.address().port+'/sentinel/models'});res.end(upstreamPrivate);return;}
        if(req.url==='/slow/models'){
          res.writeHead(200,headers);res.write('{"data":[');
          const timer=setInterval(()=>res.write(' '),100);res.on('close',()=>clearInterval(timer));return;
        }
        if(req.url.startsWith('/status-')){res.writeHead(Number(req.url.split('/')[1].slice(7)),headers);res.end(JSON.stringify({error:{message:upstreamPrivate,key:fakeKey}}));return;}
        if(req.url==='/invalid/models'){res.writeHead(200,headers);res.end(upstreamPrivate+' {invalid JSON');return;}
        let body;
        if(req.url==='/v1/models')body=JSON.stringify({data:[{id:'fixture-model-a',owned_by:upstreamPrivate,apiKey:fakeKey},{id:'fixture-model-b'},{id:'fixture-model-a'},{id:'bad,model'},{},null],apiKey:fakeKey,next:'https://localhost:'+sentinel.address().port+'/sentinel/models'});
        else if(req.url==='/tenant%2Fproject/v2/models')body=JSON.stringify({data:[{id:'fixture-prefix'}]});
        else if(req.url==='/empty/models')body='{"data":[]}';
        else if(req.url==='/count/models')body=JSON.stringify({data:Array.from({length:501},(_,i)=>({id:'fixture-model-'+i}))});
        else if(req.url==='/bytes/models')body=JSON.stringify({data:Array.from({length:500},(_,i)=>({id:'模'.repeat(190)+'-'+String(i).padStart(3,'0')}))});
        else if(['/exact/models','/large/models','/large-chunked/models'].includes(req.url)){
          const small=JSON.stringify({data:[{id:'fixture-exact-limit'}],padding:''});
          body=small.replace('"padding":""','"padding":"'+'x'.repeat(maxResponse-Buffer.byteLength(small)+(req.url==='/exact/models'?0:1))+'"');
        }else {res.writeHead(404,headers);res.end(upstreamPrivate);return;}
        res.writeHead(200,{...headers,...(req.url==='/large-chunked/models'?{}:{'content-length':Buffer.byteLength(body)})});res.end(body);
      });
    });closes.push(track(upstream));await listen(upstream);
    Object.assign(env,{NODE_EXTRA_CA_CERTS:cert.ca,OPENAI_BRIDGE_MODELS_BASE:'https://localhost:'+upstream.address().port,
      OPENAI_BRIDGE_MODELS_UNTRUSTED:'https://localhost:'+untrusted.address().port});
    const result=await runChild(env);
    noSecrets(result.out);noSecrets(result.err);
    assert.equal(inferenceRequests,0,'model listing must never send a chat/completions or messages request');
    assert.equal(sentinelRequests,0,'no redirect or pagination target may receive a request/key');
    assert.equal(untrustedRequests,0,'untrusted TLS must fail before any HTTP/auth request');
    assert(received.every(r=>r.method==='GET'&&r.url.endsWith('/models')&&r.bodyBytes===0),'all upstream operations must be bodyless GET /models');
    assert(received.every(r=>r.authorization==='Bearer '+fakeKey),'only the dummy caller key is sent to the requested upstream');
    assert.equal(received.length,new Set(received.map(r=>r.url)).size,'there must be no retry, duplicate preflight, pagination or inference request');
    if(result.status!==0)process.stderr.write(clean(result.err+result.out));
    assert(!result.timedOut&&!result.excess&&result.status===0,'real App/component models integration failed; disposable fixture will be removed');
    const expected=['/v1/models','/tenant%2Fproject/v2/models','/empty/models','/count/models','/bytes/models','/exact/models','/large/models','/large-chunked/models','/invalid/models',
      ...[401,403,404,429].map(s=>'/status-'+s+'/models'),...[301,302,303,307,308].map(s=>'/redirect-'+s+'/models'),'/redirect-same/models','/slow/models'];
    assert.deepEqual(received.map(r=>r.url),expected,'only requested model-list URLs are contacted, once each');
    process.stdout.write(result.out);console.log(JSON.stringify({ok:true,caProvisioning,archiveStage:stage?{path:stage,payloadsMatchRepository:true,payloads:stagePayloads}:null,trustedUpstreamHttpRequests:received.length,
      inferenceHttpRequests:inferenceRequests,sentinelHttpRequests:sentinelRequests,untrustedUpstreamHttpRequests:untrustedRequests,upstreamPaths:received.map(r=>r.url)}));
    console.log('PASS models App/component HTTPS E2E with disclosed fixture-entry CA assignment; inference=0, redirects=0, untrusted HTTP=0, writes=0');
  }finally{for(const close of closes.reverse())await close();fs.rmSync(root,{recursive:true,force:true});}
}
if(process.argv[2]==='--app-child')appChild().catch(error=>{console.error(clean(error.stack||error.message));process.exitCode=1;});
else main().catch(error=>{console.error(clean(error.message));process.exitCode=1;});
