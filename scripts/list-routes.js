/**
 * Dev tool: list all registered routes without connecting to the database.
 *   node scripts/list-routes.js
 */
process.env.NODE_ENV = "test";
const app = require("../index");

const routes = [];
const stack = app.router && app.router.stack;

const walk = (layer, base) => {
  if (!layer) return;
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
    routes.push(`${methods.padEnd(6)} ${base + layer.route.path}`);
  } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
    const prefix = layer.regexp ? base : base;
    layer.handle.stack.forEach((child) => {
      const childPath = child.route ? child.route.path : "";
      const full = prefix + (child.route ? "" : "") + (layer.handle.path || "");
      walk(child, prefix + (child.route ? child.route.path : ""));
    });
    layer.handle.stack.forEach((child) => {
      if (!child.route && child.handle && child.handle.stack) {
        child.handle.stack.forEach((sub) => {
          if (sub.route) {
            const methods = Object.keys(sub.route.methods).join(",").toUpperCase();
            routes.push(`${methods.padEnd(6)} ${full || ""}${sub.route.path}`);
          }
        });
      }
    });
  }
};

if (stack) {
  stack.forEach((layer) => {
    if (layer.name === "query" || layer.name === "expressInit") return;
    walk(layer, "");
  });
}

// Also print router-level mounts from the app's route list.
const list = app.router ? app.router.stack : [];
list.forEach((layer) => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
    routes.push(`${methods.padEnd(6)} ${layer.route.path}`);
  }
});

// Simpler approach: print mounted routers with their paths.
list.forEach((layer) => {
  if (layer.name === "router") {
    const path = layer.regexp && layer.regexp.source ? layer.regexp.source : "?";
    const inner = layer.handle.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods).join(",").toUpperCase()} ${l.route.path}`);
    routes.push(`[mount] ${path}`);
    inner.forEach((r) => routes.push(`        ${r}`));
  }
});

console.log("Registered routes:");
[...new Set(routes)].forEach((r) => console.log(r));
console.log("Total entries:", routes.length);
