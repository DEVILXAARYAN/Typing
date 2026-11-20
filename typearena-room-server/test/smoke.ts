// End-to-end check: 4 players, one cheater, one who leaves, then a rematch.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { io as client, Socket } from "socket.io-client";
import { createApp } from "../src/app.js";

const PASSAGE = "the quick brown fox jumps";
const { httpServer } = createApp({ bots: false, passages: [PASSAGE], countdownMs: 300, maxRaceMs: 20000, graceMs: 400 });
await new Promise<void>((r) => httpServer.listen(0, r));
const url = `http://localhost:${(httpServer.address() as { port: number }).port}`;

const connect = () => new Promise<Socket>((res) => { const s = client(url, { transports: ["websocket"], auth: { token: randomUUID() } }); s.on("connect", () => res(s)); });
const emit = (s: Socket, ev: string, ...a: unknown[]) => new Promise<any>((res) => s.emit(ev, ...a, res));
const waitState = (s: Socket, pred: (st: any) => boolean) =>
  new Promise<any>((res) => { const h = (st: any) => { if (pred(st)) { s.off("room_state", h); res(st); } }; s.on("room_state", h); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const makeLog = (text: string, ms: number, typo = false): [number, string][] => {
  const keys: string[] = [], first = text.split(" ")[0];
  for (let i = 0; i < text.length; i++) { keys.push(text[i]); if (typo && i === first.length - 1) keys.push("x", "\b"); }
  return keys.map((k, i) => [Math.round(((i + 1) / keys.length) * ms), k]);
};
const ok = (m: string) => console.log("  ok  " + m);

const [A, B, C, D, E] = await Promise.all([connect(), connect(), connect(), connect(), connect()]);

const created = await emit(A, "create_room", "Aaryan");
assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/); ok("room created with code " + created.code);
assert.equal((await emit(B, "join_room", { name: "Wrong", code: "ZZZZZZ" })).ok, false); ok("wrong code is rejected");
assert.equal((await emit(B, "join_room", { name: "Bea", code: created.code.toLowerCase() })).ok, true); ok("join works (code is case-insensitive)");
await emit(C, "join_room", { name: "Cheater", code: created.code });
await emit(D, "join_room", { name: "Dropper", code: created.code });
assert.equal((await emit(B, "start_match")).ok, false); ok("only the host can start");

const racing = waitState(A, (s) => s.status === "racing");
const countdown = waitState(A, (s) => s.status === "countdown");
assert.equal((await emit(A, "start_match")).ok, true);
const cd = await countdown; assert.equal(cd.passage, PASSAGE); assert.equal(cd.players.length, 4);
await racing; ok("countdown, then racing");
assert.equal((await emit(E, "join_room", { name: "Late", code: created.code })).ok, false); ok("cannot join a race in progress");

const startAt = cd.startAt;
const progressSeen = new Promise<any>((res) => B.once("progress", res));
B.emit("progress", "the quick");
const prog = await progressSeen;
assert.ok(prog.find((p: any) => p.pct > 0)); ok("live progress is broadcast");

D.disconnect(); ok("a player disconnects mid-race");
const done = waitState(A, (s) => s.status === "results");
const at = async (ms: number) => { await sleep(Math.max(0, startAt + ms - Date.now())); };
await Promise.all([
  (async () => { await at(3000); assert.equal((await emit(A, "finish", { log: makeLog(PASSAGE, 3000) })).ok, true); })(),
  (async () => { await at(4500); assert.equal((await emit(B, "finish", { log: makeLog(PASSAGE, 4500, true) })).ok, true); })(),
  (async () => { await at(400); assert.equal((await emit(C, "finish", { log: makeLog(PASSAGE, 100) })).ok, true); })(),
]);
const res = await done;
const by = (n: string) => res.players.find((p: any) => p.name === n);
console.log("  results:", res.players.map((p: any) => `${p.rank}. ${p.name} ${p.result ? `${p.result.wpm}wpm ${p.result.accuracy}% score ${p.result.score}${p.result.verified ? "" : " UNVERIFIED (" + p.result.note + ")"}` : "DNF"}`).sort().join(" | "));
assert.equal(by("Aaryan").rank, 1); assert.equal(by("Bea").rank, 2);
assert.equal(by("Cheater").rank, 3); assert.equal(by("Cheater").result.verified, false);
assert.equal(by("Dropper").rank, 4); assert.equal(by("Dropper").result, undefined);
assert.ok(by("Bea").result.errors === 1 && by("Bea").result.accuracy < 100); ok("ranking: Aaryan, Bea, then the unverified cheater, then the player who left");

assert.equal((await emit(A, "finish", { log: makeLog(PASSAGE, 1000) })).ok, false); ok("finishing after the race is rejected");
assert.equal((await emit(B, "rematch")).ok, false); ok("only the host can start a rematch");
const lobby = waitState(A, (s) => s.status === "lobby");
assert.equal((await emit(A, "rematch")).ok, true);
const l = await lobby; assert.equal(l.players.length, 3); assert.equal(l.passage, ""); ok("rematch returns to the lobby (leaver removed)");

for (const s of [A, B, C, E]) s.disconnect();
await sleep(100);
console.log("\nAll checks passed.");
process.exit(0);
