// The race scene engine: runs a simulated race against a real 2D canvas (the optional @napi-rs/canvas package).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (m: string) => console.log("  ok  " + m);
let canvasLib: any;
const canvasName = "@napi-rs/canvas"; // a variable, so a missing optional package is not a type error
try { canvasLib = await import(canvasName); } catch { console.log("  (skipping scene tests: the optional package @napi-rs/canvas is not installed)"); process.exit(0); }
const scenePath = "../public/scene.js";
await import(scenePath);
const { createScene } = (globalThis as any).TypeScene;
const make = (w: number, h: number) => canvasLib.createCanvas(w, h);

// ---- no canvas support: a harmless stub ----
{
  const stub = createScene({ getContext: () => null }, {});
  assert.equal(stub.supported, false); stub.start(); stub.stop(); stub.frame(0.016); stub.stumble("x"); assert.equal(stub.summary(), "");
  ok("without canvas support the scene is a harmless no-op");
}

// ---- a simulated race with overtakes ----
function simulate(n: number, seconds: number) {
  const canvas = make(680, 300);
  const players = Array.from({ length: n }, (_, i) => ({ id: i === 0 ? "me" : "p" + i, name: i === 0 ? "You" : "Runner" + i, me: i === 0, bot: i % 3 === 2, pct: 0, wpm: 0, finished: false, finishMs: null as number | null, v: 0.045 * (1 + 0.12 * Math.sin(i * 1.7)) }));
  const clock = { t: 0, running: false };
  const scene = createScene(canvas, { makeCanvas: make, getData: () => ({ running: clock.running, refWpm: players[0].wpm, players }) });
  scene.resize(680, 300, 1);
  const dt = 1 / 60; let maxFights = 0, fightFrames = 0, burstSeen = false, maxInFightPerRunner = 0, orderViolations = 0;
  for (let f = 0; f < 60 * seconds; f++) {
    clock.t += dt; if (clock.t > 1) clock.running = true;
    if (clock.running) players.forEach((p, i) => {
      if (p.finished) return;
      const k = 1 + 0.4 * Math.sin(clock.t * (0.7 + i * 0.17) + i);
      p.pct = Math.min(100, p.pct + p.v * 100 * dt * k); p.wpm = p.v * 1200 * k;
      if (p.pct >= 100) { p.finished = true; p.finishMs = clock.t * 1000 + i; p.wpm = 0; }
    });
    scene.frame(dt);
    const d = scene._debug();
    maxFights = Math.max(maxFights, d.fights.length); if (d.fights.length) fightFrames++; if (d.bursts.length) burstSeen = true;
    const inFight = new Map<any, number>(); d.fights.forEach((fi: any) => { inFight.set(fi.a, (inFight.get(fi.a) ?? 0) + 1); inFight.set(fi.b, (inFight.get(fi.b) ?? 0) + 1); });
    inFight.forEach((c) => (maxInFightPerRunner = Math.max(maxInFightPerRunner, c)));
    const rs = Object.values(d.runners) as any[];
    rs.forEach((r) => { assert.ok(Number.isFinite(r.px) && Number.isFinite(r.dx) && Number.isFinite(r.dy) && Number.isFinite(r.phase), "no NaN positions"); });
    for (const a of rs) for (const b of rs) { // fights are for show: a runner who is clearly further ahead is never drawn behind
      const pa = players.find((p) => p.id === a.id)!, pb = players.find((p) => p.id === b.id)!;
      if (pa.pct > pb.pct + 8 && a.px + 0.02 < b.px) orderViolations++;
    }
  }
  return { scene, canvas, players, maxFights, fightFrames, burstSeen, maxInFightPerRunner, orderViolations };
}
const r5 = simulate(5, 30);
assert.ok(r5.fightFrames > 0 && r5.burstSeen); ok("overtakes trigger fights with hit bursts");
assert.ok(r5.maxFights <= 3 && r5.maxInFightPerRunner <= 1); ok("at most 3 fights at once, and a runner is never in two fights at the same time");
assert.equal(r5.orderViolations, 0); ok("fights never change who is ahead: positions follow the real progress");
assert.ok(r5.players.every((p) => p.finished)); assert.ok(Object.values(r5.scene._debug().runners).every((r: any) => r.px > 0.999)); ok("every runner ends exactly at the finish line");
assert.ok(r5.canvas.toBuffer("image/png").length > 5000); ok("frames render to a real image");
assert.match(r5.scene.summary(), /^You are in (1st|2nd|3rd|4th|5th) place of 5\.$/); ok('summary for screen readers: "' + r5.scene.summary() + '"');
const r10 = simulate(10, 40); assert.ok(r10.maxFights <= 3 && r10.orderViolations === 0); ok("10 players work too");

// ---- ordinals, changing players, unknown ids ----
{
  const canvas = make(340, 150), ps = Array.from({ length: 12 }, (_, i) => ({ id: "q" + i, name: "Q" + i, me: i === 11, bot: false, pct: i * 5, wpm: 40, finished: false }));
  const scene = createScene(canvas, { makeCanvas: make, getData: () => ({ running: true, refWpm: 40, players: ps }) });
  scene.resize(340, 150, 2); for (let i = 0; i < 30; i++) scene.frame(1 / 60);
  assert.equal(scene.summary(), "You are in 1st place of 12.");
  ps.reverse(); ps.forEach((p, i) => (p.pct = i * 3)); for (let i = 0; i < 300; i++) scene.frame(1 / 60);
  assert.match(scene.summary(), /^You are in \d+(st|nd|rd|th) place of 12\.$/);
  ps.splice(5); for (let i = 0; i < 10; i++) scene.frame(1 / 60); scene.stumble("nobody"); scene.setStreak("nobody", 9); scene.stumble("q0");
  ok("players leaving mid-race, a small high-density phone canvas and unknown ids are all handled");
}
// ---- worlds, hats, trails and colours ----
{
  const WORLDS = ["dusk", "snow", "neon", "space"], HATS = ["none", "cap", "headband", "tophat", "wizard", "halo"], TRAILS = ["lines", "sparkles", "flames", "ribbon", "lightning"];
  const COLORS = ["lime", "aqua", "coral", "violet", "amber", "pink", "gold", "rainbow"];
  const pictures = new Map<string, number>();
  for (const world of WORLDS) {
    const canvas = make(680, 300);
    const players = Array.from({ length: 6 }, (_, i) => ({ id: "w" + i, name: "W" + i, me: i === 0, bot: false, pct: 10 + i * 12, wpm: 70, finished: i === 5, finishMs: 9000, look: { color: COLORS[i], hat: HATS[i], trail: TRAILS[i % 5] } }));
    const scene = createScene(canvas, { world, makeCanvas: make, getData: () => ({ running: true, refWpm: 70, players }) });
    scene.resize(680, 300, 1); for (let i = 0; i < 180; i++) scene.frame(1 / 60);
    assert.equal(scene.getWorld(), world);
    const png = canvas.toBuffer("image/png"); assert.ok(png.length > 8000, world + " draws a real picture"); pictures.set(world, png.length);
  }
  assert.equal(new Set(pictures.values()).size, 4); ok("all four worlds draw, and each looks different");
  for (const hat of HATS) for (const trail of TRAILS) for (const color of COLORS) {
    const canvas = make(300, 150), ps = [{ id: "a", name: "A", me: true, bot: false, pct: 40, wpm: 80, look: { color, hat, trail } }, { id: "b", name: "B", me: false, bot: false, pct: 35, wpm: 70, look: { color: "aqua", hat, trail } }];
    const scene = createScene(canvas, { world: "space", makeCanvas: make, getData: () => ({ running: true, refWpm: 80, players: ps }) });
    scene.resize(300, 150, 1); for (let i = 0; i < 6; i++) scene.frame(1 / 60);
  }
  ok("every hat, trail and colour (including animated rainbow) draws without errors (" + HATS.length * TRAILS.length * COLORS.length + " combinations)");
  const canvas = make(400, 200), ps = [{ id: "a", name: "A", me: true, bot: false, pct: 30, wpm: 60 }];
  const scene = createScene(canvas, { world: "dusk", makeCanvas: make, getData: () => ({ running: true, refWpm: 60, players: ps }) });
  scene.resize(400, 200, 1); scene.frame(1 / 60); scene.setWorld("snow"); assert.equal(scene.getWorld(), "snow"); scene.frame(1 / 60);
  scene.setWorld("atlantis"); assert.equal(scene.getWorld(), "snow"); scene.setWorld("space"); scene.frame(1 / 60); assert.equal(scene.getWorld(), "space");
  ok("the world can be switched while running, and an unknown world is ignored");
}
const dir = mkdtempSync(join(tmpdir(), "scene-")); writeFileSync(join(dir, "x.png"), r5.canvas.toBuffer("image/png")); rmSync(dir, { recursive: true });
console.log("\nScene checks passed.");
process.exit(0);
