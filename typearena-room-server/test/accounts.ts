// Accounts, ratings, leaderboard and skill-based Quick match. Runs against the file store and, if
// TEST_DATABASE_URL is set (a Postgres you don't mind emptying), against Postgres too.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as client, Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { PgStore } from "../src/pgStore.js";
import { computeRatingChanges } from "../src/ratings.js";
import { FileStore, Store } from "../src/store.js";

const ok = (m: string) => console.log("  ok  " + m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSAGE = "the quick brown fox jumps";
const makeLog = (text: string, ms: number): [number, string][] => text.split("").map((k, i) => [Math.round(((i + 1) / text.length) * ms), k]);

// ---------- rating maths ----------
{
  const eq = computeRatingChanges([{ id: "a", rating: 1000, games: 0, rank: 1 }, { id: "b", rating: 1000, games: 0, rank: 2 }]);
  assert.equal(eq.get("a"), 20); assert.equal(eq.get("b"), -20);
  const upset = computeRatingChanges([{ id: "low", rating: 800, games: 20, rank: 1 }, { id: "high", rating: 1200, games: 20, rank: 2 }]);
  assert.ok(upset.get("low")! > 20 && upset.get("high")! < -20, "beating a stronger player is worth more");
  const ten = computeRatingChanges(Array.from({ length: 10 }, (_, i) => ({ id: "p" + i, rating: 1000, games: 30, rank: i + 1 })));
  assert.equal(ten.get("p0")! > 0 && ten.get("p9")! < 0, true);
  assert.ok(Math.abs([...ten.values()].reduce((a, b) => a + b, 0)) <= 5, "a 10-player match is roughly zero-sum");
  ok("rating maths: equal duel +20/-20, upsets pay more, a 10-player match is about zero-sum");
}

// ---------- file store survives a restart ----------
{
  const dir = mkdtempSync(join(tmpdir(), "ta-")), file = join(dir, "db.json");
  const a = new FileStore(file); await a.init();
  const u = (await a.createUser("Ada_L", "hash"))!; await a.createSession(u.id, "tokhash", Date.now() + 60_000); await a.flush();
  const b = new FileStore(file); await b.init();
  assert.equal((await b.findUserByName("ada_l"))?.id, u.id); assert.equal((await b.userBySession("tokhash"))?.username, "Ada_L");
  assert.equal(await b.createUser("ADA_L", "x"), null);
  rmSync(dir, { recursive: true });
  ok("file store: accounts and sessions survive a restart; usernames are unique ignoring capitalisation");
}

const stores: [string, () => Promise<Store>][] = [["file store", async () => new FileStore()]];
const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) stores.push(["Postgres", async () => { const s = new PgStore(dbUrl); await s.init(); await s._reset(); return s; }]);
else console.log("  (skipping Postgres: set TEST_DATABASE_URL to test it too)");

for (const [label, make] of stores) {
  console.log(`\n[${label}]`);
  const store = await make();
  const { httpServer, manager } = createApp({ bots: false, passages: [PASSAGE], countdownMs: 200, maxRaceMs: 20000, publicWaitMs: 700, fullStartMs: 300, graceMs: 300, ratingWindow: 100, windowGrowthPerSec: 400 }, store);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const connect = (session?: string) => new Promise<Socket>((res) => {
    const s = client(base, { transports: ["websocket"], auth: { token: randomUUID(), session } }); s.on("connect", () => res(s));
  });
  const emit = (s: Socket, ev: string, ...a: unknown[]) => new Promise<any>((res) => s.emit(ev, ...a, res));
  const watch = (s: Socket) => { const box: { v: any } = { v: null }; s.on("room_state", (st) => (box.v = st)); return box; };
  const who = (st: any, name: string) => st.players.find((p: any) => p.name === name);

  // ---- sign up and log in ----
  assert.equal((await api("POST", "/api/register", { username: "a b", password: "longenough" })).status, 400);
  assert.equal((await api("POST", "/api/register", { username: "alice", password: "short" })).status, 400);
  const reg = await api("POST", "/api/register", { username: "alice", password: "correct horse" });
  assert.equal(reg.status, 201); assert.equal(reg.json.user.rating, 1000); assert.ok(reg.json.token.length >= 32);
  assert.ok(!JSON.stringify(reg.json).includes("scrypt"), "the password hash is never sent");
  assert.equal((await api("POST", "/api/register", { username: "ALICE", password: "another pass" })).status, 409);
  assert.equal((await api("POST", "/api/login", { username: "alice", password: "wrong password" })).status, 401);
  assert.equal((await api("POST", "/api/login", { username: "nobody", password: "wrong password" })).status, 401);
  const login = await api("POST", "/api/login", { username: "Alice", password: "correct horse" });
  assert.equal(login.status, 200);
  assert.equal((await api("GET", "/api/me")).status, 401);
  assert.equal((await api("GET", "/api/me", undefined, login.json.token)).json.user.username, "alice");
  await api("POST", "/api/logout", undefined, login.json.token);
  assert.equal((await api("GET", "/api/me", undefined, login.json.token)).status, 401);
  ok("register, duplicate username, wrong password, login, /me, logout");

  await api("POST", "/api/register", { username: "victim", password: "right password" });
  for (let i = 0; i < 8; i++) assert.equal((await api("POST", "/api/login", { username: "victim", password: "guess " + i })).status, 401);
  assert.equal((await api("POST", "/api/login", { username: "victim", password: "right password" })).status, 429);
  ok("too many wrong passwords are blocked for a while");

  const sess: Record<string, string> = { alice: reg.json.token }, ids: Record<string, string> = { alice: reg.json.user.id };
  for (const n of ["bob", "cara", "dora"]) {
    const r = await api("POST", "/api/register", { username: n, password: "password for " + n });
    sess[n] = r.json.token; ids[n] = r.json.user.id;
  }

  // ---- a rated public match with a guest in it ----
  const A = await connect(sess.alice), G = await connect(), B = await connect(sess.bob);
  const a = watch(A);
  await emit(A, "quick_match", "Hacker"); await emit(G, "quick_match", "Gus"); await emit(B, "quick_match", "Hacker2"); await sleep(100);
  assert.deepEqual(a.v.players.map((p: any) => p.name).sort(), ["Gus", "alice", "bob"]); ok("signed-in players use their account name, not the name the browser sent");
  assert.equal(who(a.v, "alice").signedIn, true); assert.equal(who(a.v, "Gus").signedIn, false);
  const countdown = await new Promise<any>((res) => A.on("room_state", (s) => s.status === "countdown" && res(s)));
  const results = new Promise<any>((res) => A.on("room_state", (s) => s.status === "results" && res(s)));
  const at = (ms: number) => sleep(Math.max(0, countdown.startAt + ms - Date.now()));
  await Promise.all([
    (async () => { await at(1500); await emit(A, "finish", { log: makeLog(PASSAGE, 1500) }); })(),
    (async () => { await at(2000); await emit(G, "finish", { log: makeLog(PASSAGE, 2000) }); })(),
    (async () => { await at(2600); await emit(B, "finish", { log: makeLog(PASSAGE, 2600) }); })(),
  ]);
  const res = await results;
  assert.equal(who(res, "alice").rank, 1); assert.equal(who(res, "Gus").rank, 2); assert.equal(who(res, "bob").rank, 3);
  assert.equal(who(res, "alice").ratingChange, 20); assert.equal(who(res, "bob").ratingChange, -20); assert.equal(who(res, "Gus").ratingChange, undefined);
  ok("ratings change only for signed-in players (alice +20, bob -20); the guest ranks but has no rating");
  await sleep(300);
  const meA = (await api("GET", "/api/me", undefined, sess.alice)).json.user, meB = (await api("GET", "/api/me", undefined, sess.bob)).json.user;
  assert.deepEqual([meA.rating, meA.games, meA.wins], [1020, 1, 1]); assert.deepEqual([meB.rating, meB.games, meB.wins], [980, 1, 0]);
  assert.ok(meA.bestWpm > 100);
  const board = (await api("GET", "/api/leaderboard")).json.players;
  assert.deepEqual(board.map((p: any) => [p.rank, p.username, p.rating]), [[1, "alice", 1020], [2, "bob", 980]]);
  ok("new ratings are saved and the leaderboard shows them in order (guests and players with no games are not listed)");

  // the same account from another tab takes the same seat
  const A2 = await connect(sess.alice); const resumed = await emit(A2, "resume");
  assert.equal(resumed.ok, true); assert.equal(resumed.you, (await emit(A, "resume")).you); A2.disconnect();
  ok("the same account opened in another tab resumes the same seat");

  // ---- a private room is not rated ----
  const room = await emit(A, "create_room", "x"); await emit(B, "join_room", { name: "y", code: room.code });
  const cdP = new Promise<any>((res) => A.on("room_state", (s) => s.status === "countdown" && res(s)));
  const done = new Promise<any>((res) => A.on("room_state", (s) => s.status === "results" && res(s)));
  await emit(A, "start_match"); const cd = await cdP;
  const at2 = (ms: number) => sleep(Math.max(0, cd.startAt + ms - Date.now()));
  await Promise.all([(async () => { await at2(1500); await emit(A, "finish", { log: makeLog(PASSAGE, 1500) }); })(), (async () => { await at2(2600); await emit(B, "finish", { log: makeLog(PASSAGE, 2600) }); })()]);
  const pr = await done; await sleep(300);
  assert.equal(pr.rated, false); assert.equal(who(pr, "alice").ratingChange, undefined);
  assert.equal((await api("GET", "/api/me", undefined, sess.alice)).json.user.rating, 1020);
  ok("private rooms are unrated: ratings did not change");
  for (const s of [A, G, B]) s.disconnect(); await sleep(500);

  // ---- skill-based Quick match ----
  for (const [n, delta] of [["cara", 520], ["dora", 500]] as const)
    await store.applyMatch([{ userId: ids[n], delta, rank: 1, players: 2, wpm: 80, accuracy: 99, ratingBefore: 1000 }]);
  const [A3, C, D] = await Promise.all([connect(sess.alice), connect(sess.cara), connect(sess.dora)]);
  await emit(A3, "quick_match", "-"); await emit(C, "quick_match", "-");
  assert.equal([...manager.rooms.values()].filter((r) => r.isPublic && r.status === "lobby").length, 2);
  ok("a 1520 player is not put in a lobby with a 1020 player");
  C.emit("leave_room"); await sleep(1200);
  const d = watch(D); await emit(D, "quick_match", "-"); await sleep(100);
  assert.deepEqual(d.v.players.map((p: any) => p.name).sort(), ["alice", "dora"]);
  ok("after the lobby has waited a while the rating window widens and they are matched");
  const top = (await api("GET", "/api/leaderboard?limit=3")).json.players.map((p: any) => p.username);
  assert.deepEqual(top, ["cara", "dora", "alice"]); ok("leaderboard: highest rating first, limit respected");
  for (const s of [A3, C, D]) s.disconnect();
  await sleep(100);
  httpServer.close(); await store.close();
}
console.log("\nAccount checks passed.");
process.exit(0);
