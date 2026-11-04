const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const health = path.join(__dirname, "../runtime/health.cjs");
const LOG_LIMIT = 64 * 1024;
const secret = "DO_NOT_LOG_remote-secret-key-header-body-or-message";
const diagnosticPattern = /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] health ([A-Z][A-Z0-9_]*)\n$/;
const allowedCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "EACCES", "EPERM", "EPIPE", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "DEADLINE_2000MS", "BAD_JSON",
  "RESPONSE_ABORTED", "RESPONSE_TOO_LARGE", "HTTP_STATUS", "HEALTH_STATUS",
  "REQUEST_ERROR", "LOOPBACK_UNAVAILABLE", "INVALID_ARGUMENTS", "LOG_UNSUPPORTED", "LOG_UNSAFE_PATH",
  "LOG_UNSAFE_FILE", "LOG_TOO_LARGE", "LOG_LOCK_BUSY", "LOG_LOCK_FAILED", "LOG_IO_ERROR",
]);
let sandbox, home;
let simulatedHardlinks = 0;

function probe(port, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...(options.nodeArgs || []), health, String(port), ...args], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: "", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, elapsed: performance.now() - started });
    });
  });
}
function codes(result) {
  assert.equal(result.signal, null, `probe was killed: ${JSON.stringify(result)}`);
  assert.equal(result.stdout, "", "health must never emit stdout");
  assert.ok(!result.stderr.includes(secret), "sensitive remote/mock text leaked to stderr");
  const lines = result.stderr ? result.stderr.trimEnd().split("\n") : [];
  assert.ok(lines.length <= 2, "each probe must emit at most two bounded diagnostics");
  return lines.map((line) => {
    const match = diagnosticPattern.exec(`${line}\n`);
    assert.ok(match, `not a fixed timestamp/code diagnostic: ${line}`);
    assert.ok(allowedCodes.has(match[1]), `not an allowlisted code: ${match[1]}`);
    return match[1];
  });
}
function failed(result, expected) {
  assert.equal(result.code, 1);
  assert.deepEqual(codes(result), Array.isArray(expected) ? expected : [expected]);
}
function healthy(result) {
  assert.equal(result.code, 0);
  assert.deepEqual(codes(result), []);
}
async function withServer(handler, run, raw = false) {
  const sockets = new Set();
  const server = raw ? net.createServer(handler) : http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try { return await run(server.address().port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
function state(name) {
  const directory = path.join(sandbox, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function writePrivate(file, value = "") {
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function logLines(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile());
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o7777, 0o600);
  assert.ok(stat.size <= LOG_LIMIT);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(secret));
  return text;
}
function preload(name, source) {
  const file = path.join(sandbox, `${name}.cjs`);
  fs.writeFileSync(file, source, { mode: 0o600 });
  return ["--require", file];
}

(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-health-test-")));
  fs.chmodSync(sandbox, 0o700);
  home = state("isolated-home");
  try {
    let status = 200, body = '{"status":"ok"}', behavior = "normal", requests = 0;
    await withServer((req, res) => {
      requests++;
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/health");
      assert.match(req.headers.host, /^127\.0\.0\.1:\d+$/);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["x-api-key"], undefined);
      if (behavior === "reset") { req.socket.destroy(); return; }
      if (behavior === "header-hang") return;
      if (behavior === "split-deadline") {
        const headers = setTimeout(() => { res.writeHead(status); res.flushHeaders(); }, 1200);
        const complete = setTimeout(() => res.end('{"status":"ok"}'), 2400);
        res.once("close", () => { clearTimeout(headers); clearTimeout(complete); });
        return;
      }
      res.writeHead(status, { "X-Secret-Do-Not-Log": secret });
      if (behavior === "body-hang") { res.flushHeaders(); res.write("{"); return; }
      if (behavior === "trickle") {
        res.flushHeaders();
        const timer = setInterval(() => res.write(" "), 100);
        res.once("close", () => clearInterval(timer));
        return;
      }
      if (behavior === "response-abort") {
        res.write("{");
        const timer = setTimeout(() => res.destroy(), 40);
        res.once("close", () => clearTimeout(timer));
        return;
      }
      res.end(body);
    }, async (port) => {
      healthy(await probe(port));
      status = 503;
      body = JSON.stringify({ error: { message: secret, api_key: secret } });
      failed(await probe(port), "HTTP_STATUS");
      status = 200;
      body = '{"status":"bad"}';
      failed(await probe(port), "HEALTH_STATUS");
      body = JSON.stringify({ error: { message: secret } });
      failed(await probe(port), "HEALTH_STATUS");
      body = "null";
      failed(await probe(port), "HEALTH_STATUS");
      body = `${secret} not JSON`;
      failed(await probe(port), "BAD_JSON");
      body = '{"status":"ok"}' + " ".repeat(16384 - Buffer.byteLength('{"status":"ok"}'));
      healthy(await probe(port));
      body += " ";
      failed(await probe(port), "RESPONSE_TOO_LARGE");
      body = "界".repeat(6000); // UTF-8 >16KiB；字符数小于旧实现的错误限额。
      failed(await probe(port), "RESPONSE_TOO_LARGE");
      behavior = "reset";
      failed(await probe(port), "ECONNRESET");
      behavior = "response-abort";
      failed(await probe(port), "RESPONSE_ABORTED");
      for (const pending of ["header-hang", "body-hang", "trickle", "split-deadline"]) {
        behavior = pending;
        const result = await probe(port);
        failed(result, "DEADLINE_2000MS");
        assert.ok(result.elapsed >= 1900 && result.elapsed < 4500,
          `${pending} must have one absolute 2000ms deadline: ${result.elapsed}`);
      }
      behavior = "normal";
      body = '{"status":"ok"}';
      for (const invalid of ["0", "1023", "65536", "-1", "01024", "1e4", "0x1000", "2000.0",
        " 2000", "2000\n", `https://${secret}.example`, `127.0.0.1:${port}`]) {
        const before = requests;
        failed(await probe(invalid), "INVALID_ARGUMENTS");
        assert.equal(requests, before, "invalid port must not contact even the local fake service");
      }
      failed(await probe(port, ["--unknown", secret]), "INVALID_ARGUMENTS");
      failed(await probe(port, ["--log"]), "INVALID_ARGUMENTS");

      const normalLog = path.join(home, "health-errors.log");
      healthy(await probe(port, ["--log", normalLog]));
      assert.equal(fs.existsSync(normalLog), false, "successful health must not create a log");
      assert.equal(fs.existsSync(`${normalLog}.lock`), false);
      healthy(await probe(port, ["--log", path.join(sandbox, "missing", "health-errors.log")]));
    });

    await withServer((socket) => {
      socket.once("data", () => socket.write(`HTTP/1.1 200 OK\r\nX-Pad: ${"x".repeat(17000)}\r\n\r\n`));
    }, async (port) => failed(await probe(port), "RESPONSE_TOO_LARGE"), true);
    await withServer((socket) => {
      // 合法 status JSON 但 HTTP 正文截断，不能误判健康。
      socket.once("data", () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n{"status":"ok"}'));
    }, async (port) => failed(await probe(port), "RESPONSE_ABORTED"), true);
    await withServer((req, res) => {
      // 非 200 响应无需等远端/本地正文结束，立即固定 HTTP_STATUS 失败。
      res.writeHead(503);
      res.flushHeaders();
      res.write(secret);
    }, async (port) => {
      const result = await probe(port);
      failed(result, "HTTP_STATUS");
      assert.ok(result.elapsed < 1900);
    });

    // 用刚关闭的假服务端口复现 ECONNREFUSED，不访问真实实例/凭据。
    let refusedPort;
    await withServer((req, res) => res.end(), async (port) => { refusedPort = port; });
    failed(await probe(refusedPort), "ECONNREFUSED");

    // Android/同 uid 下 chmod 未必能稳定产生 EACCES，预加载仅注入子进程的假 http。
    const denied = preload("denied", `
      const http = require('node:http');
      http.get = () => {
        const req = new (require('node:events').EventEmitter)();
        req.destroy = () => {};
        process.nextTick(() => { for (let i = 0; i < 10; i++) req.emit('error', Object.assign(new Error(${JSON.stringify(secret)}), { code: 'EACCES' })); });
        return req;
      };
    `);
    failed(await probe(1024, [], { nodeArgs: denied }), "EACCES");
    // 单独服务失败不能冒充系统回环故障；独立随机端口对照仍须成功。
    failed(await probe(1024, ["--diagnose"], { nodeArgs: denied }), "EACCES");
    const transportDenied = preload("transport-denied", `
      const net=require('node:net');
      net.connect=()=>{
        const socket=new(require('node:events').EventEmitter)();socket.destroy=()=>{};
        process.nextTick(()=>socket.emit('error',Object.assign(new Error(${JSON.stringify(secret)}),{code:'EACCES'})));
        return socket;
      };
    `);
    const unavailable = await probe(1024, ["--diagnose"], { nodeArgs: [...denied, ...transportDenied] });
    assert.equal(unavailable.code, 2);assert.deepEqual(codes(unavailable), ["LOOPBACK_UNAVAILABLE"]);
    const controlTimeout = preload("control-timeout", `
      require('node:net').connect=()=>{const socket=new(require('node:events').EventEmitter)();socket.destroy=()=>{};return socket;};
    `);
    const unavailableTimeout=await probe(1024,["--diagnose"],{nodeArgs:[...denied,...controlTimeout]});
    assert.equal(unavailableTimeout.code,2);assert.deepEqual(codes(unavailableTimeout),["LOOPBACK_UNAVAILABLE"]);
    assert.ok(unavailableTimeout.elapsed>=1900&&unavailableTimeout.elapsed<4500);
    const unavailableLog=path.join(state('transport-log'),'health.log');
    const loggedUnavailable=await probe(1024,["--log",unavailableLog,"--diagnose"],{nodeArgs:[...denied,...transportDenied]});
    assert.equal(loggedUnavailable.code,2);assert.deepEqual(codes(loggedUnavailable),[]);
    assert.match(logLines(unavailableLog),/health LOOPBACK_UNAVAILABLE\n$/);
    const noListener = preload("cannot-create-control", `
      const net=require('node:net'),original=net.createServer;
      net.createServer=(...args)=>{const server=original(...args);server.listen=()=>{process.nextTick(()=>server.emit('error',{code:'EMFILE'}));return server;};return server;};
    `);
    failed(await probe(1024, ["--diagnose"], { nodeArgs: [...denied, ...noListener] }), "EACCES");
    await withServer((req,res)=>{},async port=>{
      const result=await probe(port,["--diagnose"]);failed(result,"DEADLINE_2000MS");
      assert.ok(result.elapsed<5000,'responsive local control must not mask a hung bridge');
    });
    const unknownError = preload("unknown-error", `
      require('node:http').get = () => { throw Object.assign(new Error(${JSON.stringify(secret)}), { code: ${JSON.stringify(secret)} }); };
    `);
    failed(await probe(1024, [], { nodeArgs: unknownError }), "REQUEST_ERROR");
    const fixedFailure = preload("fixed-failure", `
      require('node:http').get = () => { throw Object.assign(new Error(${JSON.stringify(secret)}), { code: 'ECONNREFUSED' }); };
    `);
    const failLog = (file, expected = []) =>
      probe(1024, ["--log", file], { nodeArgs: fixedFailure }).then((result) => {
        failed(result, expected);
        return result;
      });

    const logDir = state("valid-state");
    const log = path.join(logDir, "health-errors.log");
    await failLog(log);
    let text = logLines(log);
    assert.equal(text.split("\n").length - 1, 1);
    assert.match(text, diagnosticPattern);
    assert.equal(fs.statSync(`${log}.lock`).size, 0);
    assert.equal(fs.statSync(`${log}.lock`).mode & 0o7777, 0o600);
    await failLog(log);
    assert.equal(logLines(log).split("\n").length - 1, 2);

    // umask 不得让新建 current/lock 变成非 0600，既存错误权限则拒绝而不是 chmod。
    const strictUmask = preload("strict-umask", "process.umask(0o777);" );
    const umaskLog = path.join(state("umask-state"), "health-errors.log");
    failed(await probe(1024, ["--log", umaskLog], { nodeArgs: [...strictUmask, ...fixedFailure] }), []);
    logLines(umaskLog);
    assert.equal(fs.statSync(`${umaskLog}.lock`).mode & 0o7777, 0o600);

    const badParent = state("bad-parent");
    fs.chmodSync(badParent, 0o755);
    await failLog(path.join(badParent, "health-errors.log"), ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    assert.deepEqual(fs.readdirSync(badParent), []);
    await failLog("relative-health.log", ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    await failLog(path.join(sandbox, "missing", "health-errors.log"), ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    await failLog(`${logDir}/../valid-state/health-errors.log`, ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    await failLog(`${logDir}//health-errors.log`, ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);

    const linkParent = path.join(sandbox, "linked-state");
    fs.symlinkSync(logDir, linkParent);
    const beforeParentLink = fs.readFileSync(log);
    await failLog(path.join(linkParent, "health-errors.log"), ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    assert.deepEqual(fs.readFileSync(log), beforeParentLink);
    const outerLink = path.join(sandbox, "outer-link");
    fs.symlinkSync(sandbox, outerLink);
    await failLog(path.join(outerLink, "valid-state", "health-errors.log"), ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);

    // Android SELinux 若禁止创建硬链接，仅该反例以子进程内 nlink=2 注入覆盖。
    const hardlinkModel = preload("hardlink-model", `
      const fs = require('node:fs');
      for (const key of ['fstatSync', 'lstatSync']) {
        const original = fs[key];
        fs[key] = (...args) => { const stat = original(...args); if (stat.isFile()) stat.nlink = 2; return stat; };
      }
    `);
    // current、backup、lock 均测试符号/硬链接，所有受害文件内容与权限保持原样。
    for (const suffix of ["", ".1", ".lock"]) {
      for (const kind of ["symlink", "hardlink", "wide-mode", "directory"]) {
        const directory = state(`unsafe-${suffix || "current"}-${kind}`);
        const file = path.join(directory, "health-errors.log");
        const victim = path.join(sandbox, `victim-${suffix || "current"}-${kind}`);
        writePrivate(victim, secret);
        let simulateHardlink = false;
        if (kind === "symlink") fs.symlinkSync(victim, `${file}${suffix}`);
        if (kind === "hardlink") {
          try { fs.linkSync(victim, `${file}${suffix}`); }
          catch (error) {
            if (!["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) throw error;
            writePrivate(`${file}${suffix}`, suffix === ".lock" ? "" : secret);
            simulateHardlink = true;
            simulatedHardlinks++;
          }
        }
        if (kind === "wide-mode") {
          writePrivate(`${file}${suffix}`, suffix === ".lock" ? "" : "unchanged");
          fs.chmodSync(`${file}${suffix}`, 0o644);
        }
        if (kind === "directory") fs.mkdirSync(`${file}${suffix}`, { mode: 0o700 });
        const initial = fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file) : undefined;
        if (simulateHardlink) {
          failed(await probe(1024, ["--log", file], { nodeArgs: [...hardlinkModel, ...fixedFailure] }),
            ["ECONNREFUSED", "LOG_UNSAFE_FILE"]);
        } else {
          await failLog(file, ["ECONNREFUSED", "LOG_UNSAFE_FILE"]);
        }
        assert.equal(fs.readFileSync(victim, "utf8"), secret);
        assert.equal(fs.statSync(victim).mode & 0o7777, 0o600);
        if (kind === "wide-mode") assert.equal(fs.statSync(`${file}${suffix}`).mode & 0o7777, 0o644);
        if (initial) assert.deepEqual(fs.readFileSync(file), initial);
      }
    }
    for (const suffix of ["", ".1", ".lock"]) {
      const directory = state(`fifo-${suffix || "current"}`);
      const file = path.join(directory, "health-errors.log");
      const made = spawnSync("mkfifo", ["-m", "600", `${file}${suffix}`]);
      assert.equal(made.status, 0, "test platform must support temporary FIFO fixtures");
      await failLog(file, ["ECONNREFUSED", "LOG_UNSAFE_FILE"]);
    }
    // 无需改真实 uid：只在假子进程内让 fstat/lstat 返回不同 owner，覆盖 fail-closed 分支。
    const wrongOwner = preload("wrong-owner", `
      const fs = require('node:fs');
      for (const key of ['fstatSync', 'lstatSync']) {
        const original = fs[key];
        fs[key] = (...args) => { const stat = original(...args); stat.uid += 1; return stat; };
      }
    `);
    const ownerDir = state("owner-state");
    failed(await probe(1024, ["--log", path.join(ownerDir, "health-errors.log")], {
      nodeArgs: [...wrongOwner, ...fixedFailure],
    }), ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    assert.deepEqual(fs.readdirSync(ownerDir), []);
    const wrongFileOwner = preload("wrong-file-owner", `
      const fs = require('node:fs');
      for (const key of ['fstatSync', 'lstatSync']) {
        const original = fs[key];
        fs[key] = (...args) => { const stat = original(...args); if (stat.isFile()) stat.uid += 1; return stat; };
      }
    `);
    const ownerFileDir = state("owner-file-state");
    failed(await probe(1024, ["--log", path.join(ownerFileDir, "health-errors.log")], {
      nodeArgs: [...wrongFileOwner, ...fixedFailure],
    }), ["ECONNREFUSED", "LOG_UNSAFE_FILE"]);

    // lstat/open 窗口内若 current/父目录被换成链接，NOFOLLOW 拒绝且不写到受害文件。
    const raceDir = state("race-state"), raceLog = path.join(raceDir, "health-errors.log");
    const raceVictim = path.join(sandbox, "race-victim");
    writePrivate(raceLog, "original");
    writePrivate(raceVictim, secret);
    const fileSwap = preload("file-swap", `
      const fs = require('node:fs'), open = fs.openSync;
      let swapped = false;
      fs.openSync = (file, flags, ...args) => {
        if (!swapped && typeof file === 'string' && file.endsWith('/health-errors.log')) {
          swapped = true;
          fs.unlinkSync(${JSON.stringify(raceLog)});
          fs.symlinkSync(${JSON.stringify(raceVictim)}, ${JSON.stringify(raceLog)});
        }
        return open(file, flags, ...args);
      };
    `);
    failed(await probe(1024, ["--log", raceLog], { nodeArgs: [...fileSwap, ...fixedFailure] }),
      ["ECONNREFUSED", "LOG_IO_ERROR"]);
    assert.equal(fs.readFileSync(raceVictim, "utf8"), secret);
    const parentRace = state("parent-race"), parentRaceLog = path.join(parentRace, "health-errors.log");
    const parentRaceOld = `${parentRace}-old`, alternate = state("parent-alternate");
    const parentSwap = preload("parent-swap", `
      const fs = require('node:fs'), open = fs.openSync;
      let swapped = false;
      fs.openSync = (file, flags, ...args) => {
        if (!swapped && typeof file === 'string' && file.endsWith('/parent-race')) {
          swapped = true;
          fs.renameSync(${JSON.stringify(parentRace)}, ${JSON.stringify(parentRaceOld)});
          fs.symlinkSync(${JSON.stringify(alternate)}, ${JSON.stringify(parentRace)});
        }
        return open(file, flags, ...args);
      };
    `);
    failed(await probe(1024, ["--log", parentRaceLog], { nodeArgs: [...parentSwap, ...fixedFailure] }),
      ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    assert.deepEqual(fs.readdirSync(alternate), []);
    assert.deepEqual(fs.readdirSync(parentRaceOld), []);
    // 反过来：STATE 已打开后路径被移走/替换，后续操作仍锚定原目录 fd。
    const anchorDir = state("anchor-state"), anchorOld = `${anchorDir}-old`, anchorAlternate = state("anchor-alternate");
    const anchorLog = path.join(anchorDir, "health-errors.log");
    const anchoredSwap = preload("anchored-swap", `
      const fs = require('node:fs'), open = fs.openSync;
      let swapped = false;
      fs.openSync = (file, flags, ...args) => {
        if (!swapped && typeof file === 'string' && file.endsWith('/health-errors.log.lock')) {
          swapped = true;
          fs.renameSync(${JSON.stringify(anchorDir)}, ${JSON.stringify(anchorOld)});
          fs.symlinkSync(${JSON.stringify(anchorAlternate)}, ${JSON.stringify(anchorDir)});
        }
        return open(file, flags, ...args);
      };
    `);
    failed(await probe(1024, ["--log", anchorLog], { nodeArgs: [...anchoredSwap, ...fixedFailure] }), []);
    assert.match(logLines(path.join(anchorOld, "health-errors.log")), diagnosticPattern);
    assert.deepEqual(fs.readdirSync(anchorAlternate), []);

    // 超限已有文件不读取/扩写/截断，拒绝并报告固定码；lock 必须始终零字节。
    for (const suffix of ["", ".1", ".lock"]) {
      const directory = state(`oversized-${suffix || "current"}`);
      const file = path.join(directory, "health-errors.log");
      const contents = suffix === ".lock" ? "x" : "x".repeat(LOG_LIMIT + 1);
      writePrivate(`${file}${suffix}`, contents);
      await failLog(file, ["ECONNREFUSED", "LOG_TOO_LARGE"]);
      assert.equal(fs.readFileSync(`${file}${suffix}`, "utf8"), contents);
    }

    // 确定性轮换：backup 原子替换，只保留 current + .1 + 零字节 .lock。
    writePrivate(log, "a".repeat(LOG_LIMIT));
    writePrivate(`${log}.1`, "previous backup");
    const inodeBefore = fs.statSync(log).ino;
    await failLog(log);
    assert.equal(logLines(`${log}.1`), "a".repeat(LOG_LIMIT));
    assert.equal(fs.statSync(`${log}.1`).ino, inodeBefore);
    assert.match(logLines(log), diagnosticPattern);
    writePrivate(log, "b".repeat(LOG_LIMIT));
    await failLog(log);
    assert.equal(logLines(`${log}.1`), "b".repeat(LOG_LIMIT));
    assert.deepEqual(fs.readdirSync(logDir).sort(), ["health-errors.log", "health-errors.log.1", "health-errors.log.lock"]);

    // 多进程竞争恰逢轮换：每条记录完整、不覆盖/丢失，且最终两份都在预算内。
    writePrivate(log, "x".repeat(LOG_LIMIT - 100));
    const workers = 20;
    const parallel = await Promise.all(Array.from({ length: workers }, () =>
      probe(1024, ["--log", log], { nodeArgs: fixedFailure })));
    for (const result of parallel) failed(result, []);
    text = logLines(log) + logLines(`${log}.1`);
    const records = text.match(/\[\d{4}-[^\n]+\] health ECONNREFUSED\n/g) || [];
    assert.equal(records.length, workers, "concurrent append/rotation lost a record");
    assert.equal(text.replace(/^x+/, "").replace(/x+/g, "").split("\n").filter(Boolean).length, workers);
    assert.deepEqual(fs.readdirSync(logDir).sort(), ["health-errors.log", "health-errors.log.1", "health-errors.log.lock"]);

    // 真实持锁者阻止并发写；锁竞争有界并输出 LOG_LOCK_BUSY，不产生陈旧锁。
    const holder = spawn("flock", ["-F", `${log}.lock`, process.execPath, "-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let heldPid;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("flock fixture failed to become ready")), 4000);
        holder.once("error", (error) => { clearTimeout(timer); reject(error); });
        holder.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      });
      // flock -F 直接 exec 假持锁进程，终止它即可释放锁，不遗留孙进程。
      heldPid = holder.pid;
      const before = fs.readFileSync(log);
      const busy = await failLog(log, ["ECONNREFUSED", "LOG_LOCK_BUSY"]);
      assert.ok(busy.elapsed < 3500);
      assert.deepEqual(fs.readFileSync(log), before);
    } finally {
      holder.kill("SIGTERM");
      if (holder.exitCode === null && holder.signalCode === null) await new Promise((resolve) => holder.once("close", resolve));
    }
    assert.ok(heldPid);
    await failLog(log); // 持锁者退出即释放，未删除/重建 lock inode。
    const noFlock = path.join(state("empty-path"), "health-errors.log");
    failed(await probe(1024, ["--log", noFlock], { nodeArgs: fixedFailure, env: { PATH: path.dirname(noFlock) } }),
      ["ECONNREFUSED", "LOG_LOCK_FAILED"]);
    assert.equal(fs.existsSync(noFlock), false);
    // 真实 shell 调用：常规失败只落有界日志；日志路径不安全时固定诊断只报一次，不再被 2>/dev/null 吞掉。
    const shellRoot = state("shell-runtime");
    fs.copyFileSync(path.join(__dirname, "../runtime/bridge-common.sh"), path.join(shellRoot, "bridge-common.sh"));
    fs.copyFileSync(health, path.join(shellRoot, "health.cjs"));
    fs.writeFileSync(path.join(shellRoot, "port"), "1024\n");
    const shellState = path.join(shellRoot, "runtime-home/.claude-code-router");
    fs.mkdirSync(shellState, { recursive: true, mode: 0o700 }); fs.chmodSync(shellState, 0o700);
    const shell = 'source "$1/bridge-common.sh"; bridge_pid() { return 0; }; for i in 1 2 3; do bridge_healthy && exit 9; done';
    const shellRun = () => spawn("bash", ["-c", shell, "fixture", shellRoot], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: "--require=" + fixedFailure[1] }, stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (child) => new Promise((resolve, reject) => {
      let stdout = "", stderr = ""; child.stdout.on("data", part => stdout += part); child.stderr.on("data", part => stderr += part);
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    let shellResult = await collect(shellRun());
    assert.equal(shellResult.code, 1); assert.equal(shellResult.stdout, ""); assert.equal(shellResult.stderr, "");
    assert.equal(logLines(path.join(shellState, "health.log")).split("\n").length - 1, 3);
    fs.chmodSync(shellState, 0o755);
    shellResult = await collect(shellRun());
    assert.equal(shellResult.code, 1);
    assert.deepEqual(codes(shellResult), ["ECONNREFUSED", "LOG_UNSAFE_PATH"]);
    assert.deepEqual(fs.readdirSync(home), [], "isolated HOME must remain free of credentials/config mutations");
    console.log(`PASS health: fixed safe diagnostics, loopback/port/16KiB bounds, absolute deadlines, response failures, secure bounded 0600 logs, links/permissions/size/rotation/concurrency; simulated hardlink fixtures=${simulatedHardlinks}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
