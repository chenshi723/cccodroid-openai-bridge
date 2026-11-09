#!/usr/bin/env node
// 只在系统临时目录给 cli/patch 副本打补丁；提取转换器运行，不加载 CCR 主程序、不请求上游。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");

const source = path.resolve(__dirname, "..");
const patchFile = path.join(source, "runtime/patch-ccr.js");
const cliFile = path.join(source, "node_modules/@musistudio/claude-code-router/dist/cli.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-response-test-"));
let passed = 0;

async function test(name, run) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Test timeout: " + name)), 10000);
    })]);
    passed++;
    console.log("ok " + passed + " - " + name);
  } finally { clearTimeout(timer); }
}

function fixture(name, source) {
  const dir = path.join(root, name);
  const cli = path.join(dir, "node_modules/@musistudio/claude-code-router/dist/cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  for (const name of ["@fastify", "@isaacs", "fastify", "ajv", "fast-uri", "find-my-way", "undici", "minimatch", "glob", "shell-quote"]) {
    fs.symlinkSync(path.resolve(__dirname, "../node_modules", name), path.join(dir, "node_modules", name), "dir");
  }
  fs.copyFileSync(cliFile, cli);
  fs.writeFileSync(cli, source);
  fs.copyFileSync(patchFile, path.join(dir, "patch-ccr.js"));
  return { dir, cli, patch: path.join(dir, "patch-ccr.js") };
}

function apply(copy, expected, preload) {
  assert.ok(copy.cli.startsWith(root + path.sep));
  const args = preload ? ["--require", preload, copy.patch] : [copy.patch];
  const result = spawnSync(process.execPath, args, { cwd: copy.dir, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}

function noTemps(copy) {
  assert.deepEqual(fs.readdirSync(path.dirname(copy.cli)).filter((name) => name.endsWith(".tmp")), []);
}

function extract(source) {
  const start = source.indexOf("var Vf = ");
  const end = source.indexOf("\n};\nvar Cn =", start);
  assert.ok(start > 0 && end > start, "Anthropic transformer boundaries");
  // 这里执行的只有实际的类/方法定义，整个 bundle 的服务器入口、插件和 fetch 均不执行。
  const Transformer = vm.runInNewContext(source.slice(start, end + 4) + "\nbo;", {
    Response, ReadableStream, TextEncoder, TextDecoder, Error, TypeError,
    Wt: () => "regression-uuid",
    nt: (message, statusCode = 500, code = "internal_error", type = "api_error") => Object.assign(new Error(message), { statusCode, code, type }),
    console,
    fetch() { throw new Error("Network is forbidden in this test"); }
  });
  const transformer = new Transformer();
  transformer.logger = { debug() {}, error() {} };
  return transformer;
}

function upstream(text, contentType = "application/json", options = {}) {
  const bytes = text instanceof Uint8Array ? text : new TextEncoder().encode(text);
  const sizes = options.sizes || [bytes.length || 1];
  const state = { canceled: [], reads: 0 };
  let offset = 0, index = 0;
  const body = new ReadableStream({
    pull(controller) {
      state.reads++;
      if (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      } else if (options.error) controller.error(new Error(options.error));
      else if (options.hang) return new Promise(() => {});
      else controller.close();
    },
    cancel(reason) { state.canceled.push(reason); }
  }, { highWaterMark: 0 });
  const response = new Response(body, { status: options.status || 200, headers: contentType ? { "Content-Type": contentType } : {} });
  return { response, body, state };
}

function sse(frames, newline = "\n", done = true, multiline = false) {
  return frames.map((frame) => "event: completion" + newline + JSON.stringify(frame, null, multiline ? 2 : 0).split("\n").map((line) => "data: " + line).join(newline) + newline + newline).join("") + (done ? "data: [DONE]" + newline + newline : "");
}

const context = (stream) => ({ req: { id: "regression", provider: "relay", sessionId: "fixture-session", body: stream === undefined ? {} : { stream } } });
const usage = { prompt_tokens: 17, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } };
const expectedUsage = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5 };
const completion = (message = { role: "assistant", content: "正文 你好🙂\n第二行" }, reason = "stop") => ({
  id: "chatcmpl-regression", object: "chat.completion", model: "test-model",
  choices: [{ index: 0, message, finish_reason: reason }], usage
});
const chunk = (delta, finish_reason = null) => ({ id: "chatcmpl-regression", model: "test-model", choices: [{ index: 0, delta, finish_reason }] });
const textFrames = [chunk({ role: "assistant" }), chunk({ content: "正文 你好🙂" }), chunk({ content: "\n第二行" }), chunk({}, "stop"), { choices: [], usage }];

async function events(response) {
  assert.match(response.headers.get("Content-Type"), /^text\/event-stream/);
  const result = (await response.text()).split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n");
    assert.equal(lines.length, 2, frame);
    const data = JSON.parse(lines[1].slice(6));
    assert.equal(lines[0], "event: " + data.type);
    return data;
  });
  assert.equal(result[0]?.type, "message_start");
  assert.equal(result.at(-1)?.type, "message_stop");
  assert.equal(result.filter((event) => event.type === "message_start").length, 1);
  assert.equal(result.filter((event) => event.type === "message_stop").length, 1);
  assert.equal(result.filter((event) => event.type === "message_delta").length, 1);
  const open = new Set(), stopped = new Set();
  for (const event of result) {
    if (event.type === "content_block_start") {
      assert.ok(!open.has(event.index) && !stopped.has(event.index));
      open.add(event.index);
    } else if (event.type === "content_block_delta") assert.ok(open.has(event.index), "Delta needs an open block");
    else if (event.type === "content_block_stop") {
      assert.ok(open.delete(event.index), "Stop needs an open block");
      stopped.add(event.index);
    }
  }
  assert.equal(open.size, 0);
  return result;
}

function client(stream) {
  const ctx = context(stream), raw = new EventEmitter();
  raw.socket = new EventEmitter();
  ctx.req.raw = raw;
  return ctx;
}

function noListeners(ctx) {
  assert.equal(ctx.req.raw.listenerCount("aborted"), 0);
  assert.equal(ctx.req.raw.socket.listenerCount("close"), 0);
}

function assemble(frames) {
  const message = structuredClone(frames[0].message);
  const inputs = new Map();
  for (const event of frames.slice(1)) {
    if (event.type === "content_block_start") message.content[event.index] = structuredClone(event.content_block);
    if (event.type === "content_block_delta") {
      const block = message.content[event.index];
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      if (event.delta.type === "thinking_delta") block.thinking += event.delta.thinking;
      if (event.delta.type === "signature_delta") block.signature = (block.signature || "") + event.delta.signature;
      if (event.delta.type === "input_json_delta") inputs.set(event.index, (inputs.get(event.index) || "") + event.delta.partial_json);
    }
    if (event.type === "message_delta") Object.assign(message, event.delta, { usage: { ...message.usage, ...event.usage } });
  }
  for (const [index, input] of inputs) message.content[index].input = JSON.parse(input);
  return message;
}

async function main() {
  const realCliBefore = fs.readFileSync(cliFile), realCliStat = fs.statSync(cliFile);
  const patch = fs.readFileSync(patchFile, "utf8");
  // 取补丁的纯字符串常量用于在临时副本还原原版/上一版，不执行补丁的文件 I/O 部分。
  const names = ["EFF", "UE", "UR", "READER", "CANCEL", "H", "BODY", "AGENT", "STREAM", "TOOL_IMAGES", "IMAGE_TOKENS", "REASON", "MODEL_ROUTE"];
  const keys = names.flatMap((name) => [name + "_OLD", name + "_NEW"]).concat(["SSE_OLD", "SSE_NEW", "SSE_FALLBACK", "SSE_MARK", "SIG_MARK", "SIG_EDITS", "MODEL_ROUTE_V1", "SIG_V1_FRAGMENTS", "SIG_SCOPE_EDITS"]);
  const constants = vm.runInNewContext(patch.slice(patch.indexOf("const EFF_OLD"), patch.indexOf("\nlet src =")) + "\n({" + keys.join(",") + "});");
  let original = fs.readFileSync(cliFile, "utf8");
  for (const [oldText, newText] of [...constants.SIG_SCOPE_EDITS].reverse()) original = original.replace(newText, oldText);
  for (const [oldText, newText] of [...constants.SIG_EDITS].reverse()) original = original.replace(newText, oldText);
  original = original.replace(constants.SSE_NEW, constants.SSE_OLD).replace(constants.SSE_FALLBACK, constants.SSE_OLD);
  for (const name of names) original = original.replace(constants[name + "_NEW"], constants[name + "_OLD"]);
  for (const key of names.map((name) => name + "_OLD").concat("SSE_OLD")) assert.ok(original.includes(constants[key]), "Original anchor: " + key);
  let legacy = original;
  for (const name of names) legacy = legacy.replace(constants[name + "_OLD"], constants[name + "_NEW"]);
  legacy = legacy.replace(constants.SSE_OLD, constants.SSE_FALLBACK);
  let patched;
  const signatureScope = text => constants.SIG_SCOPE_EDITS.reduce((source,[oldText,newText])=>source.replace(oldText,()=>newText),text);
  const signedSse = signatureScope(constants.SIG_EDITS.slice(0, 4).reduce((text, [oldText, newText]) => {
    assert.equal(text.split(oldText).length, 2, "Thought signature anchor inside SSE_NEW");
    return text.replace(oldText, () => newText);
  }, constants.SSE_NEW));

  const preImages = legacy.replace(constants.SSE_FALLBACK, constants.SSE_NEW).replace(constants.TOOL_IMAGES_NEW, constants.TOOL_IMAGES_OLD).replace(constants.IMAGE_TOKENS_NEW, constants.IMAGE_TOKENS_OLD);
  const preMultiModel = legacy.replace(constants.SSE_FALLBACK, constants.SSE_NEW).replace(constants.MODEL_ROUTE_NEW, constants.MODEL_ROUTE_OLD);
  for (const [name, source] of [["original", original], ["legacy-fallback", legacy], ["pre-image-fix", preImages], ["pre-multi-model-fix", preMultiModel]]) {
    await test(name + ": patch exits 2 then 0; atomic replace, backup and other patches preserved", () => {
      const copy = fixture(name, source), before = fs.statSync(copy.cli);
      apply(copy, 2);
      const after = fs.statSync(copy.cli);
      assert.notEqual(after.ino, before.ino, "Must rename rather than overwrite the original inode");
      assert.equal(after.mode, before.mode);
      assert.equal(fs.readFileSync(copy.cli + ".orig", "utf8"), source);
      const result = fs.readFileSync(copy.cli, "utf8");
      for (const key of names.map((entry) => entry + "_NEW")) assert.ok(result.includes(constants[key]), "Preserved patch: " + key);
      assert.ok(result.includes(signedSse), "Preserved patch: SSE_NEW + thought signature");
      assert.ok(result.includes(signatureScope(constants.SIG_EDITS[4][1])), "Preserved patch: scoped thought signature request");
      apply(copy, 0);
      assert.equal(fs.statSync(copy.cli).ino, after.ino);
      assert.equal(fs.readFileSync(copy.cli, "utf8"), result);
      assert.equal(fs.readFileSync(copy.cli + ".orig", "utf8"), source);
      noTemps(copy);
      if (patched) assert.equal(result, patched);
      patched = result;
    });
  }

  await test("An unrelated stream:true marker does not suppress the response patch", () => {
    const copy = fixture("unrelated-marker", original + "\n// t.req.body.stream === true\n");
    apply(copy, 2);
    assert.ok(fs.readFileSync(copy.cli, "utf8").includes(constants.SSE_MARK));
    apply(copy, 0);
    noTemps(copy);
  });

  await test("An existing original backup is preserved during fallback upgrade", () => {
    const copy = fixture("existing-backup", legacy);
    fs.writeFileSync(copy.cli + ".orig", original);
    apply(copy, 2);
    apply(copy, 0);
    assert.equal(fs.readFileSync(copy.cli + ".orig", "utf8"), original);
    noTemps(copy);
  });

  await test("Invalid generated syntax fails before any cli/backup/temp write", () => {
    const copy = fixture("syntax-failure", original), before = fs.statSync(copy.cli);
    const broken = patch.replace("    // ccr-response-v2: sniff JSON/SSE\n", "    // ccr-response-v2: sniff JSON/SSE\n    const invalid = ;\n");
    assert.notEqual(broken, patch);
    fs.writeFileSync(copy.patch, broken);
    assert.match(apply(copy, 1).stderr, /Node 语法检查失败/);
    assert.equal(fs.readFileSync(copy.cli, "utf8"), original);
    assert.equal(fs.statSync(copy.cli).ino, before.ino);
    assert.equal(fs.existsSync(copy.cli + ".orig"), false);
    noTemps(copy);
  });

  await test("A failed atomic rename leaves cli unchanged and removes its same-directory temp", () => {
    const copy = fixture("rename-failure", original), before = fs.statSync(copy.cli);
    const preload = path.join(copy.dir, "fail-rename.js");
    fs.writeFileSync(preload, 'const fs = require("node:fs"), rename = fs.renameSync;\nfs.renameSync = (from, to) => { if (to === ' + JSON.stringify(copy.cli) + ') throw new Error("simulated rename failure"); return rename(from, to); };\n');
    assert.match(apply(copy, 1, preload).stderr, /simulated rename failure/);
    assert.equal(fs.readFileSync(copy.cli, "utf8"), original);
    assert.equal(fs.statSync(copy.cli).ino, before.ino);
    assert.equal(fs.readFileSync(copy.cli + ".orig", "utf8"), original);
    noTemps(copy);
  });

  await test("Unknown bundle anchors fail without modifying the original", () => {
    const source = original.replace(constants.EFF_OLD, "false"), copy = fixture("missing-anchor", source);
    assert.match(apply(copy, 1).stderr, /找不到目标代码.*effort/);
    assert.equal(fs.readFileSync(copy.cli, "utf8"), source);
    assert.equal(fs.existsSync(copy.cli + ".orig"), false);
    noTemps(copy);
  });

  await test("Embedded static implementation is removed and the fixed external plugin is selected", () => {
    assert.ok(patched.includes('var import_static = __toESM(require("@fastify/static"));'));
    assert.doesNotMatch(patched, /require_(?:static|dirList)\b|@fastify\+static@8\.2\.0/);
  });

  await test("An altered embedded static implementation fails without writing any file", () => {
    const source = original.replace('var dirList = require_dirList();', 'var dirList = require_dirList(); // unknown change');
    assert.notEqual(source, original);
    const copy = fixture("unknown-static", source);
    assert.match(apply(copy, 1).stderr, /bundled static security/);
    assert.equal(fs.readFileSync(copy.cli, "utf8"), source);
    assert.equal(fs.existsSync(copy.cli + ".orig"), false);
    noTemps(copy);
  });

  await test("A missing or outdated external static dependency fails closed", () => {
    const copy = fixture("outdated-static", original);
    fs.unlinkSync(path.join(copy.dir, "node_modules/@fastify"));
    for (const version of [null, "8.3.0"]) {
      if (version) {
        const dir = path.join(copy.dir, "node_modules/@fastify/static");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@fastify/static", version }));
      }
      assert.match(apply(copy, 1).stderr, /@fastify\/static 10\.1\.2 dependency/);
      assert.equal(fs.readFileSync(copy.cli, "utf8"), original);
      assert.equal(fs.existsSync(copy.cli + ".orig"), false);
      noTemps(copy);
    }
  });

  await test("Removed minimatch internals with retained bundle references fail without writing", () => {
    for (const factory of ["require_ast", "require_brace_expressions"]) {
      const source = original + "\nvar unknownReference = " + factory + "();\n";
      const copy = fixture("retained-" + factory, source);
      assert.match(apply(copy, 1).stderr, new RegExp("retained reference " + factory));
      assert.equal(fs.readFileSync(copy.cli, "utf8"), source);
      assert.equal(fs.existsSync(copy.cli + ".orig"), false);
      noTemps(copy);
    }
  });
  await test("Outdated external glob/minimatch dependencies fail closed", () => {
    for (const [name, version] of [["glob", "11.1.0"], ["minimatch", "10.2.6"]]) {
      const copy = fixture("outdated-" + name, original);
      const dir = path.join(copy.dir, "node_modules", name);
      fs.unlinkSync(dir);fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({name, version}));
      assert.match(apply(copy, 1).stderr, new RegExp(name + " .* dependency"));
      assert.equal(fs.readFileSync(copy.cli, "utf8"), original);
      assert.equal(fs.existsSync(copy.cli + ".orig"), false);
      noTemps(copy);
    }
  });
  function actualModelRouter(source) {
    const start = source.indexOf('var getUseModel = async (req, tokenCount, config, lastUsage) => {');
    const end = source.indexOf('\nvar router = ',start);
    assert.ok(start > 0 && end > start,'actual pinned CCR model router boundaries');
    return vm.runInNewContext(source.slice(start,end)+'\ngetUseModel;', {getProjectSpecificRouter:async()=>undefined});
  }
  await test('Actual unpatched CCR overrides bare non-default IDs; patched CCR preserves configured session selections', async () => {
    const provider=(name,models)=>({name,api_base_url:`https://${name}.invalid/v1/chat/completions`,api_key:`fixture-${name}`,models});
    const config = {Providers:[provider('relay',['test-default','test-second','claude-haiku-explicit','Org/Model-X'])],Router:{default:'relay,test-default',think:'relay,test-default',background:'relay,test-default',longContext:'relay,test-default',webSearch:'relay,test-default',longContextThreshold:60000}};
    const request = (model,extra={}) => ({body:{model,...extra},log:{info(){}}});
    const before = actualModelRouter(original),after = actualModelRouter(patched);
    assert.equal(await before(request('test-second'),1,config),config.Router.default,'unpatched negative control');
    for(const id of config.Providers[0].models){
      for(const extra of [{},{thinking:{type:'adaptive'}},{tools:[{type:'web_search_20250305'}]},{system:[{}, {text:'<CCR-SUBAGENT-MODEL>other,model</CCR-SUBAGENT-MODEL>'}]}]){
        assert.equal(await after(request(id,extra),100000,config,{input_tokens:100000}),'relay,'+id);
      }
    }
    for(const id of ['unconfigured-model','test-SECOND','org/model-x','claude-haiku-alias'])assert.equal(await after(request(id),1,config),config.Router.default);
    assert.equal(await after(request('relay,test-second'),1,config),'relay,test-second','explicit legacy routing remains supported');
    assert.equal(await after(request('other,test-second'),1,config),'other,test-second','patch never fabricates a relay match from a comma route');
    assert.equal(await after(request('test-second'),1,{...config,Providers:[provider('not-relay',['test-second'])]}),'not-relay,test-second','a single usable provider can declare a bare ID');
    const multi={Providers:[provider('relay',['test-default','shared']),provider('backup',['backup-model','shared'])],Router:config.Router,
      MODEL_ROUTES:{'test-default':'relay,test-default','backup-model':'backup,backup-model','backup/shared':'backup,shared','shared':'relay,shared'}};
    assert.equal(await after(request('backup-model'),1,multi),'backup,backup-model','MODEL_ROUTES selects the second upstream');
    assert.equal(await after(request('backup-model',{thinking:{type:'adaptive'}}),100000,multi,{input_tokens:100000}),'backup,backup-model','mapping wins over think/long-context fallbacks');
    assert.equal(await after(request('backup/shared'),1,multi),'backup,shared','duplicate upstream IDs use the exposed alias');
    assert.equal(await after(request('shared'),1,multi),'relay,shared','bare duplicate IDs follow the explicit map');
    assert.equal(await after(request('shared'),1,{...multi,MODEL_ROUTES:{}}),config.Router.default,'ambiguous duplicates fall back instead of guessing');
    assert.equal(await after(request('test-default'),1,{...multi,MODEL_ROUTES:{'test-default':'missing,model'}}),config.Router.default,'invalid mapping targets fall through');
    assert.equal(await after(request('relay,test-default'),1,multi),'relay,test-default','explicit routes are untouched while MODEL_ROUTES is active');
  });
  await test('A v1 model-route and signature patch upgrades in place to provider-scoped v2', () => {
    let v1 = [...constants.SIG_SCOPE_EDITS].reverse().reduce((text,[oldText,newText])=>text.replace(newText,()=>oldText),patched)
      .replace(constants.MODEL_ROUTE_NEW, constants.MODEL_ROUTE_V1)
      .split('// ccr-thought-signature-v2').join('// ccr-thought-signature-v1');
    for (const [oldText, newText] of constants.SIG_V1_FRAGMENTS) v1 = v1.replace(newText, oldText);
    assert.ok(v1.includes('// ccr-relay-model-route-v1:') && v1.includes('// ccr-thought-signature-v1'));
    const copy = fixture('v1-upgrade', v1);
    apply(copy, 2);
    assert.equal(fs.readFileSync(copy.cli, 'utf8'), patched);
    assert.ok(!fs.readFileSync(copy.cli, 'utf8').includes('// ccr-thought-signature-v1'));
    apply(copy, 0);
    noTemps(copy);
  });
  await test('An existing v2 signature bundle upgrades to session-scoped caching idempotently',()=>{
    const v2=[...constants.SIG_SCOPE_EDITS].reverse().reduce((text,[oldText,newText])=>text.replace(newText,()=>oldText),patched);
    const copy=fixture('v2-scope-upgrade',v2);apply(copy,2);
    assert.equal(fs.readFileSync(copy.cli,'utf8'),patched);apply(copy,0);noTemps(copy);
  });
  await test('An unknown CCR model-route anchor fails closed before any bundle write', () => {
    const source = original.replace(constants.MODEL_ROUTE_OLD,constants.MODEL_ROUTE_OLD.replace('config.Router','config.UnexpectedRouter'));
    assert.notEqual(source,original);
    const copy = fixture('missing-model-route-anchor',source);
    assert.match(apply(copy,1).stderr,/configured model route/);
    assert.equal(fs.readFileSync(copy.cli,'utf8'),source);assert.equal(fs.existsSync(copy.cli+'.orig'),false);noTemps(copy);
  });
  function actualReasoningFetch(steps){
    const start=patched.indexOf('    // ccr-reasoning-fallback-v1'),end=patched.indexOf('\n  })();',start);
    assert.ok(start>0&&end>start,'actual published reasoning fallback boundaries');
    const requests=[],queue=[...steps],context={Response,console,r:'https://fixture.invalid/v1/chat/completions',e:null,c:null,n:{warn(){}},o:{req:{id:'fixture'}}};
    context.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});const step=queue.shift();assert.notEqual(step,undefined,'unexpected extra retry');if(step instanceof Error)throw step;return new Response(step.text,{status:step.status});};
    const invoke=vm.runInNewContext('(() => {\n'+patched.slice(start,end)+'\n})',context);
    return {requests,async send(body){context.e=body;context.c={body:JSON.stringify(body)};return await invoke();}};
  }
  await test('Published reasoning fallback strips once and remembers each URL/model without changing selected model',async()=>{
    const fake=actualReasoningFetch([{status:400,text:'Invalid request payload'},{status:200,text:'ok'},{status:200,text:'cached'},{status:200,text:'other'}]);
    const body={model:'selected-nondefault',reasoning_effort:'high',reasoning:{effort:'high'},stream:false};
    assert.equal(await (await fake.send(body)).text(),'ok');assert.equal(await (await fake.send(body)).text(),'cached');
    assert.equal(await (await fake.send({...body,model:'different-model'})).text(),'other');
    assert.equal(fake.requests.length,4);assert.equal(fake.requests[0].body.reasoning_effort,'high');
    for(const i of [1,2]){assert.equal(fake.requests[i].body.model,'selected-nondefault');assert.equal('reasoning'in fake.requests[i].body,false);assert.equal('reasoning_effort'in fake.requests[i].body,false);}
    assert.equal(fake.requests[3].body.reasoning_effort,'high');assert.equal(body.reasoning_effort,'high');
  });
  await test('Published reasoning fallback preserves the first 400 on retry HTTP/network failure and skips non-parameter errors',async()=>{
    for(const second of [{status:503,text:'later failed'},new Error('fake network failed')]){
      const fake=actualReasoningFetch([{status:400,text:'Invalid request payload FIRST'},second]);
      const response=await fake.send({model:'selected',reasoning_effort:'high'});assert.equal(response.status,400);assert.equal(await response.text(),'Invalid request payload FIRST');assert.equal(fake.requests.length,2);
    }
    for(const body of [{model:'selected',reasoning_effort:'high'},{model:'selected'}]){
      const fake=actualReasoningFetch([{status:400,text:'daily quota exhausted'}]);const response=await fake.send(body);assert.equal(response.status,400);assert.equal(await response.text(),'daily quota exhausted');assert.equal(fake.requests.length,1);
    }
  });
  await test('Published reasoning fallback rejects ambiguous anchors without touching the bundle',()=>{
    const source=original+'\n// another anchor'+constants.REASON_OLD,copy=fixture('ambiguous-reasoning-anchor',source);
    assert.match(apply(copy,1).stderr,/reasoning fallback \(anchor not unique\)/);assert.equal(fs.readFileSync(copy.cli,'utf8'),source);assert.equal(fs.existsSync(copy.cli+'.orig'),false);noTemps(copy);
  });
  const transformer = extract(patched);
  await test("Request stream:false and effort patches still execute normally", async () => {
    const request = await transformer.transformRequestOut({ model: "test-model", messages: [], output_config: { effort: "max" }, thinking: { type: "adaptive" } });
    assert.equal(request.stream, false);
    assert.equal(request.reasoning_effort, "max");
    assert.equal(request.reasoning.enabled, true);
  });

  const plain = (value) => JSON.parse(JSON.stringify(value));
  const image = (data, media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data } });
  const text = (value) => ({ type: "text", text: value });
  const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content });
  const call = (id) => ({ type: "tool_use", id, name: "Read", input: { file_path: "/test/" + id + ".png" } });
  const convert = async (messages) => plain((await transformer.transformRequestOut({ model: "test-model", messages })).messages);
  const imageParts = (messages) => messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url") : []);

  await test("Large tool image is a real image_url, not base64 text; source stays unchanged", async () => {
    const data = "ABCD".repeat(150000);
    const messages = [{ role: "assistant", content: [call("large")] }, { role: "user", content: [result("large", [text("before"), image(data), text("after")])] }];
    const before = JSON.stringify(messages), out = await convert(messages);
    assert.equal(JSON.stringify(messages), before);
    assert.deepEqual(out.map((message) => message.role), ["assistant", "tool", "user"]);
    assert.equal(out[1].tool_call_id, "large");
    assert.ok(out[1].content.length < 250);
    assert.equal(out[1].content.includes(data), false);
    const content = JSON.parse(out[1].content);
    assert.deepEqual(content[0], text("before"));
    assert.deepEqual(content[2], text("after"));
    assert.match(content[1].text, /Image 1.*large/);
    assert.equal(imageParts(out)[0].image_url.url, "data:image/png;base64," + data);
    assert.equal(imageParts(out).length, 1);
  });

  await test("Parallel tool replies in adjacent user messages precede every image/user message", async () => {
    const messages = [
      { role: "assistant", content: [text("read"), call("a"), call("b"), call("c")] },
      { role: "user", content: [result("a", [image("aaaa")]), text("follow-up a")] },
      { role: "user", content: [result("b", [image("bbbb"), image("cccc", "image/jpeg")])] },
      { role: "user", content: [result("c", "plain text"), text("follow-up c")] },
      { role: "assistant", content: [text("next"), text("line")] }
    ];
    const out = await convert(messages);
    assert.deepEqual(out.map((message) => message.role), ["assistant", "tool", "tool", "tool", "user", "user", "user", "assistant"]);
    assert.deepEqual(out.slice(1, 4).map((message) => message.tool_call_id), ["a", "b", "c"]);
    assert.equal(out[3].content, "plain text");
    assert.equal(out.at(-1).content, "next\nline");
    assert.equal(imageParts(out).length, 3);
    assert.ok(out[4].content.some((part) => part.text === "follow-up a"));
    assert.match(out[5].content[2].text, /b, image 2/);
  });

  await test("Same-message parallel tools and direct uploads keep IDs, cache hints and image order", async () => {
    const cached = { ...result("a", [image("aaaa")]), cache_control: { type: "ephemeral" }, is_error: true };
    const out = await convert([
      { role: "assistant", content: [call("a"), call("b")] },
      { role: "user", content: [cached, result("b", [image("bbbb")]), text("direct"), image("cccc")] }
    ]);
    assert.deepEqual(out.map((message) => message.role), ["assistant", "tool", "tool", "user"]);
    assert.deepEqual(out[1].cache_control, { type: "ephemeral" });
    assert.deepEqual(imageParts(out).map((part) => part.image_url.url), ["data:image/png;base64,aaaa", "data:image/png;base64,bbbb", "data:image/png;base64,cccc"]);
    assert.ok(out[3].content.some((part) => part.text === "direct"));
  });

  await test("URL, pre-prefixed data URLs and base64 containing the word base64 stay intact", async () => {
    const urlImage = { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } };
    const out = await convert([{ role: "user", content: [result("url", [urlImage, image("data:image/png;base64,aaaa"), image("AAAAbase64BBBB")]), urlImage] }]);
    assert.deepEqual(imageParts(out).map((part) => part.image_url.url), ["https://example.invalid/image.png", "data:image/png;base64,aaaa", "data:image/png;base64,AAAAbase64BBBB", "https://example.invalid/image.png"]);
    assert.equal(out[0].content.includes("source"), false);
  });

  await test("String and text-only tool results, empty output and error text are unchanged", async () => {
    const array = [text("first"), text("second")];
    const out = await convert([{ role: "user", content: [result("str", "literal"), result("arr", array), result("empty", []), { ...result("error", "not found"), is_error: true }] }]);
    assert.deepEqual(out.map((message) => message.role), ["tool", "tool", "tool", "tool"]);
    assert.deepEqual(out.map((message) => message.content), ["literal", JSON.stringify(array), "[]", "not found"]);
    assert.equal(imageParts(out).length, 0);
  });

  const countStart = patched.indexOf("var calculateTokenCount = ");
  const countEnd = patched.indexOf("\nvar readConfigFile2 = ", countStart);
  const encoded = [];
  const count = vm.runInNewContext(patched.slice(countStart, countEnd) + "\ncalculateTokenCount;", {
    enc: { encode(value) { assert.equal(typeof value, "string"); encoded.push(value); return { length: value.length }; } }
  });
  await test("Image token estimate never sends base64 through the text tokenizer", () => {
    encoded.length = 0;
    const messages = [{ role: "user", content: [result("image", [text("left"), image("A".repeat(800000)), text("right")]), image("BBBB")] }];
    assert.equal(count(messages), 8192 + 9);
    assert.deepEqual(encoded, ["left", "right"]);
    assert.equal(count([{ role: "user", content: [result("small", [image("AA==")])] }]), 4096);
  });
  await test("Text/system/tool-schema counting still executes normally", () => {
    const schema = { type: "object" };
    const messages = [{ role: "user", content: "abc" }, { role: "assistant", content: [call("x")] }, { role: "user", content: [result("x", "def")] }];
    const expected = 6 + JSON.stringify(call("x").input).length + 3 + "Readfile".length + JSON.stringify(schema).length;
    assert.equal(count(messages, [text("sys")], [{ name: "Read", description: "file", input_schema: schema }]), expected);
  });

  for (const header of ["text/event-stream", "application/json", "application/octet-stream", null]) {
    await test("Actual SSE, header=" + header + ": split UTF-8/prefix, text and trailing usage", async () => {
      const source = upstream("﻿ \t\r\n" + sse(textFrames), header, { sizes: [1, 2, 3, 1, 5] });
      const message = assemble(await events(await transformer.transformResponseIn(source.response, context(true))));
      assert.deepEqual(message.content, [{ type: "text", text: "正文 你好🙂\n第二行" }]);
      assert.deepEqual(message.usage, expectedUsage);
      assert.equal(message.stop_reason, "end_turn");
      assert.equal(source.body.locked, false);
    });
  }

  await test("SSE comments/event/id/retry, multiline data and split CRLF are normalized", async () => {
    const source = upstream(" ﻿\r\n: heartbeat\r\n\r\nid: 1\r\nretry: 1000\r\n" + sse(textFrames, "\r\n", true, true), "application/json", { sizes: [1] });
    const message = assemble(await events(await transformer.transformResponseIn(source.response, context(true))));
    assert.deepEqual(message.content, [{ type: "text", text: "正文 你好🙂\n第二行" }]);
    assert.deepEqual(message.usage, expectedUsage);
  });

  await test("SSE finish/usage in one chunk are not lost; complete EOF needs no DONE/newline", async () => {
    const frames = [chunk({ content: "length limit" }), chunk({}, "length"), { choices: [], usage }];
    const source = upstream(sse(frames, "\r", false).replace(/\r+$/, ""), "application/json");
    const message = assemble(await events(await transformer.transformResponseIn(source.response, context(true))));
    assert.equal(message.stop_reason, "max_tokens");
    assert.deepEqual(message.usage, expectedUsage);
    assert.equal(source.body.locked, false);
  });

  for (const header of ["application/json", "text/event-stream", null]) {
    await test("Real JSON with stream:true, header=" + header + ": legal Anthropic SSE retaining text/id/model/usage", async () => {
      const value = completion(), source = upstream(" ﻿\n\t" + JSON.stringify(value), header, { sizes: [1, 3, 2] });
      const message = assemble(await events(await transformer.transformResponseIn(source.response, context(true))));
      assert.deepEqual(message, JSON.parse(JSON.stringify(transformer.convertOpenAIResponseToAnthropic(value, context(true)))));
      assert.equal(source.body.locked, false);
    });
  }

  for (const stream of [false, undefined]) {
    await test("Non-stream JSON stays JSON, stream=" + stream, async () => {
      const value = completion(), source = upstream("﻿ \n" + JSON.stringify(value), "application/json", { sizes: [1, 2, 3] });
      const result = await transformer.transformResponseIn(source.response, context(stream));
      assert.equal(result.headers.get("Content-Type"), "application/json");
      assert.deepEqual(await result.json(), JSON.parse(JSON.stringify(transformer.convertOpenAIResponseToAnthropic(value, context(stream)))));
      assert.equal(source.body.locked, false);
    });
  }

  const tools = [
    { id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":"上海","options":{"unit":"c"}}' } },
    { id: "call_clock", type: "function", function: { name: "clock", arguments: { timezone: "Asia/Shanghai" } } }
  ];
  for (const stream of [true, false]) {
    await test("Real JSON tools-only response preserves two calls/arguments/usage, stream=" + stream, async () => {
      const value = completion({ role: "assistant", content: null, tool_calls: tools }, "tool_calls");
      const result = await transformer.transformResponseIn(upstream(JSON.stringify(value)).response, context(stream));
      const message = stream ? assemble(await events(result)) : await result.json();
      assert.deepEqual(message, JSON.parse(JSON.stringify(transformer.convertOpenAIResponseToAnthropic(value, context(stream)))));
      assert.equal(message.stop_reason, "tool_use");
      assert.deepEqual(message.usage, expectedUsage);
    });
  }

  await test("Real JSON text + tools + thinking retain legal block order and length stop", async () => {
    const value = completion({ role: "assistant", content: "checking", tool_calls: tools, thinking: { content: "thought", signature: "sig" } }, "length");
    const message = assemble(await events(await transformer.transformResponseIn(upstream(JSON.stringify(value)).response, context(true))));
    assert.deepEqual(message, JSON.parse(JSON.stringify(transformer.convertOpenAIResponseToAnthropic(value, context(true)))));
    assert.equal(message.stop_reason, "max_tokens");
  });

  await test("Streaming tool arguments and trailing usage survive normalization/conversion", async () => {
    const frames = [
      chunk({ tool_calls: [{ index: 0, id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"上海"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_clock", type: "function", function: { name: "clock", arguments: '{"timezone":"Asia/Shanghai"}' } }] }),
      chunk({}, "tool_calls"), { choices: [], usage }
    ];
    const message = assemble(await events(await transformer.transformResponseIn(upstream(sse(frames), "application/json", { sizes: [2, 1, 7] }).response, context(true))));
    assert.deepEqual(message.content, [
      { type: "tool_use", id: "call_weather", name: "weather", input: { city: "上海" } },
      { type: "tool_use", id: "call_clock", name: "clock", input: { timezone: "Asia/Shanghai" } }
    ]);
    assert.equal(message.stop_reason, "tool_use");
    assert.deepEqual(message.usage, expectedUsage);
  });

  await test("Client cancellation reaches the sniffed upstream reader without buffering the full SSE", async () => {
    const source = upstream(sse([chunk({ content: "first token" })], "\n", false), "application/json", { hang: true, sizes: [1, 5, 2] });
    const result = await transformer.transformResponseIn(source.response, context(true));
    const reader = result.body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel("regression-cancel");
    reader.releaseLock();
    for (let n = 0; n < 20 && (source.state.canceled.length === 0 || source.body.locked); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(source.state.canceled, ["regression-cancel"]);
    assert.equal(source.body.locked, false);
  });

  for (const [name, text, stream, socketClose] of [
    ["split prefix", "da", true, false],
    ["first SSE data after a comment", ": heartbeat\n\n", true, true],
    ["real JSON body", '{"choices":', true, false],
    ["non-stream JSON body", '{"choices":', false, true]
  ]) {
    await test("Disconnect while waiting for " + name + " cancels upstream and removes listeners", async () => {
      const source = upstream(text, "application/json", { hang: true }), ctx = client(stream);
      const pending = transformer.transformResponseIn(source.response, ctx);
      const rejected = assert.rejects(pending, (error) => error.code === "ERR_STREAM_PREMATURE_CLOSE");
      await new Promise((resolve) => setImmediate(resolve));
      if (socketClose) ctx.req.raw.socket.emit("close");
      else ctx.req.raw.emit("aborted");
      await rejected;
      assert.equal(source.state.canceled.length, 1);
      assert.equal(source.body.locked, false);
      noListeners(ctx);
    });
  }

  await test("Already-disconnected client never starts reading upstream", async () => {
    const source = upstream("data: ", "text/event-stream", { hang: true }), ctx = client(true);
    ctx.req.raw.aborted = true;
    await assert.rejects(transformer.transformResponseIn(source.response, ctx), (error) => error.code === "ERR_STREAM_PREMATURE_CLOSE");
    assert.equal(source.state.reads, 0);
    assert.equal(source.state.canceled.length, 1);
    assert.equal(source.body.locked, false);
    noListeners(ctx);
  });

  await test("Normal JSON/SSE completion removes disconnect listeners", async () => {
    for (const text of [JSON.stringify(completion()), sse(textFrames)]) {
      const source = upstream(text), ctx = client(true);
      await events(await transformer.transformResponseIn(source.response, ctx));
      noListeners(ctx);
      assert.equal(source.body.locked, false);
    }
  });

  await test("Cancel real-JSON SSE without leaking the original reader/listeners", async () => {
    const source = upstream(JSON.stringify(completion())), ctx = client(true);
    const response = await transformer.transformResponseIn(source.response, ctx);
    await response.body.cancel("cancel JSON fallback");
    assert.equal(source.body.locked, false);
    noListeners(ctx);
  });

  await test("DONE releases an upstream connection even if it never closes its HTTP body", async () => {
    const source = upstream(sse(textFrames), "text/event-stream", { hang: true });
    assert.deepEqual(assemble(await events(await transformer.transformResponseIn(source.response, context(true)))).usage, expectedUsage);
    assert.equal(source.state.canceled.length, 1);
    assert.equal(source.body.locked, false);
  });

  const invalidJSON = [
    ["empty", ""], ["whitespace/BOM", " ﻿ \n"], ["HTML", "<html>bad gateway</html>"],
    ["malformed JSON", '{"choices":'], ["null", "null"], ["array", "[]"], ["missing choices", "{}"],
    ["no choices", '{"choices":[]}'], ["missing message", '{"choices":[{}]}'],
    ["missing content", '{"choices":[{"message":{}}]}'],
    ["JSON error", '{"error":{"message":"upstream rejected"}}'],
    ["JSON error with valid choices", JSON.stringify({ ...completion(), error: "quota exceeded" })],
    ["invalid tool JSON", JSON.stringify(completion({ content: null, tool_calls: [{ id: "call_bad", function: { name: "bad", arguments: "{" } }] }, "tool_calls"))],
    ["invalid usage", JSON.stringify({ ...completion(), usage: { completion_tokens: "seven" } })],
    ["missing id/model", JSON.stringify({ choices: completion().choices })],
    ["invalid UTF-8", new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]
  ];
  for (const [name, payload] of invalidJSON) {
    await test("Invalid JSON is a provider error, not an empty success: " + name, async () => {
      for (const stream of [true, false]) {
        const source = upstream(payload, "application/json", { sizes: [1, 2, 3] });
        await assert.rejects(transformer.transformResponseIn(source.response, context(stream)), (error) => error.code === "provider_error" && error.statusCode === 502);
        assert.equal(source.body.locked, false);
      }
    });
  }

  for (const [name, payload] of [
    ["malformed event JSON", "data: {bad}\n\n"], ["upstream error", 'data: {"error":{"message":"quota exceeded"}}\n\n'],
    ["empty DONE", "data: [DONE]\n\n"], ["comments only", ": heartbeat\n\n"],
    ["wrong event shape", "data: {}\n\n"], ["missing delta", sse([{ choices: [{ message: { content: "not a chunk" } }] }])],
    ["usage-only without a choice", sse([{ choices: [], usage }])],
    ["empty successful stop", sse([chunk({}, "stop")])]
  ]) {
    await test("Invalid initial SSE rejects before success headers: " + name, async () => {
      const source = upstream(payload, "application/json", { sizes: [1, 2] });
      await assert.rejects(transformer.transformResponseIn(source.response, context(true)), (error) => error.code === "provider_error" && error.statusCode === 502);
      assert.equal(source.body.locked, false);
    });
  }

  for (const [name, suffix, options] of [
    ["truncated EOF", "", {}], ["premature DONE", "data: [DONE]\n\n", {}],
    ["malformed later JSON", "data: {bad}\n\n", {}],
    ["later provider error", 'data: {"error":{"message":"late failure"}}\n\n', {}],
    ["transport read failure", "", { error: "simulated upstream disconnect" }]
  ]) {
    await test("Invalid later SSE errors the output stream rather than emitting message_stop: " + name, async () => {
      const source = upstream(sse([chunk({ content: "partial" })], "\n", false) + suffix, "application/json", options);
      const result = await transformer.transformResponseIn(source.response, context(true));
      const reader = result.body.getReader(), decoder = new TextDecoder();
      let output = "";
      await assert.rejects(async () => {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          output += decoder.decode(part.value, { stream: true });
        }
      }, /Provider error|simulated upstream disconnect/);
      reader.releaseLock();
      assert.doesNotMatch(output, /event: message_stop/);
      assert.equal(source.body.locked, false);
    });
  }

  for (const [name, delta] of [
    ["unparseable arguments", { tool_calls: [{ index: 0, id: "call_bad", function: { name: "bad", arguments: "{" } }] }],
    ["missing tool identity", { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }]
  ]) {
    await test("Invalid streamed tool call is not silently accepted: " + name, async () => {
      const source = upstream(sse([chunk(delta), chunk({}, "tool_calls")]), "text/event-stream");
      const response = await transformer.transformResponseIn(source.response, context(true));
      await assert.rejects(response.text(), /Invalid streamed tool/);
      assert.equal(source.body.locked, false);
    });
  }

  // 签名记在 transformer 所在的全局里，请求侧回填也读同一个全局：两段实际发布代码放进同一个 vm 上下文。
  function signatureHarness() {
    const start = patched.indexOf("var Vf = "), end = patched.indexOf("\n};\nvar Cn =", start);
    const reqStart = patched.indexOf("  // ccr-thought-signature-v2: return"), reqEnd = patched.indexOf("\n  let u, f = AbortSignal.timeout", reqStart);
    assert.ok(start > 0 && end > start && reqStart > 0 && reqEnd > reqStart, "actual published thought-signature boundaries");
    const sandbox = vm.createContext({
      Response, ReadableStream, TextEncoder, TextDecoder, Error, TypeError, console,
      Wt: () => "regression-uuid",
      nt: (message, statusCode = 500, code = "internal_error", type = "api_error") => Object.assign(new Error(message), { statusCode, code, type }),
      fetch() { throw new Error("Network is forbidden in this test"); }
    });
    const Transformer = vm.runInContext(patched.slice(start, end + 4) + "\nbo;", sandbox);
    const transformer = new Transformer();
    transformer.logger = { debug() {}, error() {} };
    const send = vm.runInContext("((e, o) => {\n" + patched.slice(reqStart, reqEnd) + "\n  return e;\n})", sandbox);
    const outgoing=(body,context)=>{for(const [key,value] of Object.entries({provider:'relay',sessionId:'fixture-session'}))if(!Object.hasOwn(context.req,key))context.req[key]=value;return send(body,context);};
    const cacheKey=(id,session='fixture-session',provider='relay',model='gemini-3-pro')=>JSON.stringify([JSON.stringify([session,provider,model]),id]);
    return { transformer, outgoing, cacheKey, sigs: () => vm.runInContext("globalThis.__ccrThoughtSigs", sandbox) };
  }
  const signed = (signature) => ({ google: { thought_signature: signature } });
  const assistantCalls = (body) => plain(body).messages.filter((message) => message.role === "assistant").map((message) => message.tool_calls);

  await test("Gemini streamed parallel call signature is remembered and returned only to the same model", async () => {
    const { transformer: tf, outgoing } = signatureHarness(), ctx = client(true), model = "gemini-3-pro-preview";
    outgoing({ model, messages: [{ role: "user", content: "hi" }] }, ctx);
    const frames = [
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: '{"f":' }, extra_content: signed("SIG_A") }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "Read", arguments: "{}" } }] }),
      chunk({}, "tool_calls"), { choices: [], usage }
    ];
    const message = assemble(await events(await tf.transformResponseIn(upstream(sse(frames), "text/event-stream", { sizes: [3, 11] }).response, ctx)));
    assert.deepEqual(plain(message.content), [
      { type: "tool_use", id: "call_a", name: "Read", input: { f: 1 } },
      { type: "tool_use", id: "call_b", name: "Read", input: {} }
    ]);
    const history = [{ role: "user", content: "hi" }, { role: "assistant", content: message.content }, { role: "user", content: [result("call_a", "x"), result("call_b", "y")] }];
    const request = await tf.transformRequestOut({ model, messages: history });
    const before = JSON.stringify(request), body = outgoing(request, { req: { id: "next" } });
    assert.equal(JSON.stringify(request), before, "request body must not be mutated");
    const [calls] = assistantCalls(body);
    assert.deepEqual(calls.map((call) => call.id), ["call_a", "call_b"]);
    assert.deepEqual(calls[0].extra_content, signed("SIG_A"));
    assert.equal("extra_content" in calls[1], false);
    assert.equal(outgoing({ ...request, model: "other-model" }, { req: {} }).messages, request.messages, "non-Gemini models get no extra field");
    const [other] = assistantCalls(outgoing({ ...request, model: "gemini-3-flash-preview" }, { req: {} }));
    assert.deepEqual(other[0].extra_content, signed("skip_thought_signature_validator"), "another Gemini model never receives a foreign signature");
  });

  await test("Remembered Gemini signatures are scoped to the same upstream provider", async () => {
    const { transformer: tf, outgoing } = signatureHarness(), ctx = client(true), model = "gemini-3-pro-preview";
    ctx.req.provider = "relay";
    outgoing({ model, messages: [] }, ctx);
    const frames = [
      chunk({ tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "Read", arguments: "{}" }, extra_content: signed("SIG_P") }] }),
      chunk({}, "tool_calls"), { choices: [], usage }
    ];
    await events(await tf.transformResponseIn(upstream(sse(frames), "text/event-stream").response, ctx));
    const history = [{ role: "assistant", content: "", tool_calls: [{ id: "call_p", type: "function", function: { name: "Read", arguments: "{}" } }] }];
    assert.deepEqual(assistantCalls(outgoing({ model, messages: history }, { req: { provider: "backup" } }))[0][0].extra_content, signed("skip_thought_signature_validator"), "a different provider never receives the signature");
    assert.deepEqual(assistantCalls(outgoing({ model, messages: history }, { req: { provider: "relay" } }))[0][0].extra_content, signed("SIG_P"));
  });
  await test('Repeated tool IDs are isolated across sessions and missing identity uses only fallback',async()=>{
    const {transformer:tf,outgoing}=signatureHarness(),model='gemini-3-pro';
    const call={id:'call_0',type:'function',function:{name:'Read',arguments:'{}'}};
    for(const [session,signature] of [['session-a','SIG_A'],['session-b','SIG_B']]){
      const ctx=client(false);ctx.req.sessionId=session;outgoing({model,messages:[]},ctx);
      const value=completion({role:'assistant',content:null,tool_calls:[{...call,extra_content:signed(signature)}]},'tool_calls');
      await (await tf.transformResponseIn(upstream(JSON.stringify(value)).response,ctx)).json();
    }
    const body={model,messages:[{role:'assistant',content:'',tool_calls:[call]}]};
    for(const [session,signature] of [['session-a','SIG_A'],['session-b','SIG_B']])assert.deepEqual(assistantCalls(outgoing(body,{req:{provider:'relay',sessionId:session}}))[0][0].extra_content,signed(signature));
    for(const req of [{provider:undefined,sessionId:'session-a'},{provider:'relay',sessionId:undefined},{provider:'backup',sessionId:'session-a'}])assert.deepEqual(assistantCalls(outgoing(body,{req}))[0][0].extra_content,signed('skip_thought_signature_validator'));
  });
  for (const stream of [false, true]) {
    await test("Gemini JSON tool-call signature round trip without leaking into Anthropic output, stream=" + stream, async () => {
      const { transformer: tf, outgoing } = signatureHarness(), ctx = client(stream), model = "gemini-3-flash-preview";
      outgoing({ model, messages: [] }, ctx);
      const call = { id: "call_j", type: "function", function: { name: "Read", arguments: "{}" }, extra_content: signed("SIG_J") };
      const value = completion({ role: "assistant", content: null, tool_calls: [call] }, "tool_calls");
      const response = await tf.transformResponseIn(upstream(JSON.stringify(value)).response, ctx);
      const message = stream ? assemble(await events(response)) : await response.json();
      assert.deepEqual(plain(message.content), [{ type: "tool_use", id: "call_j", name: "Read", input: {} }]);
      const body = outgoing({ model, messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_j", type: "function", function: { name: "Read", arguments: "{}" } }] }] }, { req: {} });
      assert.deepEqual(assistantCalls(body)[0][0].extra_content, signed("SIG_J"));
    });
  }

  await test("Signature and id arriving in different stream fragments are paired at finish", async () => {
    const { transformer: tf, outgoing } = signatureHarness(), ctx = client(true), model = "gemini-3-pro-preview";
    outgoing({ model, messages: [] }, ctx);
    const frames = [
      chunk({ tool_calls: [{ index: 0, type: "function", function: { name: "Read", arguments: "{" }, extra_content: signed("EARLY") }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_late", function: { arguments: "}" } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_second", type: "function", function: { name: "Read", arguments: "{}" } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: "" }, extra_content: signed("LATE") }] }),
      chunk({}, "tool_calls")
    ];
    await events(await tf.transformResponseIn(upstream(sse(frames), "text/event-stream").response, ctx));
    const body = outgoing({ model, messages: [{ role: "assistant", content: "", tool_calls: ["call_late", "call_second"].map((id) => ({ id, type: "function", function: { name: "Read", arguments: "{}" } })) }] }, { req: {} });
    assert.deepEqual(assistantCalls(body)[0].map((call) => call.extra_content), [signed("EARLY"), signed("LATE")]);
  });

  await test("Published Gf sends signatures on both the first attempt and the reasoning-parameter retry", async () => {
    const start = patched.indexOf("function Gf(r, e, t, n, o) {"), end = patched.indexOf("\nvar Wf = ", start);
    assert.ok(start > 0 && end > start, "actual published Gf boundaries");
    const requests = [], sandbox = vm.createContext({ Headers, AbortSignal, AbortController, URL, Response, Set, JSON, import_undici: { Agent: class {}, ProxyAgent: class {} } });
    sandbox.fetch = async (url, options) => { requests.push(JSON.parse(options.body)); return new Response(requests.length === 1 ? "Invalid request payload" : "ok", { status: requests.length === 1 ? 400 : 200 }); };
    const scope=JSON.stringify(['fixture-session','relay','gemini-3-pro']),key=JSON.stringify([scope,'call_r']);
    sandbox.signatureKey=key;
    vm.runInContext("globalThis.__ccrThoughtSigs = new Map([[signatureKey, { model: 'gemini-3-pro', provider:'relay', signature: 'SIG_R' }]]);", sandbox);
    const Gf = vm.runInContext(patched.slice(start, end) + "\nGf;", sandbox), req = { id: "retry",provider:'relay',sessionId:'fixture-session' };
    const body = { model: "gemini-3-pro", reasoning_effort: "high", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_r", type: "function", function: { name: "Read", arguments: "{}" } }] }] };
    const response = await Gf("https://fixture.invalid/v1/chat/completions", body, {}, { debug() {}, warn() {} }, { req });
    assert.equal(await response.text(), "ok");
    assert.equal(requests.length, 2);
    for (const sent of requests) assert.deepEqual(plain(sent.messages[0].tool_calls[0].extra_content), signed("SIG_R"));
    assert.equal(requests[0].reasoning_effort, "high");
    assert.equal("reasoning_effort" in requests[1], false);
    assert.equal(req.__ccrUpstreamModel, "gemini-3-pro");
    assert.equal("extra_content" in body.messages[0].tool_calls[0], false);
  });

  await test("Gemini without remembered signatures gets the documented placeholder once per step; others are untouched", () => {
    const { outgoing, sigs } = signatureHarness();
    const step = (a, b) => ({ role: "assistant", content: "", tool_calls: [a, b].map((id) => ({ id, type: "function", function: { name: "Read", arguments: "{}" } })) });
    const messages = [{ role: "user", content: "hi" }, step("s1a", "s1b"), { role: "tool", tool_call_id: "s1a", content: "x" }, { role: "assistant", content: "plain" }, step("s2a", "s2b")];
    const body = outgoing({ model: "Gemini-3-Pro", messages }, { req: {} });
    const calls = assistantCalls(body).filter(Boolean);
    assert.deepEqual(calls.map((pair) => pair.map((call) => call.extra_content?.google?.thought_signature ?? null)), [["skip_thought_signature_validator", null], ["skip_thought_signature_validator", null]]);
    assert.deepEqual(plain(body).messages[3], { role: "assistant", content: "plain" });
    const kept = { ...step("k1", "k2"), tool_calls: [{ id: "k1", type: "function", function: { name: "Read", arguments: "{}" } }, { id: "k2", type: "function", function: { name: "Read", arguments: "{}" }, extra_content: signed("OWN") }] };
    const same = { model: "gemini-3-pro", messages: [kept] };
    assert.equal(outgoing(same, { req: {} }), same, "an existing signature anywhere in the step is left alone");
    const ctx = { req: {} }, plainBody = { model: "deepseek-chat", messages };
    assert.equal(outgoing(plainBody, ctx), plainBody);
    assert.equal(ctx.req.__ccrUpstreamModel, "deepseek-chat");
    assert.equal(sigs(), undefined);
  });

  await test("Remembered signatures are bounded, typed and size-limited", async () => {
    const { transformer: tf, outgoing, sigs, cacheKey } = signatureHarness(), ctx = client(false);
    outgoing({ model: "gemini-3-pro", messages: [] }, ctx);
    const respond = async (id, signature) => {
      const value = completion({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "Read", arguments: "{}" }, extra_content: { google: { thought_signature: signature } } }] }, "tool_calls");
      await (await tf.transformResponseIn(upstream(JSON.stringify(value)).response, ctx)).json();
    };
    await respond("huge", "x".repeat(65537));
    await respond("number", 42);
    await respond("empty", "");
    assert.equal(sigs(), undefined);
    for (let i = 0; i < 1030; i++) await respond("call_" + i, "SIG_" + i);
    assert.equal(sigs().size, 1024);
    assert.equal(sigs().has(cacheKey('call_5')), false);
    assert.equal(sigs().get(cacheKey('call_6')).signature, "SIG_6");
    assert.equal(sigs().get(cacheKey('call_1029')).model, "gemini-3-pro");
  });

  await test("Missing or duplicated thought-signature anchors fail closed before any bundle write", () => {
    for (const [name, source] of [
      ["missing-signature-anchor", original.replace(constants.SIG_EDITS[4][0], constants.SIG_EDITS[4][0].replace("AbortSignal.timeout", "AbortSignal.timeout2"))],
      ["duplicate-signature-anchor", original + "\n/*\n" + constants.SIG_EDITS[4][0] + "\n*/\n"]
    ]) {
      assert.notEqual(source, original);
      const copy = fixture(name, source);
      assert.match(apply(copy, 1).stderr, /thought signature \(1 anchors missing or not unique\)/);
      assert.equal(fs.readFileSync(copy.cli, "utf8"), source);
      assert.equal(fs.existsSync(copy.cli + ".orig"), false);
      noTemps(copy);
    }
  });

  await test("Null body and non-2xx response fail explicitly", async () => {
    await assert.rejects(transformer.transformResponseIn(new Response(null), context(true)), (error) => error.code === "provider_error");
    const source = upstream(JSON.stringify(completion()), "application/json", { status: 429, hang: true });
    await assert.rejects(transformer.transformResponseIn(source.response, context(true)), (error) => error.statusCode === 429);
    assert.equal(source.body.locked, false);
    assert.equal(source.state.canceled.length, 1);
  });

  await test("The real cli.js bytes, inode and modification time are unchanged", () => {
    assert.deepEqual(fs.readFileSync(cliFile), realCliBefore);
    const after = fs.statSync(cliFile);
    assert.equal(after.ino, realCliStat.ino);
    assert.equal(after.mtimeMs, realCliStat.mtimeMs);
  });
}

(async () => {
  try {
    await main();
    console.log("PASS: " + passed + " isolated regression tests");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
