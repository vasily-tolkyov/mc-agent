/** Compatibility entry: native Minecraft display and current Kairos core. Historical source is in legacy/. */
const { pathToFileURL } = require('node:url');
const path = require('node:path');
import(pathToFileURL(path.join(__dirname, 'local-agent.mjs')).href)
  .then(({ runLocalAgent }) => runLocalAgent())
  .catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
