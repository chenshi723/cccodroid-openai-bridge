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

const context = (stream) => ({ req: { id: "regression", body: stream === undefined ? {} : { stream } } });
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
  const names = ["EFF", "UE", "UR", "READER", "CANCEL", "H", "BODY", "AGENT", "STREAM", "TOOL_IMAGES", "IMAGE_TOKENS"];
  const keys = names.flatMap((name) => [name + "_OLD", name + "_NEW"]).concat(["SSE_OLD", "SSE_NEW", "SSE_FALLBACK", "SSE_MARK"]);
  const constants = vm.runInNewContext(patch.slice(patch.indexOf("const EFF_OLD"), patch.indexOf("\nlet src =")) + "\n({" + keys.join(",") + "});");
  let original = fs.readFileSync(cliFile, "utf8");
  original = original.replace(constants.SSE_NEW, constants.SSE_OLD).replace(constants.SSE_FALLBACK, constants.SSE_OLD);
  for (const name of names) original = original.replace(constants[name + "_NEW"], constants[name + "_OLD"]);
  for (const key of names.map((name) => name + "_OLD").concat("SSE_OLD")) assert.ok(original.includes(constants[key]), "Original anchor: " + key);
  let legacy = original;
  for (const name of names) legacy = legacy.replace(constants[name + "_OLD"], constants[name + "_NEW"]);
  legacy = legacy.replace(constants.SSE_OLD, constants.SSE_FALLBACK);
  let patched;

  const preImages = legacy.replace(constants.SSE_FALLBACK, constants.SSE_NEW).replace(constants.TOOL_IMAGES_NEW, constants.TOOL_IMAGES_OLD).replace(constants.IMAGE_TOKENS_NEW, constants.IMAGE_TOKENS_OLD);
  for (const [name, source] of [["original", original], ["legacy-fallback", legacy], ["pre-image-fix", preImages]]) {
    await test(name + ": patch exits 2 then 0; atomic replace, backup and other patches preserved", () => {
      const copy = fixture(name, source), before = fs.statSync(copy.cli);
      apply(copy, 2);
      const after = fs.statSync(copy.cli);
      assert.notEqual(after.ino, before.ino, "Must rename rather than overwrite the original inode");
      assert.equal(after.mode, before.mode);
      assert.equal(fs.readFileSync(copy.cli + ".orig", "utf8"), source);
      const result = fs.readFileSync(copy.cli, "utf8");
      for (const key of names.map((entry) => entry + "_NEW").concat("SSE_NEW")) assert.ok(result.includes(constants[key]), "Preserved patch: " + key);
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
