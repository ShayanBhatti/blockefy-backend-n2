/**
 * Dev tool: list every registered Express route as `METHOD <full path>`.
 *
 *   node scripts/list-routes.js
 *
 * Walks the router stack recursively, accumulating each mount prefix. The
 * previous version mixed two different traversal styles and printed phantom
 * concatenated paths such as `/contract/status/contract/status`, which looked
 * like a double-mounted router but was purely a bug in this script.
 */
process.env.NODE_ENV = "test";
const app = require("../index");

const rows = [];

/** Recursively collect `METHOD path` for every route under `prefix`. */
function walk(stack, prefix) {
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      for (const method of Object.keys(layer.route.methods || {})) {
        rows.push(`${method.toUpperCase().padEnd(7)}${path}`);
      }
      continue;
    }
    // Mounted middleware/router: `layer.regexp` encodes the mount path.
    if (layer.name === "router" && layer.handle && layer.handle.stack) {
      const mountPath = decodeMountPath(layer.regexp && layer.regexp.source);
      walk(layer.handle.stack, prefix + mountPath);
    }
  }
}

/** Turns an Express layer regexp back into its mount path, e.g. /^\/api\/?/. */
function decodeMountPath(source) {
  if (!source) return "";
  if (source === "^\\/?(?=\\/|$)") return "/";
  const m = source.match(/^\^\\\/?((?:[\w\-\/]|\\\/)*)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) return "";
  return "/" + m[1].replace(/\\\//g, "/").replace(/\/$/, "");
}

walk(app.router && app.router.stack, "");

rows.sort((a, b) => a.slice(8).localeCompare(b.slice(8)) || a.localeCompare(b));
console.log("Registered routes:\n");
for (const r of rows) console.log("  " + r);
console.log(`\nTotal: ${rows.length}`);

const chainRoutes = rows.filter((r) => /\/contract|\/escrow|onchain/i.test(r));
if (chainRoutes.length) {
  console.log("\nBlockchain routes:\n");
  for (const r of chainRoutes) console.log("  " + r);
}