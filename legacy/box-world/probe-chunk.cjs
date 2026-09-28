/** 抓取一个 loadChunk 的完整 JSON 结构看数据布局。 */
const { io } = require("socket.io-client");
const fs = require("fs");
const s = io("http://localhost:3007", { transports: ["websocket"] });
let done = false;
s.on("loadChunk", (e) => {
  if (done) return;
  done = true;
  const json = JSON.stringify(e.chunk);
  console.log("chunk 顶层键:", Object.keys(e.chunk ?? {}));
  console.log("大小:", json.length, "字节");
  console.log("片段:", json.slice(0, 600));
  fs.writeFileSync("chunk-sample.json", json);
  process.exit(0);
});
s.on("connect_error", (e) => { console.error("连接失败:", e.message); process.exit(1); });
setTimeout(() => { console.error("10s 没等到 loadChunk"); process.exit(1); }, 10000);
