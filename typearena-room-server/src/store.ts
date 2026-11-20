import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Look } from "./cosmetics.js";
import { START_RATING } from "./ratings.js";

export interface PublicUser { id: string; username: string; rating: number; games: number; wins: number; bestWpm: number; peakRating: number; look: Look | null }
export interface User extends PublicUser { passwordHash: string; createdAt: number }
export interface LeaderRow { rank: number; username: string; rating: number; games: number; wins: number; bestWpm: number }
export interface MatchRow { userId: string; delta: number; rank: number; players: number; wpm: number; accuracy: number; ratingBefore: number }
/** One finished rated match, as shown on a profile. */
export interface MatchHistoryRow { finishedAt: number; rank: number; players: number; wpm: number; accuracy: number; ratingBefore: number; ratingAfter: number }
/** One Solo Sprint run. These are reported by the browser, so they are practice history only and never count for ratings or the leaderboard. */
export interface SoloRun { mode: string; wpm: number; raw: number; accuracy: number; consistency: number | null; durationMs: number; errors: number }
export interface SoloRow extends SoloRun { at: number }
export interface SoloSummary { runs: number; recent: SoloRow[]; bests: Record<string, number>; avgLast10: number | null }

export const SOLO_MODES = ["passage", "10", "25", "50"];
const KEEP_SOLO_PER_USER = 500;

export const publicUser = (u: User): PublicUser => ({
  id: u.id, username: u.username, rating: u.rating, games: u.games, wins: u.wins, bestWpm: u.bestWpm, peakRating: u.peakRating, look: u.look,
});

/** Where accounts, sessions, results and history are kept. FileStore for local use, PgStore (Postgres) for hosting. */
export interface Store {
  init(): Promise<void>;
  createUser(username: string, passwordHash: string): Promise<User | null>; // null = username already taken (any capitalisation)
  findUserByName(username: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  createSession(userId: string, tokenHash: string, expiresAt: number): Promise<void>;
  userBySession(tokenHash: string): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  applyMatch(rows: MatchRow[]): Promise<void>;
  leaderboard(limit: number, minGames: number): Promise<LeaderRow[]>;
  rankOf(user: User): Promise<number | null>;                              // leaderboard position (null if no rated games yet)
  recentMatches(userId: string, limit: number): Promise<MatchHistoryRow[]>; // newest first
  setLook(userId: string, look: Look): Promise<void>;                        // the chosen world, colour, hat and trail
  addSolo(userId: string, run: SoloRun): Promise<void>;
  soloSummary(userId: string, recentLimit: number): Promise<SoloSummary>;
  close(): Promise<void>;
}

export function toLeaderboard(users: User[], limit: number, minGames: number): LeaderRow[] {
  return users
    .filter((u) => u.games >= minGames)
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.username.localeCompare(b.username))
    .slice(0, limit)
    .map((u, i) => ({ rank: i + 1, username: u.username, rating: u.rating, games: u.games, wins: u.wins, bestWpm: u.bestWpm }));
}

export const avgOfLast10 = (recent: SoloRow[]): number | null =>
  recent.length ? Math.round((recent.slice(0, 10).reduce((a, r) => a + r.wpm, 0) / Math.min(10, recent.length)) * 10) / 10 : null;

interface MatchRecord extends MatchHistoryRow { userId: string }
interface SoloRecord extends SoloRow { userId: string }

/** Keeps everything in memory and, if a file path is given, saves it to that JSON file after every change. */
export class FileStore implements Store {
  private users = new Map<string, User>();
  private names = new Map<string, string>(); // lower-case username -> id
  private sessions = new Map<string, { userId: string; expiresAt: number }>();
  private matches: MatchRecord[] = [];
  private solo: SoloRecord[] = [];
  private soloBests = new Map<string, Record<string, number>>();
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(private path?: string) {}

  async init(): Promise<void> {
    if (!this.path || !existsSync(this.path)) return;
    const data = JSON.parse(await readFile(this.path, "utf8"));
    for (const u of data.users ?? []) { u.peakRating = Math.max(u.peakRating ?? START_RATING, u.rating); u.look = u.look ?? null; this.users.set(u.id, u); this.names.set(u.username.toLowerCase(), u.id); }
    for (const s of data.sessions ?? []) if (s.expiresAt > Date.now()) this.sessions.set(s.tokenHash, s);
    this.matches = data.matches ?? [];
    this.solo = data.solo ?? [];
    for (const [id, b] of Object.entries<Record<string, number>>(data.soloBests ?? {})) this.soloBests.set(id, b);
  }

  private save(): void {
    if (!this.path) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 150);
  }
  /** Write now (used on shutdown and in tests). */
  async flush(): Promise<void> {
    if (!this.path) return;
    clearTimeout(this.timer);
    const path = this.path;
    const body = JSON.stringify({
      users: [...this.users.values()],
      sessions: [...this.sessions].map(([tokenHash, s]) => ({ tokenHash, ...s })),
      matches: this.matches, solo: this.solo, soloBests: Object.fromEntries(this.soloBests),
    });
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path + ".tmp", body);
      await rename(path + ".tmp", path); // never leaves a half-written file behind
    });
    await this.writing;
  }

  async createUser(username: string, passwordHash: string): Promise<User | null> {
    const key = username.toLowerCase();
    if (this.names.has(key)) return null;
    const user: User = { id: randomUUID(), username, passwordHash, rating: START_RATING, games: 0, wins: 0, bestWpm: 0, peakRating: START_RATING, look: null, createdAt: Date.now() };
    this.users.set(user.id, user); this.names.set(key, user.id); this.save();
    return { ...user };
  }
  async findUserByName(username: string): Promise<User | null> {
    const id = this.names.get(username.toLowerCase());
    return id ? { ...this.users.get(id)! } : null;
  }
  async getUser(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async createSession(userId: string, tokenHash: string, expiresAt: number): Promise<void> {
    this.sessions.set(tokenHash, { userId, expiresAt }); this.save();
  }
  async userBySession(tokenHash: string): Promise<User | null> {
    const s = this.sessions.get(tokenHash);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(tokenHash); return null; }
    return this.getUser(s.userId);
  }
  async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); this.save(); }

  async applyMatch(rows: MatchRow[]): Promise<void> {
    for (const r of rows) {
      const u = this.users.get(r.userId);
      if (!u) continue;
      u.rating = Math.max(0, u.rating + r.delta);
      u.peakRating = Math.max(u.peakRating, u.rating);
      u.games += 1;
      if (r.rank === 1) u.wins += 1;
      u.bestWpm = Math.max(u.bestWpm, r.wpm);
      this.matches.push({ userId: r.userId, finishedAt: Date.now(), rank: r.rank, players: r.players, wpm: r.wpm, accuracy: r.accuracy, ratingBefore: r.ratingBefore, ratingAfter: u.rating });
    }
    if (this.matches.length > 20_000) this.matches = this.matches.slice(-20_000);
    this.save();
  }
  async leaderboard(limit: number, minGames: number): Promise<LeaderRow[]> {
    return toLeaderboard([...this.users.values()], limit, minGames);
  }
  async rankOf(user: User): Promise<number | null> {
    if (user.games < 1) return null;
    return 1 + [...this.users.values()].filter((u) => u.games >= 1 && u.rating > user.rating).length;
  }
  async recentMatches(userId: string, limit: number): Promise<MatchHistoryRow[]> {
    return this.matches.filter((m) => m.userId === userId).slice(-limit).reverse().map(({ userId: _u, ...m }) => m);
  }

  async setLook(userId: string, look: Look): Promise<void> {
    const u = this.users.get(userId); if (!u) return;
    u.look = { ...look }; this.save();
  }

  async addSolo(userId: string, run: SoloRun): Promise<void> {
    this.solo.push({ userId, at: Date.now(), ...run });
    const mine = this.solo.filter((r) => r.userId === userId);
    if (mine.length > KEEP_SOLO_PER_USER) { const drop = new Set(mine.slice(0, mine.length - KEEP_SOLO_PER_USER)); this.solo = this.solo.filter((r) => !drop.has(r)); }
    const bests = this.soloBests.get(userId) ?? {};
    bests[run.mode] = Math.max(bests[run.mode] ?? 0, run.wpm);
    this.soloBests.set(userId, bests);
    this.save();
  }
  async soloSummary(userId: string, recentLimit: number): Promise<SoloSummary> {
    const mine = this.solo.filter((r) => r.userId === userId);
    const recent = mine.slice(-recentLimit).reverse().map(({ userId: _u, ...r }) => r);
    return { runs: mine.length, recent, bests: { ...(this.soloBests.get(userId) ?? {}) }, avgLast10: avgOfLast10(mine.slice().reverse().slice(0, 10).map(({ userId: _u, ...r }) => r)) };
  }
  async close(): Promise<void> { await this.flush(); }
}
