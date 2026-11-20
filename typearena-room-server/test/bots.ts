// Bots fill the empty seats of public lobbies. They are marked as bots, never change ratings, and are checked like humans.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { io as client, Socket } from "socket.io-client";
import { createApp } from "../src/app.js";

const PASSAGE = "the quick brown fox jumps";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log("  ok  " + m);
const makeLog = (text: string, ms: number): [number, string][] => text.split("").map((k, i) => [Math.round(((i + 1) / text.length) * ms), k]);

async function boot(opts: Record<string, unknown>) {
  const app = createApp({ passages: [PASSAGE], countdownMs: 200, maxRaceMs: 20000, publicWaitMs: 3000, botWaitMs: 600, fullStartMs: 300, graceMs: 300, botFillTo: 5, botWpm: [180, 240], ...opts });
  await new Promise<void>((r) => app.httpServer.listen(0, r));
  const base = `http://localhost:${(app.httpServer.address() as { port: number }).port}`;
  const connect = (session?: string) => new Promise<Socket>((res) => { const s = client(base, { transports: ["websocket"], auth: { token: randomUUID(), session } }); s.on("connect", () => res(s)); });
  const emit = (s: Socket, ev: string, ...a: unknown[]) => new Promise<any>((res) => s.emit(ev, ...a, res));
  const waitFor = (s: Socket, pred: (st: any) => boolean) => new Promise<any>((res) => { const h = (st: any) => { if (pred(st)) { s.off("room_state", h); res(st); } }; s.on("room_state", h); });
  const watch = (s: Socket) => { const box: { v: any } = { v: null }; s.on("room_state", (st) => (box.v = st)); return box; };
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const signUp = async (name: string) => (await api("POST", "/api/register", { username: name, password: "password for " + name })).json.token as string;
  return { ...app, base, connect, emit, waitFor, watch, api, signUp };
}
const idle = async (app: Awaited<ReturnType<typeof boot>>) => { for (let i = 0; i < 40 && app.manager.rooms.size; i++) await sleep(100); return app.manager.rooms.size; };

// ---------- 1. a lone player: bots fill the lobby, the match starts by itself ----------
{
  const app = await boot({});
  const G = await app.connect(), w = app.watch(G);
  const cdP = app.waitFor(G, (s) => s.status === "countdown"), resP = app.waitFor(G, (s) => s.status === "results");
  const progress: any[] = []; G.on("progress", (l) => progress.push(...l));
  await app.emit(G, "quick_match", "Gus"); await sleep(100);
  assert.ok(w.v.autoStartAt > 0 && w.v.players.length === 1); assert.equal(w.v.botsOn, true);
  ok("a lone player gets a start timer straight away (no need to wait for other humans)");
  const cd = await cdP;
  const bots = cd.players.filter((p: any) => p.bot);
  assert.equal(cd.players.length, 5); assert.equal(bots.length, 4);
  assert.equal(new Set(bots.map((b: any) => b.name)).size, 4); assert.ok(bots.every((b: any) => b.connected && !b.signedIn && b.id.startsWith("bot-")));
  assert.equal(cd.players.filter((p: any) => !p.bot)[0].bot, false);
  ok("the lobby is filled up to 5 players with 4 differently named bots, each marked as a bot");
  await sleep(Math.max(0, cd.startAt + 4500 - Date.now()));
  assert.equal((await app.emit(G, "finish", { log: makeLog(PASSAGE, 4500) })).ok, true);
  const res = await resP;
  assert.ok(res.players.every((p: any) => p.finished && p.result?.verified)); ok("every bot finished and its result passed the same verification as a human's");
  assert.deepEqual(res.players.map((p: any) => p.rank).sort(), [1, 2, 3, 4, 5]);
  const byRank = [...res.players].sort((a: any, b: any) => a.rank - b.rank);
  assert.ok(byRank.every((p: any, i: number) => i === 0 || byRank[i - 1].result.score >= p.result.score), "ranks follow the score");
  assert.ok(res.players.filter((p: any) => p.bot).every((p: any) => p.ratingChange === undefined && p.result.wpm > 50)); ok("bots are ranked by score like anyone else, and have no rating");
  const botProgress = progress.filter((p) => p.id.startsWith("bot-"));
  assert.ok(botProgress.some((p) => p.pct > 0 && p.pct < 100)); ok("bots move forward on the live leaderboard during the race");
  G.disconnect(); assert.equal(await idle(app), 0); ok("when the human leaves, the room and the bots disappear");
  app.httpServer.close();
}

// ---------- 2. start now, and who may use it ----------
{
  const app = await boot({ botWaitMs: 5000 });
  const H = await app.connect(); const cdP = app.waitFor(H, (s) => s.status === "countdown");
  await app.emit(H, "quick_match", "Hana"); const t0 = Date.now();
  assert.equal((await app.emit(H, "start_now")).ok, true); const cd = await cdP;
  assert.ok(Date.now() - t0 < 1000 && cd.players.length === 5); ok("\"Start now\" skips the wait and starts with bots at once");
  H.disconnect(); await idle(app);

  const X = await app.connect(), Y = await app.connect(), P = await app.connect();
  await app.emit(X, "quick_match", "X"); await app.emit(Y, "quick_match", "Y");
  const err = await app.emit(X, "start_now"); assert.equal(err.ok, false); assert.match(err.error, /only player/);
  const room = await app.emit(P, "create_room", "Priv"); assert.ok(room.code);
  assert.equal((await app.emit(P, "start_now")).ok, false); ok("start now is refused with 2 humans in the lobby and in private rooms");
  for (const s of [X, Y, P]) s.disconnect(); await idle(app); app.httpServer.close();
}

// ---------- 3. ratings: bots never count ----------
{
  const app = await boot({ botWaitMs: 2000 });
  const [tA, tB, tC] = await Promise.all([app.signUp("alice"), app.signUp("bob"), app.signUp("carol")]);
  const A = await app.connect(tA), B = await app.connect(tB);
  const cdP = app.waitFor(A, (s) => s.status === "countdown"), resP = app.waitFor(A, (s) => s.status === "results");
  await app.emit(A, "quick_match", "-"); await app.emit(B, "quick_match", "-");
  const cd = await cdP; assert.equal(cd.players.length, 5); assert.equal(cd.players.filter((p: any) => p.bot).length, 3);
  ok("two humans plus 3 bots in the same lobby (bots fill up to 5)");
  await sleep(Math.max(0, cd.startAt + 4000 - Date.now())); await app.emit(A, "finish", { log: makeLog(PASSAGE, 4000) });
  await sleep(Math.max(0, cd.startAt + 5000 - Date.now())); await app.emit(B, "finish", { log: makeLog(PASSAGE, 5000) });
  const res = await resP; const get = (n: string) => res.players.find((p: any) => p.name === n);
  assert.equal(get("alice").ratingChange, 20); assert.equal(get("bob").ratingChange, -20);
  assert.ok(res.players.filter((p: any) => p.bot).every((p: any) => p.ratingChange === undefined));
  await sleep(300);
  assert.equal((await app.api("GET", "/api/me", undefined, tA)).json.user.rating, 1020); assert.equal((await app.api("GET", "/api/me", undefined, tB)).json.user.rating, 980);
  ok("two signed-in humans are rated against each other only (+20 / -20), bots are left out");
  A.disconnect(); B.disconnect(); await idle(app);

  const C = await app.connect(tC); const cd2P = app.waitFor(C, (s) => s.status === "countdown"), res2P = app.waitFor(C, (s) => s.status === "results");
  await app.emit(C, "quick_match", "-"); await app.emit(C, "start_now"); const cd2 = await cd2P;
  await sleep(Math.max(0, cd2.startAt + 4500 - Date.now())); await app.emit(C, "finish", { log: makeLog(PASSAGE, 4500) });
  const res2 = await res2P; assert.equal(res2.players.find((p: any) => p.name === "carol").ratingChange, undefined);
  await sleep(300); const me = (await app.api("GET", "/api/me", undefined, tC)).json.user; assert.deepEqual([me.rating, me.games], [1000, 0]);
  ok("a signed-in player against bots only is a practice match: no rating change");
  C.disconnect(); await idle(app); app.httpServer.close();
}

// ---------- 4. human leaves mid-race ----------
{
  const app = await boot({});
  const Z = await app.connect(); const racing = app.waitFor(Z, (s) => s.status === "racing");
  await app.emit(Z, "quick_match", "Zed"); await app.emit(Z, "start_now"); await racing; await sleep(300);
  Z.emit("leave_room"); await sleep(200);
  assert.equal(await idle(app), 0); ok("a human leaving in the middle of a race closes the room, and no bot timers keep running");
  app.httpServer.close();
}

// ---------- 5. bots switched off ----------
{
  const app = await boot({ bots: false });
  const H = await app.connect(), w = app.watch(H);
  await app.emit(H, "quick_match", "Hana"); await sleep(1500);
  assert.equal(w.v.autoStartAt, 0); assert.equal(w.v.status, "lobby"); assert.equal(w.v.botsOn, false);
  assert.equal((await app.emit(H, "start_now")).ok, false); ok("with bots off, a lone player waits for real players and Start now is unavailable");
  H.disconnect(); app.httpServer.close();
}
console.log("\nBot checks passed.");
process.exit(0);
