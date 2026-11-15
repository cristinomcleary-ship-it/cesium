import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { createManagementStore, managementPlugin, type ManagementStoreOptions } from "../managementStore.ts";

const password = "Isolated-Security-Fixture-2026", projectId = "safety:project";
async function fixture(options: ManagementStoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "cesium-request-security-"));
  const store = createManagementStore({ dataDir: root, libraryDataDir: root, ...options });
  const entered = new Map<string, () => void>();
  const closed = new Map<string, () => void>();
  const server = createServer((req, res) => {
    void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.end("protected handler"); }));
    const key = String(req.headers["x-test-request"] || "");
    entered.get(key)?.();
    req.once("close", () => closed.get(key)?.());
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") => fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-cesium-library": "1", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bootstrap = () => call("/__management/commands", {
    type: "member.save", projectId, idempotencyKey: "bootstrap",
    payload: { username: "owner", displayName: "Owner", password, roles: ["owner"] },
  });
  const upload = (data: string, cookie = "") => fetch(base + "/__management/uploads?name=synthetic.txt", {
    method: "POST", headers: { "content-type": "text/plain", "x-cesium-library": "1", cookie }, body: data,
  });
  return { root, store, server, base, call, bootstrap, upload, entered, closed,
    files: () => { try { return readdirSync(join(root, "management-files")); } catch { return []; } },
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("real HTTP login limit starts a fresh enforced window after expiry and normalizes usernames", async t => {
  const f = await fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    assert.equal((await f.bootstrap()).status, 200);
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 10; i++) {
        const response = await f.call("/__management/session", { username: i % 2 ? " OWNER " : "owner", password: "wrong-password" });
        assert.equal(response.status, 401, `failure ${i + 1} in window ${window}`); await response.text();
      }
      const denied = await f.call("/__management/session", { username: "owner", password });
      assert.equal(denied.status, 429); assert.equal((await denied.json() as { code: string }).code, "LOGIN_RATE_LIMIT");
      now += 300_001;
    }
    const accepted = await f.call("/__management/session", { username: "owner", password });
    assert.equal(accepted.status, 200); await accepted.text();
    const malformed = await f.call("/__management/session", { username: "x".repeat(81), password });
    assert.equal(malformed.status, 400); await malformed.text();
    const remaining = await f.call("/__management/session", { username: "owner", password: "wrong-password" });
    assert.equal(remaining.status, 401); await remaining.text();
  } finally { await f.close(); }
});

test("HTTP cookies remain usable by default and explicit trusted configuration secures login and logout", async () => {
  const previous = process.env.CESIUM_COOKIE_SECURE;
  delete process.env.CESIUM_COOKIE_SECURE;
  try {
    for (const secure of [false, true]) {
      const f = await fixture(secure ? { cookieSecure: true } : {});
      try {
        const setup = await f.bootstrap(); assert.equal(setup.status, 200);
        const initial = setup.headers.get("set-cookie")!; await setup.text();
        assert.equal(initial.includes("; Secure"), secure);
        const login = await f.call("/__management/session", { username: "owner", password }, { "x-forwarded-proto": secure ? "http" : "https" });
        assert.equal(login.status, 200);
        const session = login.headers.get("set-cookie")!; await login.text();
        assert.match(session, /HttpOnly; SameSite=Strict/); assert.equal(session.includes("; Secure"), secure);
        const logout = await f.call("/__management/session", undefined, { cookie: session.split(";")[0] }, "DELETE");
        assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
        assert.equal(logout.headers.get("set-cookie")!.includes("; Secure"), secure); await logout.text();
      } finally { await f.close(); }
    }
    process.env.CESIUM_COOKIE_SECURE = "true";
    const f = await fixture();
    try { const response = await f.bootstrap(); assert.equal(response.headers.get("set-cookie")!.includes("; Secure"), true); await response.text(); }
    finally { await f.close(); }
    const overridden = await fixture({ cookieSecure: false });
    try { const response = await overridden.bootstrap(); assert.equal(response.headers.get("set-cookie")!.includes("; Secure"), false); await response.text(); }
    finally { await overridden.close(); }
  } finally {
    if (previous === undefined) delete process.env.CESIUM_COOKIE_SECURE;
    else process.env.CESIUM_COOKIE_SECURE = previous;
  }
});

test("real Vite static files cannot expose private caches, including encoded paths and authenticated owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-private-static-"));
  const cwd = process.cwd();
  const data = join(root, "project-data");
  const privateRoots = [".model-cache", ".cad-cache", ".local-imagery-cache", ".render-errors", ".basemap-cache", "private-assets", "private-asset-audit", "docs/temporary-works-upgrade/private", "tools/sketchup-sdk", "tools/NavisworksBridge/bin", "video_ar_backend/.venv", "video_ar_backend/data", "video_ar_backend/tools/COLMAP", "video_ar_backend/tools/FFmpeg", "ar_v2/.venv"];
  const privateFiles = ["model-converters.json", ".env", ".env.local", "video_ar_backend/.env", "video_ar_backend/dji_extractor_launcher.log", "acad.err", "docs/temporary-works-upgrade/assets-fixture.json", "video_ar_backend/tools/fixture.zip"];
  for (const name of privateRoots) {
    mkdirSync(join(root, name), { recursive: true }); writeFileSync(join(root, name, "synthetic.txt"), "PRIVATE_SYNTHETIC_CACHE");
  }
  for (const name of privateFiles) writeFileSync(join(root, name), "PRIVATE_SYNTHETIC_CONFIG");
  writeFileSync(join(root, "public-fixture.txt"), "PUBLIC_SYNTHETIC_ASSET");
  mkdirSync(join(root, "public/models"), { recursive: true }); writeFileSync(join(root, "public/models/fixture.glb"), "PUBLIC_SYNTHETIC_MODEL");
  const server = await createViteServer({ root, configFile: false, logLevel: "silent", appType: "custom",
    plugins: [managementPlugin({ dataDir: data, libraryDataDir: data })],
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  });
  try {
    process.chdir(root); // Exercise the real /@fs/<cwd>/src allowlist against this isolated root.
    await server.listen(); const base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    const setup = await fetch(base + "/__management/commands", { method: "POST", headers: { "content-type": "application/json", "x-cesium-library": "1" }, body: JSON.stringify({ type: "member.save", projectId, idempotencyKey: "bootstrap", payload: { username: "owner", displayName: "Owner", password, roles: ["owner"] } }) });
    assert.equal(setup.status, 200); const cookie = setup.headers.get("set-cookie")!.split(";")[0]; await setup.text();
    const controlled = await fetch(base + "/__models/files/job/model.glb"); assert.equal(controlled.status, 401); await controlled.text();
    for (const path of [...privateRoots.map(name => `/${name}/synthetic.txt`), ...privateFiles.map(name => `/${name}`), "/%2emodel-cache%2fsynthetic.txt", "/%252emodel-cache%252fsynthetic.txt", "/.model-cache", "/.model-cache/synthetic.txt?raw", `/@fs/${root}/.model-cache/synthetic.txt`, `/@fs/${root}/src/%2e%2e%2f.model-cache/synthetic.txt`, "/src/%2e%2e%2f.model-cache/synthetic.txt"]) {
      for (const headers of [{}, { cookie }]) {
        const response = await fetch(base + path, { headers });
        assert.equal(response.status, 403, path); assert.equal((await response.json() as { code: string }).code, "RAW_STORAGE_FORBIDDEN");
      }
    }
    const publicFile = await fetch(base + "/public-fixture.txt"); assert.equal(publicFile.status, 200); assert.equal(await publicFile.text(), "PUBLIC_SYNTHETIC_ASSET");
    const publicModel = await fetch(base + "/models/fixture.glb"); assert.equal(publicModel.status, 200); assert.equal(await publicModel.text(), "PUBLIC_SYNTHETIC_MODEL");
  } finally { process.chdir(cwd); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("diagnostic writes require a current reader and diagnostic reads require admin", async () => {
  const f = await fixture();
  try {
    const setup = await f.bootstrap(); const ownerCookie = setup.headers.get("set-cookie")!.split(";")[0]; await setup.text();
    let r = await f.call("/__diagnostics/render-error", {}); assert.equal(r.status, 401); await r.text();
    r = await f.call("/__diagnostics/render-error", {}, { cookie: ownerCookie, origin: "https://untrusted.example" }); assert.equal(r.status, 403); await r.text();
    r = await f.call("/__management/commands", { type: "member.save", projectId, idempotencyKey: "viewer", payload: { username: "viewer", displayName: "Reader", password, roles: ["viewer"], taskIds: [] } }, { cookie: ownerCookie });
    assert.equal(r.status, 200); await r.text();
    r = await f.call("/__management/session", { username: "viewer", password }); assert.equal(r.status, 200); const viewerCookie = r.headers.get("set-cookie")!.split(";")[0]; await r.text();
    r = await f.call("/__diagnostics/render-error", {}, { cookie: viewerCookie }); assert.equal(r.status, 200); assert.equal(await r.text(), "protected handler");
    r = await f.call("/__diagnostics/render-error/latest", undefined, { cookie: viewerCookie }); assert.equal(r.status, 403); await r.text();
    r = await f.call("/__diagnostics/render-error/latest", undefined, { cookie: ownerCookie }); assert.equal(r.status, 200); await r.text();
  } finally { await f.close(); }
});

test("HTTP upload memory rejection and aborted streams free budget without leaving files", async () => {
  const f = await fixture({ uploadBudget: { maxConcurrent: 1, maxBufferedBytes: 32 } });
  try {
    let response = await f.upload("x".repeat(17)); assert.equal(response.status, 429); assert.equal((await response.json() as { code: string }).code, "UPLOAD_MEMORY_LIMIT"); assert.deepEqual(f.files(), []);
    let enter!: () => void, close!: () => void;
    const started = new Promise<void>(done => { enter = done; }), disconnected = new Promise<void>(done => { close = done; });
    f.entered.set("partial", enter); f.closed.set("partial", close);
    const partial = httpRequest(f.base + "/__management/uploads?name=partial.txt", { method: "POST", headers: { "content-type": "text/plain", "x-cesium-library": "1", "x-test-request": "partial" } });
    partial.on("error", () => {}); partial.write("partial"); await started;
    response = await f.upload("valid"); assert.equal(response.status, 429); assert.equal((await response.json() as { code: string }).code, "UPLOAD_BUSY");
    partial.destroy(); await disconnected; await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(f.files(), []);
    response = await f.upload("valid"); assert.equal(response.status, 201); const record = await response.json() as { id: string; size: number };
    assert.equal(record.size, 5); assert.deepEqual(f.files(), [record.id]);
  } finally { await f.close(); }
});

test("disconnect while an upload waits for metadata commit releases its bytes and slot before the queue unblocks", async () => {
  let unblock!: () => void, announce!: () => void;
  const gate = new Promise<void>(done => { unblock = done; });
  const entered = new Promise<void>(done => { announce = done; });
  const f = await fixture({ uploadBudget: { maxConcurrent: 1, maxBufferedBytes: 32 },
    resolveLibraryEvidence: async () => { announce(); await gate; return undefined; },
  });
  const blocker = f.store.command({ type: "evidence.register", projectId, idempotencyKey: "queue-blocker", payload: { recordId: "synthetic", fileKey: "source" } }, f.store.localActor()).catch(error => error);
  try {
    await entered;
    let responseClosed!: () => void;
    const closed = new Promise<void>(done => { responseClosed = done; });
    f.server.once("request", (_req, res) => res.once("close", responseClosed));
    const pending = httpRequest(f.base + "/__management/uploads?name=queued.txt", { method: "POST", headers: { "content-type": "text/plain", "x-cesium-library": "1" } });
    pending.on("error", () => {}); pending.end("queued");
    const deadline = Date.now() + 3000;
    while (!f.files().length && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    assert.equal(f.files().length, 1, "completed bytes exist while awaiting metadata commit");
    pending.destroy(); await closed; await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(f.files(), [], "cancelled files are removed before the unrelated queue operation ends");
    const overflow = await f.upload("x".repeat(17));
    assert.equal(overflow.status, 429); assert.equal((await overflow.json() as { code: string }).code, "UPLOAD_MEMORY_LIMIT", "slot was released; this is its own byte limit, not UPLOAD_BUSY");
    unblock(); await blocker; await new Promise<void>(done => setImmediate(done));
    const good = await f.upload("new"); assert.equal(good.status, 201); await good.text();
    const state = await f.call("/__management/state"); assert.equal(state.status, 200); assert.equal((await state.text()).includes("queued.txt"), false);
  } finally { unblock(); await blocker; await f.close(); }
});

test("upload authorization precedes budget use, oversized declarations fail early, and mid-stream revocation prevents commit", async () => {
  const f = await fixture({ uploadBudget: { maxConcurrent: 1, maxBufferedBytes: 32 } });
  try {
    let response = await f.bootstrap(); const ownerCookie = response.headers.get("set-cookie")!.split(";")[0]; await response.text();
    response = await f.upload("x".repeat(17)); assert.equal(response.status, 401); await response.text();
    const oversized = await new Promise<number>(done => {
      const req = httpRequest(f.base + "/__management/uploads?name=oversized.txt", { method: "POST", agent: false, headers: {
        cookie: ownerCookie, "content-type": "text/plain", "x-cesium-library": "1", "content-length": String(100 * 1024 * 1024 + 1),
      } }, res => { res.resume(); res.on("end", () => { done(res.statusCode!); req.destroy(); }); });
      req.on("error", () => done(0)); req.end();
    });
    assert.equal(oversized, 413); assert.deepEqual(f.files(), []);
    response = await f.call("/__management/commands", { type: "member.save", projectId, idempotencyKey: "worker", payload: { username: "worker", displayName: "Worker", password, roles: ["worker"] } }, { cookie: ownerCookie });
    assert.equal(response.status, 200); await response.text();
    response = await f.call("/__management/session", { username: "worker", password });
    assert.equal(response.status, 200); const workerCookie = response.headers.get("set-cookie")!.split(";")[0]; await response.text();
    let announce!: () => void;
    const started = new Promise<void>(done => { announce = done; }); f.entered.set("revoked", announce);
    let status!: (code: number) => void;
    const result = new Promise<number>(done => { status = done; });
    const pending = httpRequest(f.base + "/__management/uploads?name=revoked.txt", { method: "POST", agent: false, headers: { cookie: workerCookie, "content-type": "text/plain", "x-cesium-library": "1", "x-test-request": "revoked" } }, res => { res.resume(); res.on("end", () => status(res.statusCode!)); });
    pending.on("error", () => { status(0); announce(); }); pending.write("before"); pending.flushHeaders(); await started; response = await f.call("/__management/commands", { type: "member.save", projectId, expectedRevision: 1, idempotencyKey: "revoke-worker", payload: { username: "worker", displayName: "Worker", roles: ["worker"], resourceAccess: { files: false } } }, { cookie: ownerCookie });
    assert.equal(response.status, 200); await response.text(); pending.end("after");
    assert.equal(await result, 403);assert.deepEqual(f.files(), []);
    response = await f.upload("good", ownerCookie); assert.equal(response.status, 201); await response.text();
  } finally { await f.close(); }
});
