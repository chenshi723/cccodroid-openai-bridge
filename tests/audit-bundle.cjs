#!/usr/bin/env node
// npm audit 之外审查实际私有运行 bundle；只向 npm registry 发送公开的包名和版本。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bundle-audit-'));
  try {
    const dist = path.join(temp, 'node_modules/@musistudio/claude-code-router/dist');
    fs.mkdirSync(dist, {recursive:true});
    for (const name of ['@fastify','@isaacs','fastify','ajv','fast-uri','find-my-way','undici','minimatch','glob','shell-quote']) {
      fs.symlinkSync(path.join(root, 'node_modules', name), path.join(temp, 'node_modules', name), 'dir');
    }
    const cli = path.join(dist, 'cli.js');
    fs.copyFileSync(path.join(root, 'node_modules/@musistudio/claude-code-router/dist/cli.js'), cli);
    fs.copyFileSync(path.join(root, 'runtime/patch-ccr.js'), path.join(temp, 'patch-ccr.js'));
    const patched = spawnSync(process.execPath, [path.join(temp, 'patch-ccr.js')], {encoding:'utf8', timeout:20000});
    assert.equal(patched.status, 2, patched.stderr || patched.error?.message);
    const packages = {};
    const text = fs.readFileSync(cli, 'utf8');
    for (const match of text.matchAll(/^\/\/ node_modules\/\.pnpm\/(.+?)@(\d+\.\d+\.\d+[^\s/]*?)\/node_modules\//gm)) {
      const name = match[1].replace('+','/'), version = match[2].split('_')[0];
      packages[name] ??= [];
      if (!packages[name].includes(version)) packages[name].push(version);
    }
    const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(packages), signal:AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error('npm advisory API returned HTTP ' + response.status);
    const advisories = await response.json();
    let blocked = 0;
    for (const [name, items] of Object.entries(advisories)) {
      for (const item of items) {
        console.log(item.severity + ': ' + name + ' ' + packages[name].join(',') + ' ' + item.url);
        if (['moderate','high','critical'].includes(item.severity)) blocked++;
      }
    }
    console.log('Effective private bundle: ' + Object.keys(packages).length + ' embedded packages checked; high/moderate/critical advisories=' + blocked);
    assert.equal(blocked, 0, 'Embedded dependency security gate failed');
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
