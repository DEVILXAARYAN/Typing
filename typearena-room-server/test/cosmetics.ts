// Worlds and character looks: unlocking by peak rating, saving a look, and what other players see in a race.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { io as client, Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { CATALOG, DEFAULT_LOOK, KINDS, isUnlocked, nextUnlock, sanitizeLook, validateLook } from "../src/cosmetics.js";
import { PgStore } from "../src/pgStore.js";
import { FileStore, Store } from "../src/store.js";

const ok = (m: string) => console.log("  ok  " + m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the catalog itself ----------
{
  for (const k of KINDS) {
    const ids = CATALOG[k].map((i) => i.id); assert.equal(new Set(ids).size, ids.length, k + " ids are unique");
    assert.ok(isUnlocked(k, DEFAULT_LOOK[k], 0), "the default " + k + " is free");
    assert.ok(CATALOG[k].every((i, n, a) => n === 0 || i.minRating >= a[n - 1].minRating), k + " are listed from easiest to hardest");
  }
  assert.deepEqual(sanitizeLook({ world: "space", color: "violet", hat: "wizard", trail: "nope" }, 1000), DEFAULT_LOOK);
  assert.deepEqual(sanitizeLook({ world: "snow", color: "violet", hat: "cap", trail: "sparkles" }, 1040), { world: "snow", color: "violet", hat: "cap", trail: "sparkles" });
  assert.deepEqual(sanitizeLook(null, 5000), DEFAULT_LOOK); assert.deepEqual(sanitizeLook("x", 5000), DEFAULT_LOOK);
  assert.equal(validateLook({ ...DEFAULT_LOOK, hat: "halo" }, 1100).ok, false); assert.equal((validateLook({ ...DEFAULT_LOOK, hat: "halo" }, 1100) as any).status, 403);
  assert.equal((validateLook({ ...DEFAULT_LOOK, hat: "banana" }, 9999) as any).status, 400); assert.equal((validateLook(undefined, 9999) as any).status, 400);
  assert.equal(validateLook({ world: "space", color: "rainbow", hat: "halo", trail: "lightning" }, 1250).ok, true);
  assert.deepEqual(nextUnlock(1000), { kind: "world", id: "snow", name: "Snowfield", minRating: 1020 }); assert.equal(nextUnlock(99999), null);
  ok("catalog: unique ids, free defaults, locked and unknown items are refused, unlocks fall back to defaults, next reward is found");
}

// ---------- the file store keeps peak rating and look, and understands old files ----------
{
  const dir = mkdtempSync(join(tmpdir(), "ta-")), file = join(dir, "db.json");
  const a = new FileStore(file); await a.init();
  const u = (await a.createUser("Ada", "h"))!;
  await a.applyMatch([{ userId: u.id, delta: 45, rank: 1, players: 3, wpm: 80, accuracy: 98, ratingBefore: 1000 }]);
  await a.applyMatch([{ userId: u.id, delta: -30, rank: 3, players: 3, wpm: 60, accuracy: 90, ratingBefore: 1045 }]);
  await a.setLook(u.id, { world: "snow", color: "aqua", hat: "cap", trail: "lines" }); await a.flush();
  const b = new FileStore(file); await b.init(); const back = (await b.getUser(u.id))!;
  assert.deepEqual([back.rating, back.peakRating, back.look?.world], [1015, 1045, "snow"]);
  writeFileSync(file, JSON.stringify({ users: [{ id: "old", username: "OldTimer", passwordHash: "h", rating: 1180, games: 9, wins: 4, bestWpm: 70, createdAt: 1 }], sessions: [] }));
  const c = new FileStore(file); await c.init(); const old = (await c.getUser("old"))!;
  assert.deepEqual([old.peakRating, old.look], [1180, null]); rmSync(dir, { recursive: true });
  ok("file store: peak rating only goes up, the look is saved, and files from before this feature still load");
}

const stores: [string, () => Promise<Store>][] = [["file store", async () => new FileStore()]];
const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) stores.push(["Postgres", async () => { const s = new PgStore(dbUrl); await s.init(); await s._reset(); return s; }]);

// ---------- Postgres: an older database is upgraded ----------
if (dbUrl) {
  const pool = new pg.Pool({ connectionString: dbUrl });
  await pool.query("DROP TABLE IF EXISTS match_results, solo_results, solo_bests, sessions, users CASCADE");
  await pool.query(`CREATE TABLE users (id text PRIMARY KEY, username text NOT NULL, username_lower text NOT NULL UNIQUE, password_hash text NOT NULL,
    rating integer NOT NULL DEFAULT 1000, games integer NOT NULL DEFAULT 0, wins integer NOT NULL DEFAULT 0, best_wpm real NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query("INSERT INTO users (id, username, username_lower, password_hash, rating) VALUES ('u1','Veteran','veteran','h',1180)");
  const s = new PgStore(dbUrl); await s.init(); await s.init(); // twice: the upgrade can run again safely
  const v = (await s.getUser("u1"))!; assert.deepEqual([v.rating, v.peakRating, v.look], [1180, 1180, null]);
  await s.close(); await pool.end(); ok("Postgres: a database from before this feature is upgraded in place (existing players keep their rating as peak)");
}

for (const [label, make] of stores) {
  console.log(`\n[${label}]`);
  const store = await make();
  const { httpServer } = createApp({ bots: false, publicWaitMs: 1500, countdownMs: 300 }, store);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const reg = async (n: string) => (await api("POST", "/api/register", { username: n, password: "password for " + n })).json;
  const connect = (session?: string) => new Promise<Socket>((res) => { const s = client(base, { transports: ["websocket"], auth: { token: randomUUID(), session } }); s.on("connect", () => res(s)); });
  const emit = (s: Socket, ev: string, ...a: unknown[]) => new Promise<any>((res) => s.emit(ev, ...a, res));
  const watch = (s: Socket) => { const box: { v: any } = { v: null }; s.on("room_state", (st) => (box.v = st)); return box; };
  const A = await reg("alice"), G = (await reg("gina"));

  // ---- the catalog and the unlock rules over HTTP ----
  const pub = await api("GET", "/api/cosmetics"); assert.equal(pub.status, 200); assert.ok(pub.json.catalog.world.length === 4 && !("look" in pub.json));
  const mine = (await api("GET", "/api/cosmetics", undefined, A.token)).json;
  assert.deepEqual(mine.look, DEFAULT_LOOK); assert.equal(mine.peakRating, 1000); assert.equal(mine.next.name, "Snowfield");
  ok("catalog is public; a signed-in player also gets their peak rating, current look and next reward");
  assert.equal((await api("PUT", "/api/look", DEFAULT_LOOK)).status, 401);
  assert.equal((await api("PUT", "/api/look", { ...DEFAULT_LOOK, hat: "banana" }, A.token)).status, 400);
  const locked = await api("PUT", "/api/look", { ...DEFAULT_LOOK, world: "snow" }, A.token); assert.equal(locked.status, 403); assert.match(locked.json.error, /Snowfield unlocks at rating 1020/);
  assert.equal((await api("PUT", "/api/look", { ...DEFAULT_LOOK, color: "aqua" }, A.token)).status, 200);
  assert.equal((await api("GET", "/api/me", undefined, A.token)).json.user.look.color, "aqua"); ok("signed out is refused, unknown items are a bad request, locked items give 403, free items save");

  // ---- unlocking by PEAK rating ----
  await store.applyMatch([{ userId: A.user.id, delta: 40, rank: 1, players: 3, wpm: 80, accuracy: 98, ratingBefore: 1000 }]);
  const want = { world: "snow", color: "violet", hat: "cap", trail: "sparkles" };
  assert.equal((await api("PUT", "/api/look", want, A.token)).status, 200);
  await store.applyMatch([{ userId: A.user.id, delta: -60, rank: 3, players: 3, wpm: 60, accuracy: 90, ratingBefore: 1040 }]);
  const after = (await api("GET", "/api/me", undefined, A.token)).json.user;
  assert.deepEqual([after.rating, after.peakRating], [980, 1040]); assert.deepEqual(after.look, want);
  assert.equal((await api("PUT", "/api/look", want, A.token)).status, 200); assert.equal((await api("GET", "/api/cosmetics", undefined, A.token)).json.look.hat, "cap");
  ok("a rating of 1040 unlocks Snowfield, Violet, Cap and Sparkles; dropping to 980 does not take them back");

  // ---- what other players see in a race ----
  const sA = await connect(A.token), sG = await connect(G.token), sX = await connect();
  const w = watch(sA);
  await emit(sA, "quick_match", "-"); await emit(sG, "quick_match", "-"); await emit(sX, "quick_match", "Guest"); await sleep(150);
  const looks = Object.fromEntries(w.v.players.map((p: any) => [p.name, p.look]));
  assert.deepEqual(looks.alice, { color: "violet", hat: "cap", trail: "sparkles" }); assert.deepEqual(looks.gina, { color: "lime", hat: "none", trail: "lines" }); assert.equal(looks.Guest, undefined);
  assert.ok(!JSON.stringify(w.v).includes('"world"'), "a player's own world is private to them"); ok("room state carries each signed-in player's colour, hat and trail; guests have none; worlds stay private");
  sA.emit("leave_room"); await sleep(100);
  await store.setLook(A.user.id, { world: "space", color: "rainbow", hat: "halo", trail: "lightning" }); // something they have not unlocked
  const w2 = watch(sA); await emit(sA, "quick_match", "-"); await sleep(150);
  assert.deepEqual(who(w2.v, "alice").look, { color: "lime", hat: "none", trail: "lines" }); ok("a look that is not unlocked can never be shown, even if it is in the database");
  function who(st: any, n: string) { return st.players.find((p: any) => p.name === n); }
  for (const s of [sA, sG, sX]) s.disconnect();
  await sleep(100); httpServer.close(); await store.close();
}
console.log("\nCosmetics checks passed.");
process.exit(0);
