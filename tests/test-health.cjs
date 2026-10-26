const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const probe = (port) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(__dirname, "../runtime/health.cjs"), String(port)], { stdio: "ignore" });
  child.on("error", reject);
  child.on("exit", resolve);
});

(async () => {
  let status = 200, body = '{"status":"ok"}', hang = false;
  const server = http.createServer((req, res) => { if (!hang) { res.writeHead(status); res.end(body); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal(await probe(port), 0);
    status = 503;
    assert.equal(await probe(port), 1);
    status = 200;
    body = '{"status":"bad"}';
    assert.equal(await probe(port), 1);
    body = 'not JSON';
    assert.equal(await probe(port), 1);
    body = 'x'.repeat(17000);
    assert.equal(await probe(port), 1);
    hang = true;
    assert.equal(await probe(port), 1);
    assert.equal(await probe(0), 1);
    assert.equal(await probe('https://api.example.com'), 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('PASS health: healthy, HTTP error, bad status, bad JSON, oversized, timeout, invalid port/URL');
})().catch((error) => { console.error(error); process.exitCode = 1; });
