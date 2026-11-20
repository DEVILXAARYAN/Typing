import { randomBytes, randomInt } from "node:crypto";
import { pickBotNames, planBotRun } from "./bots.js";
import {
  LogEntry, PASSAGES, accuracyOf, correctCount, isComplete, normalize,
  progressPct, replay, scoreOf, splitWords, wpmOf,
} from "./scoring.js";
import type { Look } from "./cosmetics.js";
import { START_RATING, computeRatingChanges } from "./ratings.js";

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = Number(process.env.MIN_PLAYERS ?? 2);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const MAX_LOG = 5000;

export type Status = "lobby" | "countdown" | "racing" | "results";

export interface PlayerResult {
  wpm: number; accuracy: number; score: number; timeMs: number; errors: number;
  verified: boolean; note?: string;
}
export interface Player {
  id: string; name: string; connected: boolean;
  pct: number; liveWpm: number; finished: boolean;
  result?: PlayerResult; rank?: number;
  userId?: string; rating?: number; games?: number; // set for signed-in players
  look?: Look;                                      // their chosen colour, hat and trail (checked against their peak rating)
  ratingChange?: number;                           // set when a rated match ends
  bot?: boolean;                                   // a computer player
  botLog?: LogEntry[];                             // the keystrokes a bot will "type" (server-only)
  // Server-only bookkeeping. Never sent to browsers (see snapshot()).
  socketId?: string;          // the connection that currently owns this player
  graceTimer?: NodeJS.Timeout; // running while the player is away and may still come back
  disconnectedAt?: number;    // when the current connection dropped (during a race)
  offlineMs: number;          // time spent offline during this race
}
export interface Room {
  code: string; hostId: string; status: Status;
  players: Map<string, Player>;
  passage: string; words: string[]; startAt: number;
  createdAt: number;
  isPublic: boolean;   // public lobbies are filled by Quick match and start by themselves
  autoStartAt: number; // server time when a public lobby starts (0 = not scheduled yet)
  dirty: boolean;
  countdownTimer?: NodeJS.Timeout; raceTimer?: NodeJS.Timeout; tickTimer?: NodeJS.Timeout; autoTimer?: NodeJS.Timeout;
  botTimers?: NodeJS.Timeout[];
}
/** Who a signed-in player is (guests have none). */
export interface Ident { userId: string; rating: number; games: number; look?: Look }
export interface MatchUpdate { userId: string; delta: number; rank: number; players: number; wpm: number; accuracy: number; ratingBefore: number }
export interface Hooks {
  state(room: Room): void;    // send the full room state to everyone in the room
  progress(room: Room): void; // send live progress (about 5 times a second)
  matchEnded?(updates: MatchUpdate[]): void; // rated match finished: save the rating changes
}
export interface Options {
  passages?: string[]; countdownMs?: number; maxRaceMs?: number;
  publicWaitMs?: number; fullStartMs?: number; graceMs?: number;
  ratingWindow?: number; windowGrowthPerSec?: number;
  bots?: boolean; botFillTo?: number; botWaitMs?: number; botWpm?: [number, number];
}

type Fail = { ok: false; error: string };

export function cleanName(raw: unknown): string {
  const s = String(raw ?? "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 20);
  return s || "Player";
}

export class RoomManager {
  rooms = new Map<string, Room>();
  private byPlayer = new Map<string, string>(); // player id -> room code
  private passages: string[]; private countdownMs: number; private maxRaceMs: number;
  private publicWaitMs: number; private fullStartMs: number; private joinCutoffMs: number; private graceMs: number;
  private ratingWindow: number; private windowGrowth: number;
  private botsOn: boolean; private botFillTo: number; private botWaitMs: number; private botWpm: [number, number];

  constructor(private hooks: Hooks, opts: Options = {}) {
    this.passages = opts.passages ?? PASSAGES;
    this.countdownMs = opts.countdownMs ?? 3000;
    this.maxRaceMs = opts.maxRaceMs ?? 120_000;
    this.publicWaitMs = opts.publicWaitMs ?? Number(process.env.PUBLIC_WAIT_MS ?? 20_000); // how long a public lobby waits for more players
    this.fullStartMs = opts.fullStartMs ?? 5_000;                                          // start delay once a lobby is full
    this.joinCutoffMs = Math.min(1500, Math.floor(this.publicWaitMs / 3));
    // Quick match only joins a lobby whose average rating is within this window of yours. The window widens as the lobby gets older.
    this.ratingWindow = opts.ratingWindow ?? 150;
    this.windowGrowth = opts.windowGrowthPerSec ?? 25;
    // Bots fill the empty seats of public lobbies so a lone player is never left waiting. They are always marked as bots and never change ratings.
    this.botsOn = opts.bots ?? process.env.BOTS !== "off";
    this.botFillTo = Math.min(MAX_PLAYERS, opts.botFillTo ?? Number(process.env.BOT_FILL_TO ?? 6)); // bring a lobby up to this many players
    this.botWaitMs = opts.botWaitMs ?? Number(process.env.BOT_WAIT_MS ?? 10_000);                    // how long a lone player waits before the match starts with bots
    this.botWpm = opts.botWpm ?? [Number(process.env.BOT_MIN_WPM ?? 35), Number(process.env.BOT_MAX_WPM ?? 95)];
    this.graceMs = opts.graceMs ?? Number(process.env.RECONNECT_GRACE_MS ?? 30_000);       // how long a dropped player can come back
  }

  private roomOf(id: string): Room | undefined {
    const code = this.byPlayer.get(id);
    return code ? this.rooms.get(code) : undefined;
  }
  private newPlayer(id: string, name: unknown, sid?: string, ident?: Ident): Player {
    return {
      id, name: cleanName(name), connected: true, pct: 0, liveWpm: 0, finished: false, offlineMs: 0, socketId: sid,
      userId: ident?.userId, rating: ident?.rating, games: ident?.games, look: ident?.look,
    };
  }
  private resetPlayer(p: Player): void {
    Object.assign(p, { pct: 0, liveWpm: 0, finished: false, result: undefined, rank: undefined, ratingChange: undefined, offlineMs: 0, disconnectedAt: undefined });
  }
  /** Connected now, or away but still allowed to come back. */
  private active(p: Player): boolean { return p.connected || !!p.graceTimer; }
  /** The race is still waiting for this player. */
  private pending(p: Player): boolean { return !p.finished && (p.bot === true || this.active(p)); }
  private connectedCount(room: Room): number { return [...room.players.values()].filter((p) => !p.bot && p.connected).length; }

  private newCode(): string {
    for (;;) {
      let c = ""; for (let i = 0; i < 6; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  private makeRoom(id: string, name: unknown, isPublic: boolean, sid?: string, ident?: Ident): Room {
    const code = this.newCode();
    const room: Room = {
      code, hostId: id, status: "lobby", players: new Map([[id, this.newPlayer(id, name, sid, ident)]]),
      passage: "", words: [], startAt: 0, createdAt: Date.now(), isPublic, autoStartAt: 0, dirty: false,
    };
    this.rooms.set(code, room); this.byPlayer.set(id, code);
    return room;
  }

  create(id: string, name: unknown, sid?: string, ident?: Ident): Room {
    this.leave(id);
    return this.makeRoom(id, name, false, sid, ident);
  }

  /** Quick match: join the open public lobby closest to your rating, or open a new one. */
  quickMatch(id: string, name: unknown, sid?: string, ident?: Ident): Room {
    this.leave(id);
    const now = Date.now();
    const mine = ident?.rating ?? START_RATING; // guests count as a starting-rating player
    let best: Room | undefined, bestDist = Infinity;
    for (const r of this.rooms.values()) {
      if (!r.isPublic || r.status !== "lobby" || r.players.size >= MAX_PLAYERS) continue;
      if (r.autoStartAt && r.autoStartAt - now < this.joinCutoffMs) continue; // about to start, don't squeeze in
      const ps = [...r.players.values()];
      const avg = ps.reduce((sum, p) => sum + (p.rating ?? START_RATING), 0) / ps.length;
      const dist = Math.abs(avg - mine);
      if (dist > this.ratingWindow + this.windowGrowth * ((now - r.createdAt) / 1000)) continue; // too far apart (for now)
      if (dist < bestDist || (dist === bestDist && best && r.players.size > best.players.size)) { best = r; bestDist = dist; }
    }
    if (!best) {
      best = this.makeRoom(id, name, true, sid, ident);
    } else {
      best.players.set(id, this.newPlayer(id, name, sid, ident)); this.byPlayer.set(id, best.code);
    }
    this.scheduleAuto(best);
    return best;
  }

  /** Decide when a public lobby starts: wait for more players, but start at once (after a short delay) when full. */
  private scheduleAuto(room: Room): void {
    clearTimeout(room.autoTimer);
    const n = this.connectedCount(room);
    const now = Date.now();
    if (n < (this.botsOn ? 1 : MIN_PLAYERS)) { room.autoStartAt = 0; return; }
    const wait = this.botsOn && n === 1 ? this.botWaitMs : this.publicWaitMs; // a lone player gets bots sooner
    const target = n >= MAX_PLAYERS ? now + this.fullStartMs : now + wait;
    if (room.autoStartAt === 0 || target < room.autoStartAt) room.autoStartAt = target;
    room.autoTimer = setTimeout(() => this.begin(room), Math.max(0, room.autoStartAt - now));
  }

  join(id: string, name: unknown, rawCode: unknown, sid?: string, ident?: Ident): { ok: true; room: Room } | Fail {
    const code = String(rawCode ?? "").trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.isPublic) return { ok: false, error: "Room not found. Check the code and try again." };
    const existing = room.players.get(id);
    if (existing) { this.reattach(room, existing, sid); return { ok: true, room }; }
    if (room.status !== "lobby") return { ok: false, error: "This race has already started. Ask the host for a rematch." };
    if (room.players.size >= MAX_PLAYERS) return { ok: false, error: "This room is full (10 players)." };
    this.leave(id);
    room.players.set(id, this.newPlayer(id, name, sid, ident)); this.byPlayer.set(id, code);
    return { ok: true, room };
  }

  // ---- connection loss and reconnecting ----

  /** A player came back (new connection, same player id): give them their seat again. */
  private reattach(room: Room, p: Player, sid?: string): void {
    clearTimeout(p.graceTimer); p.graceTimer = undefined;
    if (p.disconnectedAt) { p.offlineMs += Date.now() - p.disconnectedAt; p.disconnectedAt = undefined; }
    p.connected = true;
    if (sid) p.socketId = sid;
    if (room.isPublic && room.status === "lobby") this.scheduleAuto(room);
  }

  /** Called when a browser connects: if this player is still in a room, put them back in it. */
  attach(id: string, sid: string): Room | undefined {
    const room = this.roomOf(id);
    const p = room?.players.get(id);
    if (!room || !p) return undefined;
    this.reattach(room, p, sid);
    return room;
  }

  /** A connection dropped. Keep the seat for a while so a refresh or a network blip does not cost the player their race. */
  disconnect(id: string, sid: string): void {
    const room = this.roomOf(id);
    const p = room?.players.get(id);
    if (!room || !p || p.socketId !== sid) return; // a newer connection already owns this player
    p.connected = false;
    if (room.status === "countdown" || room.status === "racing") p.disconnectedAt = Date.now();
    clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => { p.graceTimer = undefined; this.leave(id); }, this.graceMs);
    if (room.isPublic && room.status === "lobby") this.scheduleAuto(room);
    this.hooks.state(room);
  }

  /** The player is really gone: they left on purpose, or did not come back in time. */
  leave(id: string): void {
    const room = this.roomOf(id);
    this.byPlayer.delete(id);
    if (!room) return;
    const p = room.players.get(id);
    if (!p) return;
    clearTimeout(p.graceTimer); p.graceTimer = undefined;
    if (room.status === "lobby" || room.status === "results") room.players.delete(id);
    else p.connected = false; // keep the seat so the player still appears in the results
    const active = [...room.players.values()].filter((x) => !x.bot && this.active(x));
    if (active.length === 0) return this.destroy(room);
    if (room.hostId === id) room.hostId = (active.find((x) => x.connected) ?? active[0]).id;
    if (room.status === "racing" && ![...room.players.values()].some((x) => this.pending(x))) return this.endMatch(room);
    if (room.isPublic && room.status === "lobby") this.scheduleAuto(room);
    this.hooks.state(room);
  }

  // ---- match flow ----

  start(id: string): Fail | { ok: true } {
    const room = this.roomOf(id);
    if (!room) return { ok: false, error: "You are not in a room." };
    if (room.isPublic) return { ok: false, error: "Public lobbies start by themselves when enough players have joined." };
    if (room.hostId !== id) return { ok: false, error: "Only the host can start the match." };
    if (room.status !== "lobby") return { ok: false, error: "The match has already started." };
    if (this.connectedCount(room) < MIN_PLAYERS) return { ok: false, error: `You need at least ${MIN_PLAYERS} players to start.` };
    this.begin(room);
    return { ok: true };
  }

  /** Pick a passage and run the countdown, then the race. */
  private begin(room: Room): void {
    if (room.status !== "lobby") return;
    clearTimeout(room.autoTimer); room.autoStartAt = 0;
    room.passage = this.passages[randomInt(this.passages.length)];
    room.words = splitWords(room.passage);
    if (room.isPublic && this.botsOn) this.addBots(room);
    for (const p of room.players.values()) this.resetPlayer(p);
    room.status = "countdown";
    room.startAt = Date.now() + this.countdownMs;
    this.hooks.state(room);
    room.countdownTimer = setTimeout(() => {
      room.status = "racing";
      this.hooks.state(room);
      room.botTimers = [];
      for (const p of room.players.values()) {
        if (!p.bot || !p.botLog) continue;
        const log = p.botLog, lastT = log[log.length - 1][0];
        room.botTimers.push(setTimeout(() => this.finishPlayer(room, p, log), lastT + 20)); // the bot "finishes" like anyone else
      }
      room.tickTimer = setInterval(() => {
        this.tickBots(room);
        if (room.dirty) { room.dirty = false; this.hooks.progress(room); }
      }, 200);
      room.raceTimer = setTimeout(() => this.endMatch(room), this.maxRaceMs);
    }, this.countdownMs);
  }

  /** The only human in a public lobby can skip the wait and start now, with bots in the empty seats. */
  startNow(id: string): Fail | { ok: true } {
    const room = this.roomOf(id);
    if (!room) return { ok: false, error: "You are not in a room." };
    if (!room.isPublic || !this.botsOn) return { ok: false, error: "Start now is only available in public lobbies with bots." };
    if (room.status !== "lobby") return { ok: false, error: "The match has already started." };
    if (this.connectedCount(room) !== 1) return { ok: false, error: "Start now is only for a lobby where you are the only player." };
    this.begin(room);
    return { ok: true };
  }

  /** Fill empty seats of a public lobby with bots (up to botFillTo players in total). */
  private addBots(room: Room): void {
    const need = Math.min(MAX_PLAYERS, this.botFillTo) - room.players.size;
    if (need <= 0) return;
    const [lo, hi] = this.botWpm;
    pickBotNames(need).forEach((name) => {
      const id = "bot-" + randomBytes(4).toString("hex");
      const wpm = lo + Math.random() * Math.max(0, hi - lo);
      const errRate = 0.01 + Math.random() * 0.04;
      const p = this.newPlayer(id, name);
      p.bot = true; p.botLog = planBotRun(room.passage, wpm, errRate);
      room.players.set(id, p); // bots have no connection, so they are not in byPlayer
    });
  }

  /** Move the bots' progress forward for the live leaderboard. */
  private tickBots(room: Room): void {
    const ms = Date.now() - room.startAt;
    for (const p of room.players.values()) {
      if (!p.bot || p.finished || !p.botLog) continue;
      const r = replay(p.botLog.filter((e) => e[0] <= ms), room.words);
      p.pct = progressPct(r.typed, room.passage);
      p.liveWpm = wpmOf(correctCount(r.typed, room.words), ms);
      room.dirty = true;
    }
  }

  /** Live progress for the leaderboard. Display only: the final result comes from finish(). */
  progress(id: string, typed: unknown): void {
    const room = this.roomOf(id);
    const p = room?.players.get(id);
    if (!room || !p || room.status !== "racing" || p.finished) return;
    if (typeof typed !== "string" || typed.length > 2000) return;
    const t = normalize(typed, room.words);
    const ms = Date.now() - room.startAt;
    p.pct = progressPct(t, room.passage);
    p.liveWpm = wpmOf(correctCount(t, room.words), ms);
    room.dirty = true;
  }

  finish(id: string, rawLog: unknown): Fail | { ok: true } {
    const room = this.roomOf(id);
    const p = room?.players.get(id);
    if (!room || !p) return { ok: false, error: "You are not in a room." };
    return this.finishPlayer(room, p, rawLog);
  }

  private finishPlayer(room: Room, p: Player, rawLog: unknown): Fail | { ok: true } {
    if (room.status !== "racing") return { ok: false, error: "No race is running." };
    if (p.finished) return { ok: true };
    if (!Array.isArray(rawLog) || rawLog.length > MAX_LOG) return { ok: false, error: "Invalid keystroke log." };
    const r = replay(rawLog as LogEntry[], room.words);
    if (!r.valid || !isComplete(r.typed, room.words)) return { ok: false, error: "The keystroke log does not complete the passage." };

    const now = Date.now();
    const serverMs = now - room.startAt;
    // A player who lost their connection mid-race may deliver the result late. Allow for the time they were offline.
    const offline = Math.min(p.offlineMs + (p.disconnectedAt ? now - p.disconnectedAt : 0), this.graceMs);
    const lag = serverMs - r.lastT; // how much later the server heard about the finish than the browser's own clock says
    const timeMs = offline > 0 ? Math.max(r.lastT, serverMs - offline, 1) : serverMs;
    const wpm = wpmOf(correctCount(r.typed, room.words), Math.max(timeMs, 1000));
    const accuracy = accuracyOf(r.total, r.errors);
    const notes: string[] = [];
    if (lag > 3000 + offline || lag < -3000) notes.push("timing mismatch");
    if (wpm > 400) notes.push("implausible speed");
    if (r.lastT / Math.max(1, rawLog.length) < 25) notes.push("inhuman keystroke speed");
    const verified = notes.length === 0;
    p.finished = true; p.pct = 100; p.liveWpm = wpm;
    p.result = { wpm, accuracy, score: verified ? scoreOf(wpm, accuracy) : 0, timeMs, errors: r.errors, verified, note: notes.join(", ") || undefined };
    room.dirty = true;
    if (![...room.players.values()].some((x) => this.pending(x))) this.endMatch(room);
    else this.hooks.state(room);
    return { ok: true };
  }

  private endMatch(room: Room): void {
    if (room.status === "results") return;
    clearTimeout(room.countdownTimer); clearTimeout(room.raceTimer); clearInterval(room.tickTimer);
    room.botTimers?.forEach(clearTimeout);
    room.status = "results";
    const tier = (p: Player) => (p.result?.verified ? 0 : p.finished ? 1 : 2);
    [...room.players.values()]
      .sort((a, b) => tier(a) - tier(b)
        || (b.result?.score ?? 0) - (a.result?.score ?? 0)
        || (b.result?.accuracy ?? 0) - (a.result?.accuracy ?? 0)
        || b.pct - a.pct)
      .forEach((p, i) => (p.rank = i + 1));
    const updates = this.applyRatings(room);
    this.hooks.state(room);
    if (updates.length) this.hooks.matchEnded?.(updates);
  }

  /**
   * Public lobbies are rated. Only signed-in players have a rating; guests still race and rank but are left out of the maths.
   * Results the server could not verify are also left out. A player who did not finish counts as last.
   */
  private applyRatings(room: Room): MatchUpdate[] {
    if (!room.isPublic) return [];
    const eligible = [...room.players.values()]
      .filter((p) => p.userId !== undefined && p.rating !== undefined && !(p.finished && p.result && !p.result.verified))
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    if (eligible.length < 2) return [];
    const changes = computeRatingChanges(eligible.map((p, i) => ({ id: p.id, rating: p.rating!, games: p.games ?? 0, rank: i + 1 })));
    return eligible.map((p) => {
      const delta = Math.max(-p.rating!, changes.get(p.id) ?? 0); // a rating never goes below 0
      p.ratingChange = delta;
      return { userId: p.userId!, delta, rank: p.rank!, players: room.players.size, wpm: p.result?.wpm ?? 0, accuracy: p.result?.accuracy ?? 0, ratingBefore: p.rating! };
    });
  }

  rematch(id: string): Fail | { ok: true } {
    const room = this.roomOf(id);
    if (!room) return { ok: false, error: "You are not in a room." };
    if (room.isPublic) return { ok: false, error: "Public matches have no rematch. Use Find new match." };
    if (room.hostId !== id) return { ok: false, error: "Only the host can start a rematch." };
    if (room.status !== "results") return { ok: false, error: "The match is not over yet." };
    for (const [pid, p] of room.players) if (!this.active(p)) room.players.delete(pid);
    for (const p of room.players.values()) this.resetPlayer(p);
    room.status = "lobby"; room.passage = ""; room.words = []; room.startAt = 0;
    this.hooks.state(room);
    return { ok: true };
  }

  private destroy(room: Room): void {
    clearTimeout(room.autoTimer); clearTimeout(room.countdownTimer); clearTimeout(room.raceTimer); clearInterval(room.tickTimer);
    room.botTimers?.forEach(clearTimeout);
    for (const p of room.players.values()) { clearTimeout(p.graceTimer); p.graceTimer = undefined; }
    this.rooms.delete(room.code);
  }

  /** What every client in the room is allowed to see (never the server-only fields). */
  snapshot(room: Room) {
    return {
      code: room.isPublic ? "" : room.code, // public lobbies have no shareable code
      isPublic: room.isPublic, rated: room.isPublic, botsOn: this.botsOn, autoStartAt: room.autoStartAt,
      hostId: room.hostId, status: room.status,
      maxPlayers: MAX_PLAYERS, minPlayers: MIN_PLAYERS,
      passage: room.status === "lobby" ? "" : room.passage,
      startAt: room.startAt, serverNow: Date.now(),
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, connected: p.connected, away: !p.connected && !!p.graceTimer,
        pct: p.pct, liveWpm: p.liveWpm, finished: p.finished, result: p.result, rank: p.rank,
        signedIn: p.userId !== undefined, rating: p.rating, ratingChange: p.ratingChange, bot: p.bot === true,
        look: p.look ? { color: p.look.color, hat: p.look.hat, trail: p.look.trail } : undefined,
      })),
    };
  }
}
