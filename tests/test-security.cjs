#!/usr/bin/env node
// 仅测试隔离副本与临时假文件；加载实际 bundle 的 Fastify/静态插件，不执行 CCR CLI 入口。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const source = path.resolve(__dirname, '..');

async function worker(cli, fixed) {
  const {fastify, staticPlugin, undici, glob, minimatch} = require(cli);
  if (fixed) {
    assert.equal(fastify, require('fastify'));
    assert.equal(staticPlugin, require('@fastify/static'));
    assert.equal(undici, require('undici'));
    assert.equal(glob, require('glob'));
    assert.equal(minimatch, require('minimatch'));
    console.log('PASS patched bundle loads the exact fixed Fastify/static/Undici/glob/minimatch implementations');
  }
  const root = path.join(path.dirname(cli), 'static-test');
  fs.mkdirSync(path.join(root, 'public'), {recursive:true});
  fs.mkdirSync(path.join(root, 'private'), {recursive:true});
  fs.writeFileSync(path.join(root, 'public/ok.txt'), 'PUBLIC_OK');
  fs.writeFileSync(path.join(root, 'private/secret.txt'), 'PRIVATE_TEST_ONLY');
  const app = fastify({logger:false});
  app.register(staticPlugin, {root, allowedPath: name => !name.startsWith('/private/')});
  try {
    const good = await app.inject('/public/ok.txt');
    assert.equal(good.statusCode, 200);
    assert.equal(good.body, 'PUBLIC_OK');
    const denied = await app.inject('/private/secret.txt');
    assert.equal(denied.statusCode, 404);
    let leaks = 0;
    for (const url of ['//private/secret.txt', '/./private/secret.txt', '/public/../private/secret.txt']) {
      const response = await app.inject({method:'GET', url});
      if (response.body === 'PRIVATE_TEST_ONLY') leaks++;
      if (fixed) assert.ok([400,403,404].includes(response.statusCode), url + ': ' + response.statusCode);
    }
    if (fixed) {
      assert.equal(leaks, 0);
      console.log('PASS actual CCR Fastify + fixed static plugin rejects all 3 non-canonical guard bypasses');
    } else {
      assert.ok(leaks > 0, 'unpatched control must reproduce the advisory');
      console.log('PASS unpatched control reproduces static allowedPath bypass on temporary fake files');
    }
  } finally { await app.close(); }
  if (!fixed) return;

  const tree = path.join(root, 'glob-tree');
  const makeTree = (dir, depth) => {
    fs.mkdirSync(dir, {recursive:true});fs.writeFileSync(path.join(dir, 'ok.txt'), 'FAKE');
    if (depth) for (const name of ['a','b']) makeTree(path.join(dir, name), depth - 1);
  };
  makeTree(tree, 3);
  assert.equal((await glob.glob('**/*.txt', {cwd:tree})).length, 15);
  for (const stream of [false, true]) {
    const ac = new AbortController(), reason = new Error('test-abort');
    let reads = 0;
    const count = () => { if (++reads === 1) ac.abort(reason); };
    const countedFs = {...fs, readdir(...args) { count();return fs.readdir(...args); }, readdirSync(...args) { count();return fs.readdirSync(...args); }};
    const options = {cwd:tree, signal:ac.signal, fs:countedFs};
    if (stream) await assert.rejects(async () => { for await (const _ of glob.globStream('**', options)) {} }, error => error === reason);
    else await assert.rejects(glob.glob('**', options), error => error === reason);
    const atReject = reads;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(reads, 1);assert.equal(reads, atReject);
  }
  console.log('PASS glob 14.0.3 promise/stream abort stops directory reads on a bounded fake tree');
  const small = new minimatch.Minimatch('**/../a/b/**/../c/d', {optimizationLevel:2});
  assert.equal(small.set.length, 4);assert(small.match('../a/b/../c/d'));assert(small.match('x/a/b/y/c/d'));
  const capped = new minimatch.Minimatch(Array(8).fill('**/../a/b').join('/'), {optimizationLevel:2, braceExpandMax:16});
  assert.equal(capped.set.length, 16);
  const many = new minimatch.Minimatch('{x,*}/{0..500}', {optimizationLevel:2});
  assert.equal(many.set.length, 1002);assert(many.match('x/5'));assert(many.match('y/500'));assert.equal(many.match('.y/5'), false);
  console.log('PASS minimatch 11.0.3 caps optimization expansion and skips large-set pairwise deduplication');

  const listed = fastify({logger:false});
  listed.register(staticPlugin, {root, index:false, list:{format:'json'}});
  try {
    const listing = await listed.inject('/public/');
    assert.equal(listing.statusCode, 200);assert.match(listing.body, /ok\.txt/);
    console.log('PASS fixed static directory listing works with glob 14.0.3');
  } finally { await listed.close(); }
  const guarded = fastify({logger:false});
  guarded.get('/private/*', async (_, reply) => reply.code(403).send('DENIED'));
  guarded.register(staticPlugin, {root, list:{format:'json'}});
  try {
    assert.equal((await guarded.inject('/public/ok.txt')).statusCode, 200);
    for (const url of ['/private%2Fsecret.txt', '/private%2fsecret.txt', '/public/../private/secret.txt', '/public/../../']) {
      const response = await guarded.inject({method:'GET', url});
      assert.ok([400,403,404].includes(response.statusCode), url + ': ' + response.statusCode);
      assert.ok(!response.body.includes('PRIVATE_TEST_ONLY'));
    }
    console.log('PASS actual CCR Fastify rejects encoded-separator route bypass and listing traversal');
  } finally { await guarded.close(); }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-security-'));
  try {
    const env = {...process.env, HOME:path.join(temp, 'home')};
    for (const key of ['CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','SERVICE_PORT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete env[key];
    const original = fs.readFileSync(path.join(source, 'node_modules/@musistudio/claude-code-router/dist/cli.js'), 'utf8');
    for (const fixed of [false, true]) {
      const dir = path.join(temp, fixed ? 'fixed' : 'original');
      const dist = path.join(dir, 'node_modules/@musistudio/claude-code-router/dist');
      fs.mkdirSync(dist, {recursive:true});
      for (const name of ['@fastify', '@isaacs', 'fastify', 'ajv', 'fast-uri', 'find-my-way', 'undici', 'minimatch', 'glob', 'shell-quote']) {
        fs.symlinkSync(path.join(source, 'node_modules', name), path.join(dir, 'node_modules', name), 'dir');
      }
      const cli = path.join(dist, 'cli.js');
      fs.writeFileSync(cli, original);
      fs.copyFileSync(path.join(source, 'node_modules/@musistudio/claude-code-router/dist/tiktoken_bg.wasm'), path.join(dist, 'tiktoken_bg.wasm'));
      if (fixed) {
        fs.copyFileSync(path.join(source, 'runtime/patch-ccr.js'), path.join(dir, 'patch-ccr.js'));
        const patched = spawnSync(process.execPath, [path.join(dir, 'patch-ccr.js')], {env, encoding:'utf8', timeout:20000});
        assert.equal(patched.status, 2, patched.stderr);
      }
      const text = fs.readFileSync(cli, 'utf8');
      if (fixed) {
        for (const name of ['fastify','ajv','fast-uri','find-my-way','undici','@isaacs/brace-expansion','minimatch','glob','shell-quote']) {
          assert.ok(!text.includes('/node_modules/' + name + '/'), 'old embedded implementation remains: ' + name);
          assert.ok(text.includes('// ccr-bundled-security-v1: ' + name + ' '));
        }
        console.log('PASS all 249 affected embedded CommonJS modules removed; fixed dependencies are loaded externally');
      }
      assert.equal(text.split('main().catch(console.error);').length, 2);
      fs.writeFileSync(cli, text.replace('main().catch(console.error);', 'module.exports = { fastify: require_fastify(), staticPlugin: import_static.default, undici: require_undici(), glob: require_commonjs7(), minimatch: require_commonjs3() };'));
      const result = spawnSync(process.execPath, [__filename, '--worker', cli, String(fixed)], {env, encoding:'utf8', timeout:20000});
      assert.equal(result.status, 0, result.stdout + result.stderr);
      process.stdout.write(result.stdout);
    }
    const tmp = require('tmp');
    assert.equal(require('tmp/package.json').version, '0.2.7');
    const base = path.join(temp, 'safe-tmp');
    fs.mkdirSync(base);
    for (const options of [{prefix:'../escaped'}, {postfix:'/../../escaped'}, {dir:'../outside'}]) {
      assert.throws(() => tmp.fileSync({tmpdir:base, ...options}));
      assert.throws(() => tmp.dirSync({tmpdir:base, ...options}));
    }
    const valid = tmp.fileSync({tmpdir:base, prefix:'safe', postfix:'.txt'});
    try { assert.equal(path.dirname(valid.name), base); } finally { valid.removeCallback(); }
    assert.deepEqual(fs.readdirSync(base), []);
    console.log('PASS tmp 0.2.7 rejects prefix/postfix/dir escapes and permits normal temporary files');
    const lock = require('../package-lock.json');
    assert.equal(lock.packages['node_modules/@fastify/static'].version, '10.1.2');
    for (const [name, pkg] of Object.entries(lock.packages)) {
      if (name.endsWith('/tmp')) assert.equal(pkg.version, '0.2.7');
      if (name.endsWith('/@fastify/static')) assert.equal(pkg.version, '10.1.2');
      if (name.endsWith('/glob')) assert.equal(pkg.version, '14.0.3');
      if (name.endsWith('/minimatch')) assert.equal(pkg.version, '11.0.3');
    }
    console.log('PASS lockfile contains no nested old static/tmp/glob/minimatch version');
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
}

(process.argv[2] === '--worker' ? worker(process.argv[3], process.argv[4] === 'true') : main()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
