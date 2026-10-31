#!/usr/bin/env node
'use strict';
// Hermetic unit tests: an in-memory HTTPS transport and a scoped CommonJS cache mock.
// No real sockets, provider configuration, subprocesses, GUI, or upstream credentials.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {AsyncLocalStorage,AsyncResource}=require('node:async_hooks');
const {PassThrough}=require('node:stream');
const timers=require('node:timers');
const {validateHeaderValue}=require('node:http');

const filename=path.resolve(__dirname,'../gui-models.cjs');
const fakeKey='fixture-model-list-key-NEVER-PRINT';
const savedKey='fixture-saved-model-key-NEVER-PRINT';
const upstreamMarker='fixture-private-upstream-message-NEVER-PRINT';
const input={endpoint:'https://models.example.invalid/v1',apiKey:fakeKey};
const RESPONSE_LIMIT=1024*1024,RESULT_LIMIT=128*1024,TIMEOUT=12000;
const secrets=[fakeKey,savedKey,upstreamMarker];
const publicMessages=new Map();
const statusCodes={301:'MODELS_REDIRECT',302:'MODELS_REDIRECT',303:'MODELS_REDIRECT',307:'MODELS_REDIRECT',308:'MODELS_REDIRECT',
  401:'MODELS_AUTH',403:'MODELS_FORBIDDEN',404:'MODELS_NOT_FOUND',429:'MODELS_RATE_LIMIT',
  500:'MODELS_FAILED',502:'MODELS_FAILED',503:'MODELS_FAILED',504:'MODELS_FAILED'};
const realSetTimeout=global.setTimeout,realClearTimeout=global.clearTimeout;
const moduleContext=new AsyncLocalStorage();

function noSecrets(value){
  const text=typeof value==='string'?value:JSON.stringify(value);
  for(const secret of secrets)assert(!text?.includes(secret),'public output must not contain fixture credentials or upstream diagnostics');
}

function fakeClock(){
  let now=0;
  const handles=[];
  function setTimeout(callback,delay,...args){
    const handle={callback,args,delay:Number(delay),due:now+Number(delay),active:true,
      resource:new AsyncResource('models-fixture-timer'),
      unref(){return this;},ref(){return this;},hasRef(){return false;},
      refresh(){this.due=now+this.delay;return this;}};
    handles.push(handle);return handle;
  }
  function clearTimeout(handle){if(handle)handle.active=false;}
  function advance(ms){
    const until=now+ms;
    for(;;){
      const next=handles.filter(h=>h.active&&h.due<=until).sort((a,b)=>a.due-b.due)[0];
      if(!next)break;
      now=next.due;next.active=false;next.resource.runInAsyncScope(next.callback,null,...next.args);
    }
    now=until;
  }
  return {setTimeout,clearTimeout,advance,handles};
}

function requestArguments(args){
  const callback=typeof args.at(-1)==='function'?args.at(-1):undefined;
  const first=args[0];let url,options;
  if(typeof first==='string'||first instanceof URL){
    url=new URL(first);options=args[1]&&typeof args[1]==='object'?{...args[1]}:{};
    if(options.protocol)url.protocol=options.protocol;
    if(options.host)url.host=options.host;
    if(options.hostname)url.hostname=options.hostname;
    if(options.port!==undefined)url.port=String(options.port);
    if(options.path!==undefined)url=new URL(options.path,url.origin);
  }else{
    options={...first};
    const hostname=options.hostname||options.host||'missing.invalid';
    const host=hostname.includes(':')&&!hostname.startsWith('[')?'['+hostname+']':hostname;
    url=new URL((options.protocol||'https:')+'//'+host+(options.port?':'+options.port:'')+(options.path||'/'));
  }
  return {url,options,callback};
}

class FakeResponse extends PassThrough{
  constructor(statusCode,headers){
    super();this.statusCode=statusCode;this.headers=headers;this.complete=false;this.aborted=false;
    this.destroyCalls=0;this.resumeCalls=0;this.chunksWritten=0;
  }
  destroy(error){this.destroyCalls++;return super.destroy(error);}
  resume(){this.resumeCalls++;return super.resume();}
  chunk(value){
    if(this.destroyed)return false;
    this.chunksWritten++;this.write(Buffer.isBuffer(value)?value:Buffer.from(value));return !this.destroyed;
  }
  finish(){if(!this.destroyed){this.complete=true;this.end();}}
}

function fakeHTTPS(scenarios){
  const requests=[];
  class FakeRequest extends EventEmitter{
    constructor(args,kind){
      super();Object.assign(this,requestArguments(args));
      this.kind=kind;this.method=(this.options.method||'GET').toUpperCase();
      this.headers={...this.options.headers};this.body=[];this.ended=false;this.destroyed=false;
      this.destroyCalls=0;this.abortCalls=0;this.timeoutMs=null;this.response=null;
      this.scenario=scenarios[requests.length];requests.push(this);
      if(!this.scenario)throw new Error('unexpected extra HTTPS request in model-list fixture');
      if(this.scenario.throw)throw this.scenario.throw;
    }
    setHeader(name,value){this.headers[name]=value;return this;}
    getHeader(name){return Object.entries(this.headers).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];}
    removeHeader(name){for(const key of Object.keys(this.headers))if(key.toLowerCase()===name.toLowerCase())delete this.headers[key];}
    write(chunk){this.body.push(Buffer.from(chunk));return true;}
    end(chunk){
      if(chunk!==undefined)this.write(chunk);
      assert(!this.ended,'the model-list request is sent only once');this.ended=true;
      queueMicrotask(()=>{if(!this.destroyed)this.scenario(this);});return this;
    }
    setTimeout(ms,callback){this.timeoutMs=ms;if(callback)this.on('timeout',callback);return this;}
    destroy(error){
      this.destroyCalls++;if(this.destroyed)return this;this.destroyed=true;
      if(this.response&&!this.response.destroyed)this.response.destroy();
      queueMicrotask(()=>{if(error&&this.listenerCount('error'))this.emit('error',error);this.emit('close');});
      return this;
    }
    abort(){this.abortCalls++;this.emit('abort');return this.destroy();}
    respond(statusCode=200,headers={}){
      const response=this.response=new FakeResponse(statusCode,headers);
      if(this.callback)this.callback(response);else this.emit('response',response);
      return response;
    }
  }
  return {requests,
    module:{request(...args){return new FakeRequest(args,'request');},
      get(...args){const request=new FakeRequest(args,'get');request.end();return request;},
      Agent:class FakeAgent{constructor(options){this.options=options;}}}};
}

function reply(value,{status=200,headers={},raw=false,chunks}={}){
  return request=>{
    const response=request.respond(status,headers);
    const body=raw?value:JSON.stringify(value);
    for(const chunk of chunks||[body])if(!response.chunk(chunk))return;
    response.finish();
  };
}
const jsonReply=ids=>reply({object:'list',data:ids.map(id=>({id}))});
function fakeSocket(){
  const socket=new EventEmitter();socket.destroyed=false;socket.destroyCalls=0;
  socket.destroy=function(){this.destroyCalls++;this.destroyed=true;return this;};return socket;
}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

async function fixture(scenarios,run){
  const clock=fakeClock(),https=fakeHTTPS(scenarios),effects=[],output=[],imports=[];
  const originalLoad=Module._load,oldCache=require.cache[filename];
  const stdoutWrite=process.stdout.write,stderrWrite=process.stderr.write;
  const oldFetch=global.fetch,oldSetTimeout=global.setTimeout,oldClearTimeout=global.clearTimeout;
  const argv=process.argv.slice();let failed=false;
  const block=name=>new Proxy(function(){},{get(_target,key){
    if(key==='promises'||key==='default')return block(name+'.'+String(key));
    return (..._args)=>{effects.push(name+'.'+String(key));throw new Error('forbidden side effect in model-list fixture');};
  },apply(){effects.push(name);throw new Error('forbidden side effect in model-list fixture');}});
  const allowed=new Set(['https','url','buffer','path','util','events','assert','timers']);
  const capture=original=>function(chunk,encoding,callback){
    if(moduleContext.getStore()!==output)return original.apply(this,arguments);
    output.push(Buffer.isBuffer(chunk)?chunk.toString():String(chunk));if(typeof encoding==='function')encoding();if(callback)callback();return true;
  };
  delete require.cache[filename];
  Module._load=function(request,parent,isMain){
    if(parent?.filename===filename){
      imports.push(request);const name=request.replace(/^node:/,'');
      if(name==='https')return https.module;
      if(name==='http')return {validateHeaderValue,get:block('http.get'),request:block('http.request')};
      if(name==='timers')return {...timers,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout};
      if(!allowed.has(name))return block(name);
    }
    return originalLoad.call(this,request,parent,isMain);
  };
  global.setTimeout=clock.setTimeout;global.clearTimeout=clock.clearTimeout;
  global.fetch=()=>{effects.push('fetch');throw new Error('fetch is forbidden in the HTTPS-only model-list fixture');};
  process.stdout.write=capture(stdoutWrite);process.stderr.write=capture(stderrWrite);
  let safety;
  try{
    const api=moduleContext.run(output,()=>require(filename));assert.equal(typeof api.listModels,'function');
    const listModels=(...args)=>moduleContext.run(output,()=>api.listModels(...args));
    const guard=new Promise((_resolve,reject)=>{safety=realSetTimeout(()=>reject(new Error('model-list fixture did not settle')),2000);});
    await Promise.race([run({...api,listModels,requests:https.requests,clock,imports,effects,output}),guard]);
  }catch(error){failed=true;noSecrets(String(error?.stack||error));throw error;}
  finally{
    realClearTimeout(safety);
    Module._load=originalLoad;global.fetch=oldFetch;global.setTimeout=oldSetTimeout;global.clearTimeout=oldClearTimeout;
    process.stdout.write=stdoutWrite;process.stderr.write=stderrWrite;
    delete require.cache[filename];if(oldCache)require.cache[filename]=oldCache;
    for(const request of https.requests)if(!request.destroyed)request.destroy();
    if(!failed){
      assert.deepEqual(process.argv,argv,'model listing must not pass credentials through argv');
      assert.equal(effects.length,0,'model listing must not read config, write/save, spawn, use fetch, or open another transport');
      assert.equal(output.length,0,'the module must not write credentials, diagnostics, or any result to stdout/stderr');
      assert.equal(clock.handles.filter(handle=>handle.active).length,0,'every settled operation clears its deadline');
    }
    noSecrets(output.join(''));
  }
}

function result(value,ids,truncated=false){
  noSecrets(value);
  assert.deepEqual(value,{schema:1,id:'openai-bridge',models:ids.map(id=>({id})),truncated});
  assert(Buffer.byteLength(JSON.stringify(value))<=RESULT_LIMIT,'complete UTF-8 JSON result stays within 128 KiB');
}
function requestOnly(requests,target='https://models.example.invalid/v1/models',key=fakeKey){
  assert.equal(requests.length,1,'no retry, redirect, chat call, or secondary request is allowed');
  const request=requests[0];assert.equal(request.url.href,target);assert.equal(request.url.protocol,'https:');
  assert.equal(request.method,'GET');assert.equal(request.ended,true);assert.equal(request.body.length,0,'GET has no body');
  assert.equal(request.options.agent,false,'do not inherit a proxy or pooled agent');
  assert.notEqual(request.options.rejectUnauthorized,false,'TLS certificate checks remain enabled');
  assert.equal(request.options.auth,undefined);assert.equal(request.url.username,'');assert.equal(request.url.password,'');
  const authorization=Object.entries(request.headers).filter(([name])=>name.toLowerCase()==='authorization');
  assert.equal(authorization.length,1);assert(authorization[0][1]==='Bearer '+key,'only the selected key is in Authorization');
  assert(!request.url.href.includes(key),'the key is never placed in the URL');
  assert(!Object.entries(request.headers).some(([name])=>/^proxy-authorization$/i.test(name)),'never send proxy credentials');
  return request;
}
async function rejectCode(operation,code){
  let error;
  try{await operation;assert.fail('model-list operation unexpectedly resolved');}catch(value){error=value;}
  assert(error instanceof Error,'model-list failures are Errors');
  noSecrets(JSON.stringify(error,Object.getOwnPropertyNames(error)));
  if(code)assert.equal(error.guiCode,code);else assert.match(error.guiCode,/^MODELS_[A-Z_]+$/);
  assert.equal(typeof error.message,'string');assert(error.message.length>0&&error.message.length<512,'public errors are short static messages');
  assert(!error.message.includes('models.example.invalid'),'static errors do not echo the endpoint');
  if(publicMessages.has(error.guiCode))assert.equal(error.message,publicMessages.get(error.guiCode),'the same guiCode always has the same static message');
  else publicMessages.set(error.guiCode,error.message);
  return {code:error.guiCode,message:error.message};
}

for(const [endpoint,target] of [
  ['https://models.example.invalid','https://models.example.invalid/v1/models'],
  ['https://models.example.invalid/','https://models.example.invalid/v1/models'],
  ['https://models.example.invalid/v1/','https://models.example.invalid/v1/models'],
  ['https://models.example.invalid/v1/chat/completions','https://models.example.invalid/v1/models'],
  ['https://models.example.invalid/prefix/v2/chat/completions///','https://models.example.invalid/prefix/v2/models'],
  ['https://models.example.invalid:8443/relay/chat/completions/','https://models.example.invalid:8443/relay/models'],
  ['https://MODELS.example.invalid:443/prefix%2Ftenant/chat/completions','https://models.example.invalid/prefix%2Ftenant/models']
])test('model listing preserves the normalized URL prefix: '+endpoint,()=>fixture([jsonReply(['fixture-one'])],async({listModels,requests})=>{
  result(await listModels({...input,endpoint}),['fixture-one']);requestOnly(requests,target);
}));

test('success returns only schema/id/model ids/truncated, never upstream metadata or keys',()=>fixture([
  reply({data:[{id:'fixture-model',owned_by:upstreamMarker,apiKey:fakeKey,extra:{private:savedKey}}],apiKey:fakeKey})
],async({listModels,requests})=>{
  result(await listModels(input),['fixture-model']);requestOnly(requests);
}));

for(const retained of [false,true]){
  const label=retained?'saved-key discovery':'new-key discovery',key=retained?savedKey:fakeKey;
  const discover=listModels=>retained
    ?listModels({endpoint:input.endpoint,apiKey:''},{resolveSavedKey:async()=>key})
    :listModels(input);
  const echoed=[key,'prefix-'+key,key+'-suffix','prefix-'+key+'-suffix','  '+key+'  '];
  const checkRequest=requests=>requestOnly(requests,'https://models.example.invalid/v1/models',key);

  test(label+' removes exact, prefixed, suffixed, embedded and trimmed credential echoes',()=>fixture([
    jsonReply(['fixture-before',...echoed,'fixture-after'])
  ],async({listModels,requests})=>{
    result(await discover(listModels),['fixture-before','fixture-after']);checkRequest(requests);
  }));

  test(label+' filters credential echoes after decoding JSON Unicode escapes',()=>{
    const escaped=Array.from(key,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
    const body=JSON.stringify({data:[...echoed.map(id=>({id})),{id:'fixture-after-escaped-echo'}]}).replaceAll(key,escaped);
    assert(!body.includes(key),'the wire fixture encodes credential characters rather than containing the literal key');
    return fixture([reply(body,{raw:true})],async({listModels,requests})=>{
      result(await discover(listModels),['fixture-after-escaped-echo']);checkRequest(requests);
    });
  });

  test(label+' returns an empty untruncated list when every model id echoes the credential',()=>fixture([
    jsonReply(echoed)
  ],async({listModels,requests})=>{
    result(await discover(listModels),[]);checkRequest(requests);
  }));

  test(label+' does not count discarded credential echoes toward the 500-id limit',()=>{
    const allowed=Array.from({length:500},(_,i)=>'fixture-safe-'+i);
    const rejected=Array.from({length:600},(_,i)=>'fixture-echo-'+i+'-'+key);
    return fixture([jsonReply([...rejected,...allowed,...rejected])],async({listModels,requests})=>{
      result(await discover(listModels),allowed);checkRequest(requests);
    });
  });

  test(label+' does not charge discarded credential echoes to the 128 KiB result budget',()=>{
    const rejected=Array.from({length:300},(_,i)=>'模'.repeat(150)+'-'+i+'-'+key);
    const allowed=Array.from({length:100},(_,i)=>'fixture-safe-'+i+'-'+'模'.repeat(170));
    assert(rejected.every(id=>id.length<=200),'echo fixtures fit the ordinary model-id length limit');
    assert(Buffer.byteLength(JSON.stringify(rejected.map(id=>({id}))))>RESULT_LIMIT,'echo fixtures alone exceed the serialized-byte budget');
    assert(rejected.length+allowed.length<500,'this fixture tests the byte budget independently of the count limit');
    return fixture([jsonReply([...rejected,...allowed])],async({listModels,requests})=>{
      result(await discover(listModels),allowed);checkRequest(requests);
    });
  });
}

test('valid model JSON may arrive split across UTF-8 byte boundaries',()=>{
  const body=Buffer.from(JSON.stringify({data:[{id:'模型-α'}]}));
  return fixture([reply('',{raw:true,chunks:Array.from(body,byte=>Buffer.from([byte]))})],async({listModels,requests})=>{
    result(await listModels(input),['模型-α']);requestOnly(requests);
  });
});

for(const apiKey of [undefined,''])test('blank or omitted key resolves the saved key for the normalized endpoint',()=>fixture([
  jsonReply(['fixture-saved'])
],async({listModels,requests})=>{
  const endpoints=[];
  const value=await listModels({endpoint:'https://models.example.invalid/prefix/chat/completions/',...(apiKey===undefined?{}:{apiKey})},
    {resolveSavedKey:async endpoint=>{endpoints.push(endpoint);return savedKey;}});
  result(value,['fixture-saved']);assert.deepEqual(endpoints,['https://models.example.invalid/prefix/chat/completions']);
  requestOnly(requests,'https://models.example.invalid/prefix/models',savedKey);
}));

test('pagination URLs, errors embedded in metadata, and chat instructions never trigger another operation',()=>fixture([
  reply({data:[{id:'fixture-no-follow'}],has_more:true,next:'https://elsewhere.example.invalid/models',
    links:{next:'https://elsewhere.example.invalid/chat/completions'},error:{message:upstreamMarker},apiKey:fakeKey})
],async({listModels,requests})=>{
  result(await listModels(input),['fixture-no-follow']);requestOnly(requests);
}));

test('a newly supplied key never resolves or reads an old key',()=>fixture([jsonReply([])],async({listModels,requests})=>{
  let called=false;
  result(await listModels(input,{resolveSavedKey(){called=true;throw new Error(upstreamMarker);}}),[]);
  assert.equal(called,false);requestOnly(requests);
}));

test('no supplied key and no saved key rejects before any request',()=>fixture([],async({listModels,requests})=>{
  await rejectCode(listModels({endpoint:input.endpoint}),'KEY_REQUIRED');
  for(const value of [undefined,null,''])await rejectCode(listModels({endpoint:input.endpoint,apiKey:''},{resolveSavedKey:()=>value}),'KEY_REQUIRED');
  assert.equal(requests.length,0);
}));

test('saved-key resolution preserves only approved static safety errors',()=>fixture([],async({listModels,requests})=>{
  for(const code of ['KEY_REQUIRED','KEY_HOST_CHANGED','RUNTIME_CONFLICT']){
    await rejectCode(listModels({endpoint:input.endpoint},{resolveSavedKey(){
      const error=new Error(upstreamMarker+' '+fakeKey);error.guiCode=code;throw error;
    }}),code);
  }
  for(const code of [undefined,'MODELS_AUTH',upstreamMarker]){
    await rejectCode(listModels({endpoint:input.endpoint},{resolveSavedKey:async()=>{
      const error=new Error(upstreamMarker+' '+savedKey);error.guiCode=code;throw error;
    }}),'RUNTIME_CONFLICT');
  }
  assert.equal(requests.length,0);
}));

test('invalid retained keys fail without constructing an Authorization header',()=>fixture([],async({listModels,requests})=>{
  for(const value of [4,{},'   ','bad key','bad\r\nkey','x'.repeat(1025),'密钥']){
    await rejectCode(listModels({endpoint:input.endpoint},{resolveSavedKey:()=>value}),'RUNTIME_CONFLICT');
  }
  assert.equal(requests.length,0);
}));

test('invalid options and accessor-bearing input are rejected without invoking getters',()=>fixture([],async({listModels,requests})=>{
  for(const options of [null,[],{resolveSavedKey:true}])await rejectCode(listModels(input,options),'INVALID_INPUT');
  let accessed=false;
  const endpointAccessor={apiKey:fakeKey};Object.defineProperty(endpointAccessor,'endpoint',{enumerable:true,get(){accessed=true;return input.endpoint;}});
  const keyAccessor={endpoint:input.endpoint};Object.defineProperty(keyAccessor,'apiKey',{enumerable:true,get(){accessed=true;return fakeKey;}});
  for(const value of [endpointAccessor,keyAccessor])await rejectCode(listModels(value),'INVALID_INPUT');
  assert.equal(accessed,false);assert.equal(requests.length,0);
}));

test('a caller must explicitly supply a key for a different origin',()=>fixture([
  jsonReply(['fixture-foreign'])
],async({listModels,requests})=>{
  const endpoint='https://other.models.example.invalid:8443/tenant/chat/completions';
  let resolved=false;
  result(await listModels({endpoint,apiKey:fakeKey},{resolveSavedKey(){resolved=true;return savedKey;}}),['fixture-foreign']);
  assert.equal(resolved,false);requestOnly(requests,'https://other.models.example.invalid:8443/tenant/models');
}));

test('proxy environment variables never change the HTTPS target or send proxy authorization',()=>fixture([
  jsonReply(['fixture-direct'])
],async({listModels,requests})=>{
  const names=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_USE_ENV_PROXY'];
  const previous=names.map(name=>[name,process.env[name]]);
  try{
    for(const name of names)process.env[name]=name==='NODE_USE_ENV_PROXY'?'1':'http://fixture-proxy:fixture-password@proxy.example.invalid:9999';
    result(await listModels(input),['fixture-direct']);requestOnly(requests);
  }finally{for(const [name,value] of previous)if(value===undefined)delete process.env[name];else process.env[name]=value;}
}));

const invalidInputs=[null,[],{},'not an object',
  {endpoint:input.endpoint,apiKey:9},{...input,apiKey:'   '},{...input,apiKey:'bad key'},{...input,apiKey:'bad\r\nAuthorization: stolen'},
  {...input,apiKey:'x'.repeat(1025)},{...input,model:'not-part-of-model-discovery'},
  ...['http://models.example.invalid/v1','http://127.0.0.1:3459/v1','file:///v1','not a URL',
    'https://user:password@models.example.invalid/v1','https://models.example.invalid/v1?api_key=fixture',
    'https://models.example.invalid/v1#fragment','https://models.example.invalid/private',
    'https://models.example.invalid\\other/v1','https://models.example.invalid/v1\n',
    'https://@models.example.invalid/v1','https://models.example.invalid/v1?',
    'https://models.example.invalid/v1#','https://models.example.invalid/a%0a/chat/completions',
    'https://models.example.invalid/a%5c/chat/completions','https://models.example.invalid/'+ 'x'.repeat(2049)].map(endpoint=>({...input,endpoint}))
];
test('invalid endpoint/input/key is rejected before resolver, I/O, or any request',()=>fixture([],async({listModels,requests})=>{
  let resolved=false;
  for(const value of invalidInputs)await rejectCode(listModels(value,{resolveSavedKey(){resolved=true;return savedKey;}}),'INVALID_INPUT');
  assert.equal(resolved,false);assert.equal(requests.length,0);
}));

for(const status of [301,302,303,307,308])test('HTTP '+status+' never follows same-origin or foreign redirects',async()=>{
  let expected;
  for(const location of ['https://elsewhere.example.invalid/steal','https://models.example.invalid/other/models','http://models.example.invalid/models']){
    await fixture([reply(upstreamMarker,{status,headers:{location},raw:true})],async({listModels,requests})=>{
      const error=await rejectCode(listModels(input),statusCodes[status]);if(expected)assert.deepEqual(error,expected);else expected=error;
      const request=requestOnly(requests);assert(request.destroyed||request.response.destroyed||request.response.resumeCalls>0,'redirect stream is released');
    });
  }
});

for(const status of [401,403,404,429,500,502,503,504])test('HTTP '+status+' returns a static guiCode without body/header echo or retry',async()=>{
  let expected;
  for(const body of [upstreamMarker+' '+fakeKey,JSON.stringify({error:{message:upstreamMarker,apiKey:fakeKey}}),'plain failure']){
    await fixture([reply(body,{status,raw:true,headers:{'www-authenticate':upstreamMarker,'retry-after':'1'}})],async({listModels,requests})=>{
      const error=await rejectCode(listModels(input),statusCodes[status]);if(expected)assert.deepEqual(error,expected);else expected=error;
      const request=requestOnly(requests);assert(request.destroyed||request.response.destroyed||request.response.resumeCalls>0,'error response is not left open');
    });
  }
});

for(const code of ['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'])
  test('network/TLS '+code+' is static, secret-free, and never retried',()=>fixture([
    request=>{const error=new Error(upstreamMarker+' '+fakeKey);error.code=code;request.emit('error',error);}
  ],async({listModels,requests})=>{
    await rejectCode(listModels(input),'MODELS_NETWORK');const request=requestOnly(requests);
    assert.equal(request.destroyed,true,'failed request is destroyed');
  }));

test('untrusted network error fields never become a public message or guiCode',()=>fixture([
  request=>{const error=new Error(upstreamMarker);error.code=upstreamMarker;error.hostname=fakeKey;request.emit('error',error);}
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_NETWORK');requestOnly(requests);
}));

for(const code of ['ETIMEDOUT','ESOCKETTIMEDOUT','ERR_HTTP_REQUEST_TIMEOUT'])test('transport '+code+' maps to the static timeout error',()=>fixture([
  request=>{const error=new Error(upstreamMarker);error.code=code;request.emit('error',error);}
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_TIMEOUT');assert.equal(requestOnly(requests).destroyed,true);
}));

test('a socket timeout event releases a partially received response without retry',()=>fixture([
  request=>{request.respond().chunk('{"data":[');request.emit('timeout');}
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_TIMEOUT');const request=requestOnly(requests);
  assert.equal(request.destroyed,true);assert.equal(request.response.destroyed,true);
}));

test('closing the request before response headers is a network failure, not a hanging operation',()=>fixture([
  request=>request.emit('close')
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_NETWORK');assert.equal(requestOnly(requests).destroyed,true);
}));

test('a TLS socket error destroys its socket as well as the request',()=>{
  const socket=fakeSocket();
  return fixture([request=>{request.emit('socket',socket);socket.emit('error',new Error(upstreamMarker));}],async({listModels,requests})=>{
    await rejectCode(listModels(input),'MODELS_NETWORK');assert.equal(requestOnly(requests).destroyed,true);
    assert.equal(socket.destroyed,true);
  });
});

test('protocol upgrades release both streams rather than opening another protocol',()=>{
  const socket=fakeSocket();let response;
  return fixture([request=>{
    response=new FakeResponse(101,{});request.emit('upgrade',response,socket,Buffer.alloc(0));
  }],async({listModels,requests})=>{
    await rejectCode(listModels(input),'MODELS_FAILED');assert.equal(requestOnly(requests).destroyed,true);
    assert.equal(response.destroyed,true);assert.equal(socket.destroyed,true);
  });
});

test('a synchronous HTTPS setup failure is sanitized',()=>{
  const scenario=()=>{};scenario.throw=new Error(upstreamMarker+' '+fakeKey);
  return fixture([scenario],async({listModels,requests})=>{await rejectCode(listModels(input),'MODELS_NETWORK');assert.equal(requests.length,1);});
});

for(const body of ['',upstreamMarker+' {bad JSON',JSON.stringify(null),JSON.stringify([]),JSON.stringify({}),JSON.stringify({data:{id:'not-an-array'}}),JSON.stringify({models:[{id:'wrong-shape'}]})])
  test('invalid JSON or top-level list shape is rejected safely',()=>fixture([reply(body,{raw:true})],async({listModels,requests})=>{
    await rejectCode(listModels(input),'MODELS_INVALID_RESPONSE');requestOnly(requests);
  }));

test('invalid UTF-8 is not silently replaced inside an otherwise valid JSON response',()=>fixture([
  reply('',{raw:true,chunks:[Buffer.concat([Buffer.from('{"data":[{"id":"fixture-'),Buffer.from([0xc3,0x28]),Buffer.from('"}]}')])]})
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_INVALID_RESPONSE');requestOnly(requests);
}));

test('an empty model list is valid and not truncated',()=>fixture([jsonReply([])],async({listModels,requests})=>{
  result(await listModels(input),[]);requestOnly(requests);
}));

test('model ids are deduplicated in order; invalid ids are ignored and markup stays inert text',()=>fixture([
  reply({data:[null,{},[],{id:null},{id:7},{id:true},{id:{}},{id:[]},{id:''},{id:'   '},
    {id:'bad,model'},{id:'bad\nmodel'},{id:'bad\rmodel'},{id:'bad\tmodel'},{id:'bad\u0000model'},{id:'bad\u007fmodel'},{id:'bad\u0085model'},{id:'bad\u009fmodel'},{id:'x'.repeat(201)},
    {id:'fixture-b'},{id:'fixture-a'},{id:'fixture-b'},{id:'Fixture-a'},
    {id:'<img src=x onerror=alert(1)>'},{id:'</option><script>alert(1)</script>'},{id:'模型-α'}]})
],async({listModels,requests})=>{
  result(await listModels(input),['fixture-b','fixture-a','Fixture-a','<img src=x onerror=alert(1)>','</option><script>alert(1)</script>','模型-α']);
  requestOnly(requests);
}));

test('duplicate and invalid entries do not consume the 500-id budget',()=>fixture([
  reply({data:[...Array.from({length:700},()=>({id:'fixture-duplicate'})),
    ...Array.from({length:100},()=>({id:'bad,model'})),{id:'fixture-after-duplicates'}]})
],async({listModels,requests})=>{
  result(await listModels(input),['fixture-duplicate','fixture-after-duplicates']);requestOnly(requests);
}));

for(const count of [500,501,700])test('the result caps '+count+' upstream ids at 500',()=>fixture([
  jsonReply(Array.from({length:count},(_,i)=>'fixture-model-'+i))
],async({listModels,requests})=>{
  result(await listModels(input),Array.from({length:Math.min(500,count)},(_,i)=>'fixture-model-'+i),count>500);
  requestOnly(requests);
}));

test('the 128 KiB cap counts the entire serialized UTF-8 result, not characters',()=>{
  const ids=Array.from({length:500},(_,i)=>'模'.repeat(190)+'-'+String(i).padStart(3,'0'));
  return fixture([jsonReply(ids)],async({listModels,requests})=>{
    const value=await listModels(input);
    assert(value.models.length>0&&value.models.length<500,'multibyte ids trigger the byte budget before the count cap');
    result(value,ids.slice(0,value.models.length),true);requestOnly(requests);
  });
});

test('the result byte budget includes JSON escaping as well as model-id characters',()=>{
  const ids=Array.from({length:500},(_,i)=>'"'.repeat(190)+'-'+String(i).padStart(3,'0'));
  return fixture([jsonReply(ids)],async({listModels,requests})=>{
    const value=await listModels(input);
    assert(value.models.length>0&&value.models.length<500,'escaped ids trigger the serialized-byte budget');
    result(value,ids.slice(0,value.models.length),true);requestOnly(requests);
  });
});

function bodyAtBytes(size){
  const body={data:[{id:'fixture-limit'}],padding:''};
  body.padding='p'.repeat(size-Buffer.byteLength(JSON.stringify(body)));return JSON.stringify(body);
}
test('exactly 1 MiB of valid response JSON is allowed',()=>fixture([
  reply(bodyAtBytes(RESPONSE_LIMIT),{raw:true})
],async({listModels,requests})=>{
  result(await listModels(input),['fixture-limit']);requestOnly(requests);
}));

test('an oversized Content-Length is rejected before reading any body bytes',()=>fixture([
  request=>{request.respond(200,{'content-length':String(RESPONSE_LIMIT+1)});}
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_TOO_LARGE');const request=requestOnly(requests);
  assert.equal(request.destroyed,true);assert.equal(request.response.destroyed,true);assert.equal(request.response.chunksWritten,0);
}));

test('one byte beyond 1 MiB is rejected and both streams are released',()=>fixture([
  reply(bodyAtBytes(RESPONSE_LIMIT+1),{raw:true})
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_TOO_LARGE');const request=requestOnly(requests);
  assert.equal(request.destroyed,true);assert.equal(request.response.destroyed,true);
}));

test('chunked oversized response is stopped at the byte cap even with a false short length',()=>fixture([
  reply('',{raw:true,headers:{'content-length':'1'},chunks:Array.from({length:40},()=>Buffer.alloc(65536,120))})
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_TOO_LARGE');const request=requestOnly(requests);
  assert.equal(request.destroyed,true);assert.equal(request.response.destroyed,true);
  assert(request.response.chunksWritten<=17,'oversized response is not drained or buffered to completion');
}));

test('oversized UTF-8 response is limited by bytes rather than JS string length',()=>fixture([
  reply({data:[],padding:'模'.repeat(360000)})
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_TOO_LARGE');const request=requestOnly(requests);
  assert.equal(request.destroyed,true);assert.equal(request.response.destroyed,true);
}));

for(const failure of ['aborted','close','error'])test('a response '+failure+' before completion releases request and response',()=>fixture([
  request=>{
    const response=request.respond();response.chunk('{"data":[');
    if(failure==='aborted'){response.aborted=true;response.emit('aborted');}
    else if(failure==='close')response.emit('close');
    else response.emit('error',new Error(upstreamMarker+' '+fakeKey));
  }
],async({listModels,requests})=>{
  await rejectCode(listModels(input),'MODELS_NETWORK');const request=requestOnly(requests);
  assert.equal(request.destroyed,true);assert.equal(request.response.destroyed,true);
}));

for(const afterHeaders of [false,true])test('the hard 12-second timeout releases '+(afterHeaders?'a stalled response':'a connection without headers'),()=>{
  const socket=fakeSocket();
  return fixture([request=>{
    request.emit('socket',socket);if(afterHeaders)request.respond().chunk('{"data":[');
  }],async({listModels,requests,clock})=>{
    let settled=false;
    const pending=listModels(input);pending.then(()=>{settled=true;},()=>{settled=true;});await flush();
    const request=requestOnly(requests);
    assert(clock.handles.some(handle=>handle.active&&handle.delay===TIMEOUT),'a wall-clock 12-second deadline is armed');
    clock.advance(TIMEOUT-1);await flush();assert.equal(settled,false,'the deadline does not fire early');
    if(afterHeaders)request.response.chunk(' ');
    clock.advance(1);await rejectCode(pending,'MODELS_TIMEOUT');assert.equal(request.destroyed,true);
    assert.equal(socket.destroyed,true);if(afterHeaders)assert.equal(request.response.destroyed,true);
    const late=request.respond();assert.equal(late.destroyed,true,'a response delivered after timeout is closed immediately');
    assert.equal(requests.length,1,'timeout never retries');
  });
});
