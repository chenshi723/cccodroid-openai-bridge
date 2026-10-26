#!/usr/bin/env node
// 仅探测安装时选定的回环端口，完全不连接用户的远端 API。
const http = require("node:http");
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) process.exit(1);
let finished = false;
function finish(ok) {
  if (finished) return;
  finished = true;
  process.exitCode = ok ? 0 : 1;
  clearTimeout(deadline);
}
const request = http.get({ hostname: "127.0.0.1", port, path: "/health", agent: false }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (part) => {
    body += part;
    if (body.length > 16384) { request.destroy(); finish(false); }
  });
  response.on("end", () => {
    try { finish(response.statusCode === 200 && JSON.parse(body).status === "ok"); }
    catch { finish(false); }
  });
  response.on("error", () => finish(false));
});
const deadline = setTimeout(() => { request.destroy(); finish(false); }, 2000);
request.on("error", () => finish(false));
