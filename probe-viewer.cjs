/** 旁路验证：以 socket.io 客户端连 3007，检查 version 事件与 loadChunk 数据流。 */
const { io } = require("socket.io-client");
const s = io("http://localhost:3007", { transports: ["websocket"] });
let chunks = 0, nonempty = 0, first = null;
s.on("version", (v) => console.log("version 事件:", v));
s.on("position", (p) => console.log("position 事件: pos=", JSON.stringify(p.pos), "yaw=", p.yaw?.toFixed?.(2), "pitch=", p.pitch?.toFixed?.(2)));
s.on("loadChunk", (e) => {
  chunks++;
  // chunk 是 column.toJson()：数一数非空气方块（递归找数字 id）
  let blocks = 0;
  const walk = (o) => {
    if (Array.isArray(o)) for (const v of o) walk(v);
    else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); // 递归进 section 对象
    else if (typeof o === "number" && o > 0) blocks++;
  };
  walk(e.chunk?.sections ?? e.chunk);
  if (blocks > 0) nonempty++;
  if (!first && blocks > 0) first = { x: e.x, z: e.z, blocks };
});
setTimeout(() => {
  console.log(`15s 内 loadChunk 事件 ${chunks} 个，其中含方块数据 ${nonempty} 个`, first ?? "");
  process.exit(0);
}, 15000);
s.on("connect_error", (e) => { console.error("连接失败:", e.message); process.exit(1); });
