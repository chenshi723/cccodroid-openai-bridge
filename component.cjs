#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const api=require('./installer.cjs');
const [command='help',...args]=process.argv.slice(2);
function run(file,argv){
  const result=spawnSync(process.execPath,[file,...argv],{stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}
try{
  if(command==='--selftest'){
    if(args.length)throw new Error('selftest 不接受额外参数。');
    run(path.join(__dirname,'runtime/selftest.cjs'),[]);
  }else if(command==='help'||command==='--help'){
    console.log('openai-bridge --selftest | configure | start | status | stop --yes | uninstall --yes\nconfigure 请用户自己在终端输入端点和密钥；预览组件有已知依赖漏洞，见源仓库 SECURITY.md。');
  }else if(['configure','start','status','stop','uninstall'].includes(command)){
    const options=api.parse(args);
    if(options['show-key']||options['bundled-runtime'])throw new Error('组件入口不允许此参数。');
    if(command==='configure'){
      run(path.join(__dirname,'installer.cjs'),['install',...args,'--bundled-runtime',__dirname]);
    }else{
      const target=path.resolve(options.dir||path.join(os.homedir(),'.local/share/ccr-bridge-kit'));
      const marker=path.join(target,'.ccr-bridge-kit.json');
      if(!fs.existsSync(marker))throw new Error('尚未配置此安装。请用户在终端运行 openai-bridge configure。');
      const manifest=JSON.parse(fs.readFileSync(marker,'utf8'));
      if(manifest.id!=='ccr-bridge-kit'||path.resolve(manifest.target)!==target)throw new Error('不是受管理的桥安装。');
      // 旧运行副本自带管理器，组件更新后仍可安全停止/卸载，不擅自覆盖它。
      run(path.join(target,'manage.cjs'),[command,...args,'--dir',target]);
    }
  }else throw new Error('未知操作；运行 openai-bridge --help 查看用法。');
}catch(error){console.error('错误：'+error.message);process.exitCode=1;}
