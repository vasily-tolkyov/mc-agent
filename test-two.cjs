const path = require("path");
const REPO = path.resolve(__dirname, "..", "energy-network-sim");
const url = (p) => "file:///" + p.split(path.sep).join("/");
const { INTERACTIVE_PERCEPTION } = require("./perception-spec.cjs");
async function main() {
  const { JevApiBackend } = await import(url(path.join(REPO, "dist/src/perception/decision-backend.js")));
  const { SceneParser } = await import(url(path.join(REPO, "dist/src/perception/scene-parser.js")));
  const parser = new SceneParser(new JevApiBackend("https://api.typesafe.ai/v1/systemone", process.env.TYPESAFE_API_KEY));
  for (const text of ["放一块木板在石头上", "将金块放在石头上"]) {
    const got = await parser.parse(text, INTERACTIVE_PERCEPTION);
    console.log(`「${text}」→ frame=${JSON.stringify(got.frame)} unknown=${JSON.stringify(got.unknownDims)}`);
    console.log("   明细:", JSON.stringify(got.details));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
