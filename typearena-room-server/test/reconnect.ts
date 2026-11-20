// Reconnecting: a refresh or a dropped connection must not cost a player their seat or their race.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { io as client, Socket } from "socket.io-client";
import { createApp } from "../src/app.js";

const PASSAGE = "the quick brown fox jumps";
const GRACE = 2500;
const { httpServer } = createApp({ bots: false, passages: [PASSAGE], countdownMs: 300, maxRaceMs: 20000, graceMs: GRACE });
await new Promise<void>((r) => httpServer.listen(0, r));
const url = `http://localhost:${(httpServer.address() as { port: number }).port}`;

const connect = (token: string) => new Promise<Socket>((res) => { const s = client(url, { transports: ["websocket"], auth: { token } }); s.on("connect", () => res(s)); });
const emit = (s: Socket, ev: string, ...a: unknown[]) => new Promise<any>((res) => s.emit(ev, ...a, res));
const watch = (s: Socket) => { const box: { v: any } = { v: null }; s.on("room_state", (st) => (box.v = st)); return box; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const makeLog = (text: string, ms: number, typo = false): [number, string][] => {
  const keys: string[] = [], first = text.split(" ")[0];
  for (let i = 0; i < text.length; i++) { keys.push(text[i]); if (typo && i === first.length - 1) keys.push("x", "\b"); }
  return keys.map((k, i) => [Math.round(((i + 1) / keys.length) * ms), k]);
};
const player = (st: any, name: string) => st.players.find((p: any) => p.name === name);
const ok = (m: string) => console.log("  ok  " + m);

// ---------- lobby: refresh keeps the seat ----------
const tA = randomUUID(), tB = randomUUID(), tC = randomUUID();
let A = await connect(tA); const a = watch(A);
let B = await connect(tB);
const created = await emit(A, "create_room", "Aaryan");
const bJoin = await emit(B, "join_room", { name: "Bea", code: created.code });
assert.ok(created.you !== tA && created.you.length === 16); ok("player id is a hash, not the secret token");

B.disconnect(); await sleep(150);
assert.equal(player(a.v, "Bea").connected, false); assert.equal(player(a.v, "Bea").away, true);
ok("a dropped player is shown as reconnecting, and keeps their seat");
B = await connect(tB);
const resumed = await emit(B, "resume");
assert.equal(resumed.ok, true); assert.equal(resumed.you, bJoin.you); await sleep(100);
assert.equal(a.v.players.length, 2); assert.equal(player(a.v, "Bea").connected, true); assert.equal(player(a.v, "Bea").away, false);
assert.ok(!JSON.stringify(a.v).includes(tA) && !JSON.stringify(a.v).includes(tB));
ok("same token gets the same seat back (no duplicate), and tokens never appear in room state");

// ---------- lobby: too late = gone ----------
let C = await connect(tC); await emit(C, "join_room", { name: "Chen", code: created.code });
C.disconnect(); await sleep(GRACE + 300);
assert.equal(a.v.players.length, 2); ok("a player who does not come back in time is removed from the lobby");
C = await connect(tC); assert.equal((await emit(C, "resume")).ok, false); ok("and resume tells them they are no longer in the room");
C.disconnect();

// ---------- host refresh ----------
A.disconnect(); await sleep(100);
A = await connect(tA); const a2 = watch(A); assert.equal((await emit(A, "resume")).ok, true); await sleep(100);
assert.equal(a2.v.hostId, created.you); ok("the host can refresh and is still the host");

// ---------- a stale connection cannot kick the new one ----------
const B2 = await connect(tB); await sleep(100);
B.disconnect(); await sleep(200);
assert.equal(player(a2.v, "Bea").connected, true); ok("the old connection closing later does not drop the new one");
B = B2;

// ---------- mid-race: disconnect, others finish, come back, finish ----------
const countdown = new Promise<any>((res) => A.on("room_state", (st) => st.status === "countdown" && res(st)));
const racing = new Promise<any>((res) => A.on("room_state", (st) => st.status === "racing" && res(st)));
assert.equal((await emit(A, "start_match")).ok, true);
const cd = await countdown; await racing;
const at = (ms: number) => sleep(Math.max(0, cd.startAt + ms - Date.now()));
await at(500); B.disconnect(); ok("player drops in the middle of the race");
await at(1800); assert.equal((await emit(A, "finish", { log: makeLog(PASSAGE, 1800) })).ok, true);
await sleep(300);
assert.equal(a2.v.status, "racing"); ok("the race waits for the player who is reconnecting");
await at(2200); B = await connect(tB); const bState = watch(B); assert.equal((await emit(B, "resume")).ok, true);
await sleep(100);
assert.equal(bState.v.status, "racing"); assert.equal(bState.v.passage, PASSAGE); ok("reconnected player gets the running race back");
await at(2600);
const done = new Promise<any>((res) => A.on("room_state", (st) => st.status === "results" && res(st)));
assert.equal((await emit(B, "finish", { log: makeLog(PASSAGE, 2600, true) })).ok, true);
const res = await done;
assert.equal(player(res, "Aaryan").rank, 1); assert.equal(player(res, "Bea").rank, 2);
assert.equal(player(res, "Bea").result.verified, true);
ok("late result is accepted and verified (" + player(res, "Bea").result.wpm + " wpm), ranked 2nd");
A.disconnect(); B.disconnect(); await sleep(50);

// ---------- mid-race: never came back ----------
const tE = randomUUID(), tF = randomUUID();
let E = await connect(tE); let F = await connect(tF);
const room2 = await emit(E, "create_room", "Eve"); await emit(F, "join_room", { name: "Finn", code: room2.code });
const e = watch(E);
const cd2 = new Promise<any>((res) => E.on("room_state", (st) => st.status === "countdown" && res(st)));
await emit(E, "start_match"); const c2 = await cd2;
await sleep(Math.max(0, c2.startAt + 300 - Date.now())); F.disconnect();
await sleep(Math.max(0, c2.startAt + 3300 - Date.now()));
assert.equal((await emit(E, "finish", { log: makeLog(PASSAGE, 3300) })).ok, true); await sleep(150);
assert.equal(e.v.status, "results"); assert.equal(player(e.v, "Finn").result, undefined); assert.equal(player(e.v, "Finn").rank, 2);
ok("a player who never comes back is a DNF, and the match ends without waiting forever");
F = await connect(tF); assert.equal((await emit(F, "resume")).ok, false); ok("late comeback is told they left the room");
E.disconnect(); F.disconnect();

// ---------- tokens are required ----------
const bad = await new Promise<string>((res) => { const s = client(url, { transports: ["websocket"], reconnection: false }); s.on("connect_error", (err) => { s.close(); res(err.message); }); });
assert.match(bad, /token/i); ok("connections without a player token are rejected");

console.log("\nReconnect checks passed.");
process.exit(0);
