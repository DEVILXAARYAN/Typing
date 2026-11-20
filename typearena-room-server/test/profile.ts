// Profiles, rated match history and saved Solo Sprint runs. Runs on the file store and, with TEST_DATABASE_URL, on Postgres too.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { PgStore } from "../src/pgStore.js";
import { FileStore, SoloRun, Store } from "../src/store.js";

const ok = (m: string) => console.log("  ok  " + m);
const run = (mode: string, wpm: number): SoloRun => ({ mode, wpm, raw: wpm + 5, accuracy: 97, consistency: 88, durationMs: 20000, errors: 2 });

// ---------- the file store keeps history across a restart ----------
{
  const dir = mkdtempSync(join(tmpdir(), "ta-")), file = join(dir, "db.json");
  const a = new FileStore(file); await a.init();
  const u = (await a.createUser("Ada", "h"))!;
  await a.applyMatch([{ userId: u.id, delta: 20, rank: 1, players: 4, wpm: 80, accuracy: 98, ratingBefore: 1000 }]);
  await a.addSolo(u.id, run("passage", 70)); await a.flush();
  const b = new FileStore(file); await b.init();
  assert.equal((await b.recentMatches(u.id, 5))[0].ratingAfter, 1020); assert.equal((await b.soloSummary(u.id, 5)).bests.passage, 70);
  rmSync(dir, { recursive: true });
  ok("file store: match history and solo runs survive a restart");
}

const stores: [string, () => Promise<Store>][] = [["file store", async () => new FileStore()]];
const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) stores.push(["Postgres", async () => { const s = new PgStore(dbUrl); await s.init(); await s._reset(); return s; }]);

for (const [label, make] of stores) {
  console.log(`\n[${label}]`);
  const store = await make();
  const { httpServer } = createApp({ bots: false }, store);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => null)) as any, ctype: r.headers.get("content-type") };
  };
  const reg = async (n: string) => (await api("POST", "/api/register", { username: n, password: "password for " + n })).json;
  const A = await reg("alice"), B = await reg("bob");

  // ---- rated match history ----
  assert.equal((await api("GET", "/api/profile")).status, 401);
  await store.applyMatch([{ userId: A.user.id, delta: 20, rank: 1, players: 5, wpm: 84.5, accuracy: 98, ratingBefore: 1000 }]);
  await new Promise((r) => setTimeout(r, 15));
  await store.applyMatch([{ userId: A.user.id, delta: -10, rank: 3, players: 6, wpm: 70, accuracy: 95, ratingBefore: 1020 }]);
  const prof = (await api("GET", "/api/profile", undefined, A.token)).json;
  assert.equal(prof.user.rating, 1010); assert.equal(prof.user.games, 2); assert.equal(prof.user.wins, 1); assert.equal(prof.rank, 1);
  assert.deepEqual(prof.matches.map((m: any) => [m.rank, m.ratingBefore, m.ratingAfter]), [[3, 1020, 1010], [1, 1000, 1020]]);
  assert.ok(prof.matches[0].finishedAt >= prof.matches[1].finishedAt);
  assert.equal((await api("GET", "/api/profile", undefined, B.token)).json.rank, null); assert.deepEqual((await api("GET", "/api/profile", undefined, B.token)).json.matches, []);
  ok("profile: rating, wins, leaderboard rank and rated match history (newest first, with rating before and after)");

  // ---- public profile ----
  const pub = await api("GET", "/api/users/ALICE");
  assert.equal(pub.status, 200); assert.equal(pub.json.user.username, "alice"); assert.equal(pub.json.matches.length, 2);
  assert.ok(!("solo" in pub.json) && !("id" in pub.json.user) && !JSON.stringify(pub.json).includes("scrypt"));
  assert.equal((await api("GET", "/api/users/nobody")).status, 404); assert.equal((await api("GET", "/api/users/a%20b")).status, 404);
  ok("public profile works by username (any capitalisation), shows no private data, unknown names give 404");

  // ---- saving solo runs ----
  assert.equal((await api("POST", "/api/solo", run("passage", 60))).status, 401);
  for (const bad of [{ ...run("passage", 60), mode: "x" }, run("passage", 999), { ...run("passage", 60), accuracy: 120 }, { ...run("passage", 60), durationMs: 10 }, { ...run("passage", 60), errors: -1 }, { ...run("passage", 60), wpm: "fast" }, { ...run("passage", 60), consistency: 500 }])
    assert.equal((await api("POST", "/api/solo", bad, A.token)).status, 400);
  ok("solo runs need a signed-in account, and impossible numbers are refused");
  assert.equal((await api("POST", "/api/solo", run("passage", 60), A.token)).status, 201);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal((await api("POST", "/api/solo", { ...run("10", 90), consistency: null }, A.token)).status, 201);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal((await api("POST", "/api/solo", run("passage", 75), A.token)).status, 201);
  const solo = (await api("GET", "/api/solo", undefined, A.token)).json;
  assert.equal(solo.runs, 3); assert.deepEqual(solo.recent.map((r: any) => r.wpm), [75, 90, 60]); assert.deepEqual(solo.bests, { passage: 75, "10": 90 });
  assert.equal(solo.avgLast10, 75); assert.equal(solo.recent[1].consistency, null);
  assert.equal((await api("GET", "/api/solo", undefined, B.token)).json.runs, 0);
  assert.equal((await api("GET", "/api/profile", undefined, A.token)).json.solo.runs, 3);
  ok("saved runs come back newest first with personal bests per text type and the average of the last runs; each account sees only its own");

  // ---- rate limit ----
  let last = 201; for (let i = 0; i < 57; i++) last = (await api("POST", "/api/solo", run("25", 50), A.token)).status;
  assert.equal(last, 201); assert.equal((await api("POST", "/api/solo", run("25", 50), A.token)).status, 429);
  ok("more than 60 saved runs an hour is refused");

  // ---- old runs are trimmed but personal bests are kept ----
  const C = await reg("carol");
  await store.addSolo(C.user.id, run("passage", 200));
  for (let i = 0; i < 505; i++) await store.addSolo(C.user.id, run("passage", 40));
  const cs = await store.soloSummary(C.user.id, 20);
  assert.equal(cs.runs, 500); assert.equal(cs.bests.passage, 200); ok("only the newest 500 runs are kept, but the personal best is never lost");

  // ---- the pages are served ----
  const page = async (path: string) => { const r = await fetch(base + path); return { status: r.status, text: await r.text() }; };
  const p1 = await page("/profile"), p2 = await page("/u/alice");
  assert.equal(p1.status, 200); assert.equal(p2.status, 200);
  ok("/profile and /u/NAME are served (the profile page itself is checked separately)");
  httpServer.close(); await store.close();
}
console.log("\nProfile checks passed.");
process.exit(0);
