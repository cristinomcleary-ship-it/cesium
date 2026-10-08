// Stable recordings must not be interrupted by source-file watcher restarts.
// CESIUM_SAFETY_DATA_DIR must point to a dedicated test directory.
import config from "../vite.config.ts";

// Optional server-side guard also covers browser unload / keepalive requests.
// It never grants access or returns private record data, and is absent from normal startup.
const readonlyLibrary = { name: "acceptance-readonly-original-library", enforce: "pre", configureServer(server) {
  if (process.env.CESIUM_ACCEPTANCE_READONLY_LIBRARY !== "1") return;
  server.middlewares.use((request, response, next) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    if (!path.startsWith("/__library/") || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    request.resume(); response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "no-store");
    if (path === "/__library/view") { response.statusCode = 200; response.end(JSON.stringify({ ok: true, acceptanceOnly: true, persisted: false })); }
    else { response.statusCode = 409; response.end(JSON.stringify({ error: "实际画面验收以只读方式使用原资料库", code: "ACCEPTANCE_READONLY" })); }
  });
} };
export default { ...config, plugins: [readonlyLibrary, ...config.plugins], server: { ...config.server, hmr: false, watch: null } };
