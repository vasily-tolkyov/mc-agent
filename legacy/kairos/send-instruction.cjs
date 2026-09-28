/** 本地测量目标：node send-instruction.cjs "向前移动1米"；复杂任务使用 POST /goals。 */
const http = require("http");
const text = process.argv[2];
if (!text) { console.error("用法：node send-instruction.cjs <指令>"); process.exit(1); }
const body = Buffer.from(JSON.stringify({ text }), "utf8");
const req = http.request({ host: "127.0.0.1", port: 3008, path: "/instruct", method: "POST",
  headers: { "content-type": "application/json; charset=utf-8", "content-length": body.length } },
  (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { console.log(d); if (res.statusCode >= 400) process.exitCode = 1; }); });
req.setTimeout(10000, () => req.destroy(new Error("本地控制接口超时")));
req.on("error", (e) => { console.error("发送失败:", e.message); process.exit(1); });
req.write(body);
req.end();
