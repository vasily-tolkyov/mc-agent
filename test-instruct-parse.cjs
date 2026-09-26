/** 交互指令面板的 Jev 规格快测：三条代表性指令的解析结果（不进 MC）。 */
const path = require("path");
const REPO = path.resolve(__dirname, "..", "energy-network-sim");
const url = (p) => "file:///" + p.replace(/\\/g, "/");
const { INTERACTIVE_PERCEPTION } = require("./perception-spec.cjs");

async function main() {
  const { JevApiBackend } = await import(url(path.join(REPO, "dist/src/perception/decision-backend.js")));
  const { SceneParser } = await import(url(path.join(REPO, "dist/src/perception/scene-parser.js")));
  const parser = new SceneParser(new JevApiBackend("https://api.typesafe.ai/v1/systemone", process.env.TYPESAFE_API_KEY));
  for (const text of ["把箱子摞起来，摞两层", "去拿一个箱子", "走到最右边", "把堆垛清空"]) {
    const got = await parser.parse(text, INTERACTIVE_PERCEPTION);
    console.log(`「${text}」→ frame=${JSON.stringify(got.frame)} unknown=${JSON.stringify(got.unknownDims)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
