#!/usr/bin/env node
'use strict';
// Unit coverage for multiple OpenAI-compatible upstreams. No sockets, no real keys.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../installer.cjs');

const primary={endpoint:'https://primary.example.com/v1/chat/completions',apiKey:'primary-key',model:'primary-model'};
const secondary={endpoint:'https://secondary.example.com/v1/chat/completions',apiKey:'secondary-key',model:'secondary-model'};
const input={...primary,models:['primary-model','primary-two'],providers:[{...secondary,models:['secondary-model']}]};

test('legacy single-provider inputs keep the exact schema-1 shape',()=>{
  assert.deepEqual(api.validateConfig(primary,3459),primary);
  const models={...primary,models:['primary-model','primary-two']};
  assert.deepEqual(api.validateConfig(models,3459),models);
  const router=api.routerConfig(primary,3459,'local-key');
  assert.deepEqual(router.Providers,[{name:'relay',api_base_url:primary.endpoint,api_key:primary.apiKey,models:[primary.model]}]);
  assert.equal(Object.hasOwn(router,'MODEL_ROUTES'),false);
  assert.equal(router.Router.default,'relay,'+primary.model);
});

test('multiple providers produce deterministic routes and keep the schema-1 connection record',()=>{
  const before=structuredClone(input), config=api.validateConfig(input,3459);
  assert.deepEqual(input,before,'input must not be mutated');
  assert.equal(config.endpoint,primary.endpoint);
  assert.equal(config.apiKey,primary.apiKey);
  assert.equal(config.model,primary.model);
  assert.deepEqual(config.models,['primary-model','primary-two','secondary-model']);
  assert.deepEqual(config.connections.map(({name,endpoint,model,models})=>({name,endpoint,model,models})),[
    {name:'relay',endpoint:primary.endpoint,model:primary.model,models:['primary-model','primary-two']},
    {name:'relay-2',endpoint:secondary.endpoint,model:secondary.model,models:['secondary-model']}
  ]);
  assert.deepEqual(config.routes,{
    'primary-model':'relay,primary-model',
    'primary-two':'relay,primary-two',
    'secondary-model':'relay-2,secondary-model'
  });
  const router=api.routerConfig(config,3459,'local-key');
  assert.deepEqual(router.Providers,[
    {name:'relay',api_base_url:primary.endpoint,api_key:primary.apiKey,models:['primary-model','primary-two']},
    {name:'relay-2',api_base_url:secondary.endpoint,api_key:secondary.apiKey,models:['secondary-model']}
  ]);
  assert.deepEqual(router.MODEL_ROUTES,config.routes);
  for(const name of ['default','background','think','longContext','webSearch'])assert.equal(router.Router[name],'relay,primary-model');
  assert.deepEqual(api.connectionConfig(config,'http://127.0.0.1:3459','local-key'),{
    baseUrl:'http://127.0.0.1:3459',apiKey:'local-key',model:'primary-model',
    models:['primary-model','primary-two','secondary-model']
  });
  assert.deepEqual(api.validateConfig(config,3459),config,'internal configs are idempotent');
});

test('duplicate model IDs get a provider-scoped alias and an explicit route',()=>{
  const config=api.validateConfig({...primary,model:'shared',models:['shared','primary-only'],
    providers:[{...secondary,model:'shared',models:['shared','secondary-only']}]},3459);
  assert.deepEqual(config.models,['shared','primary-only','relay-2/shared','secondary-only']);
  assert.deepEqual(config.routes,{
    'shared':'relay,shared',
    'primary-only':'relay,primary-only',
    'relay-2/shared':'relay-2,shared',
    'secondary-only':'relay-2,secondary-only'
  });
  assert.equal(api.routerConfig(config,3459,'local-key').Router.default,'relay,shared','the primary keeps the bare duplicate name');
});

test('the default model is routed even when it is not first in its provider catalog',()=>{
  const config=api.validateConfig({...primary,models:['first-model','primary-model']},3459);
  assert.equal(config.model,'primary-model');
  assert.equal(api.routerConfig(config,3459,'local-key').Router.default,'relay,primary-model');
});

test('provider names are optional but validated, unique and lower-case',()=>{
  const named=api.validateConfig({...primary,providers:[{...secondary,name:'backup-1'}]},3459);
  assert.equal(named.connections[1].name,'backup-1');
  assert.equal(named.routes['secondary-model'],'backup-1,secondary-model');
  for(const name of ['Backup','bad,name','bad name','bad_name','-bad','x'.repeat(33)])assert.throws(()=>api.validateConfig({...primary,providers:[{...secondary,name}]},3459));
  assert.throws(()=>api.validateConfig({...primary,providers:[{...secondary,name:'relay'}]},3459),/保留名/);
  assert.throws(()=>api.validateConfig({...primary,providers:[{...secondary,name:'dup'},{...secondary,name:'dup'}]},3459),/唯一/);
});

test('provider entries reject unknown fields, missing keys and malformed endpoints',()=>{
  for(const provider of [
    {...secondary,extra:true},
    {...secondary,endpoint:'http://remote.example.com/v1/chat/completions'},
    {...secondary,endpoint:'https://user:pass@example.com/v1'},
    {...secondary,apiKey:''},
    {...secondary,model:''},
    {...secondary,model:'bad,model'},
    {...secondary,models:['other-model']},
    {...secondary,models:['secondary-model','secondary-model']}
  ])assert.throws(()=>api.validateConfig({...primary,providers:[provider]},3459));
  assert.throws(()=>api.validateConfig({...primary,providers:{}},3459));
  assert.throws(()=>api.validateConfig({...primary,providers:Array.from({length:16},()=>({...secondary}))},3459));
});

test('more than 100 visible models across all providers are rejected',()=>{
  const many=Array.from({length:60},(_,i)=>'model-'+i);
  assert.throws(()=>api.validateConfig({...primary,model:many[0],models:many,
    providers:[{...secondary,model:many[0]+'-second',models:many.map(id=>id+'-second')}]},3459),/100/);
});

test('a duplicate alias that collides with a real model ID is rejected',()=>{
  assert.throws(()=>api.validateConfig({...primary,model:'shared',models:['shared','relay-2/shared'],
    providers:[{...secondary,model:'shared',models:['shared']}]},3459),/唯一/);
});

test('an empty providers array is still the legacy single-provider format',()=>{
  assert.deepEqual(api.validateConfig({...primary,providers:[]},3459),primary);
});

test('a partial internal multi-provider shape is rejected instead of silently downgraded',()=>{
  assert.throws(()=>api.validateConfig({...primary,connections:[],routes:{},models:[]},3459));
  assert.throws(()=>api.validateConfig({...primary,routes:{}},3459));
  assert.throws(()=>api.validateConfig({...primary,connections:[]},3459));
});

test('routerConfig never mutates its input or shares provider model arrays',()=>{
  const config=api.validateConfig(input,3459),before=structuredClone(config),router=api.routerConfig(config,3459,'local-key');
  assert.deepEqual(config,before);
  router.Providers[0].models.push('mutated');
  assert.deepEqual(config.connections[0].models,['primary-model','primary-two']);
  const connection=api.connectionConfig(config,'http://127.0.0.1:3459','local-key');
  connection.models.push('mutated');
  assert.deepEqual(config.models,['primary-model','primary-two','secondary-model']);
});
