// Public matchmaking: Quick match fills lobbies of up to 10 and starts them automatically.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { io as client, Socket } from "socket.io-client";
import { createApp } from "../src/app.js";

const PASSAGE = "the quick brown fox jumps";
const { httpServer, manager } = createApp({ bots: false, passages: [PASSAGE], countdownMs: 200, maxRaceMs: 3000, publicWaitMs: 900, fullStartMs: 300, graceMs: 300 });
await new Promise<void>((r) => httpServer.listen(0, r));
const url = `http://localhost:${(httpServer.address() as { port: number }).port}`;

const connect = () => new Promise<Socket>((res) => { const s = client(url, { transports: ["websocket"], auth: { token: randomUUID() } }); s.on("connect", () => res(s)); });
const emit = (s: Socket, ev: string, ...a: unknown[]) => new Promise<any>((res) => s.emit(ev, ...a, res));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastState = (s: Socket) => { const box: { v: any } = { v: null }; s.on("room_state", (st) => (box.v = st)); return box; };
const ok = (m: string) => console.log("  ok  " + m);
const roomsOf = () => [...manager.rooms.values()];

// 1. The first player opens a public lobby and waits alone.
const A = await connect(); const a = lastState(A);
await emit(A, "quick_match", "Aaryan"); await sleep(100);
assert.equal(a.v.isPublic, true); assert.equal(a.v.code, ""); assert.equal(a.v.status, "lobby"); assert.equal(a.v.autoStartAt, 0);
ok("first player opens a public lobby, no code is exposed, no timer while alone");

// 2. The second and third players are placed in the SAME lobby; the wait timer starts.
const B = await connect(); const b = lastState(B);
await emit(B, "quick_match", "Bea"); await sleep(100);
const C = await connect(); const c = lastState(C);
await emit(C, "quick_match", "Chen"); await sleep(100);
assert.equal(roomsOf().length, 1); assert.equal(a.v.players.length, 3); assert.ok(a.v.autoStartAt > Date.now());
ok("players 2 and 3 land in the same lobby and the start timer is running");
const firstTimer = a.v.autoStartAt;

// 3. Rules for public lobbies.
assert.equal((await emit(A, "start_match")).ok, false); ok("nobody can start a public lobby by hand");
const code = roomsOf()[0].code;
const X = await connect();
assert.equal((await emit(X, "join_room", { name: "Sneaky", code })).ok, false); ok("a public lobby cannot be joined by its code");
X.disconnect();

// 4. A player leaving does not move the timer; the lobby starts by itself.
const countdown = new Promise<any>((res) => A.on("room_state", (st) => st.status === "countdown" && res(st)));
const st = await countdown;
assert.equal(st.players.length, 3); assert.ok(Math.abs(Date.now() - firstTimer) < 600); ok("lobby auto-starts when the timer ends (3 players)");

// 5. A late player is NOT squeezed into the running match: new lobby.
const D = await connect(); const d = lastState(D);
await emit(D, "quick_match", "Late"); await sleep(100);
assert.equal(roomsOf().length, 2); assert.equal(d.v.status, "lobby"); assert.equal(d.v.players.length, 1);
ok("a late player gets a fresh public lobby");

// 6. Below the minimum the timer is cancelled.
const E = await connect(); const e = lastState(E);
await emit(E, "quick_match", "Eli"); await sleep(100);
assert.equal(d.v.players.length, 2); assert.ok(d.v.autoStartAt > 0);
E.emit("leave_room"); await sleep(150);
assert.equal(d.v.players.length, 1); assert.equal(d.v.autoStartAt, 0); ok("if players leave and too few remain, the start timer is cancelled");
await sleep(1100); assert.equal(d.v.status, "lobby"); ok("and the lobby does not start with a single player");

// 7. Ten players fill a lobby; the 11th goes to a new lobby.
for (const s of [A, B, C]) s.disconnect(); await sleep(3600); // let the first match end and its room disappear
D.emit("leave_room"); await sleep(100);
const crowd = await Promise.all(Array.from({ length: 11 }, connect));
const states = crowd.map(lastState);
for (let i = 0; i < 11; i++) { await emit(crowd[i], "quick_match", "P" + (i + 1)); }
await sleep(150);
const codes = new Set(roomsOf().filter((r) => r.isPublic).map((r) => r.players.size));
const full = roomsOf().find((r) => r.players.size === 10)!;
assert.ok(full, "a lobby with 10 players exists");
assert.equal(roomsOf().filter((r) => r.players.size === 1).length, 1); ok("10 players fill one lobby; the 11th opens another (" + [...codes].join(" + ") + " players)");
assert.ok(states[0].v.autoStartAt - Date.now() < 400); ok("a full lobby starts after a short delay instead of waiting");
await sleep(450);
assert.ok(["countdown", "racing"].includes(full.status)); ok("full lobby moved on to the countdown and the race by itself");

for (const s of crowd) s.disconnect(); D.disconnect();
await sleep(100);
console.log("\nMatchmaking checks passed.");
process.exit(0);
