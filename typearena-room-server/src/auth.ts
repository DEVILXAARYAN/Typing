import express, { Express, Request } from "express";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { CATALOG, DEFAULT_LOOK, nextUnlock, sanitizeLook, validateLook } from "./cosmetics.js";
import { PublicUser, SOLO_MODES, SoloRun, Store, User, publicUser } from "./store.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SESSION_MS = 30 * 24 * 3600 * 1000; // stay signed in for 30 days
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Passwords are never stored: only a salted scrypt hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
const DUMMY_HASH = await hashPassword("not-a-real-password"); // so unknown usernames take as long to reject as wrong passwords

/** Look up the signed-in user for a session token (or null). */
export async function userFromSession(store: Store, token: unknown): Promise<PublicUser | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const u = await store.userBySession(sha256(token));
  return u ? publicUser(u) : null;
}

class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {
    setInterval(() => { const now = Date.now(); for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k); }, 600_000).unref();
  }
  blocked(key: string): boolean { const e = this.hits.get(key); return !!e && e.reset > Date.now() && e.n >= this.max; }
  hit(key: string): void {
    const now = Date.now(), e = this.hits.get(key);
    if (!e || e.reset < now) this.hits.set(key, { n: 1, reset: now + this.windowMs }); else e.n++;
  }
  clear(key: string): void { this.hits.delete(key); }
}

const bearer = (req: Request): string | undefined => {
  const h = req.headers.authorization;
  return h && h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
};

const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

/** Check a Solo Sprint result sent by the browser. The numbers are self-reported, so they only have to be plausible. */
function parseSolo(body: any): SoloRun | string {
  const bad = "That result does not look valid, so it was not saved.";
  if (!body || typeof body.mode !== "string" || !SOLO_MODES.includes(body.mode)) return bad;
  const wpm = num(body.wpm, 1, 300), raw = num(body.raw, 1, 400), accuracy = num(body.accuracy, 0, 100);
  const durationMs = num(body.durationMs, 1000, 600_000), errors = num(body.errors, 0, 1000);
  const consistency = body.consistency == null ? null : num(body.consistency, 0, 100);
  if (wpm === null || raw === null || accuracy === null || durationMs === null || errors === null || (body.consistency != null && consistency === null)) return bad;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { mode: body.mode, wpm: r1(wpm), raw: r1(raw), accuracy: r1(accuracy), consistency: consistency === null ? null : Math.round(consistency), durationMs: Math.round(durationMs), errors: Math.round(errors) };
}

const profileUser = (u: User) => ({ username: u.username, rating: u.rating, games: u.games, wins: u.wins, bestWpm: u.bestWpm, createdAt: u.createdAt });

export function registerAuthRoutes(app: Express, store: Store): void {
  const failedLogins = new Limiter(8, 10 * 60_000); // 8 wrong passwords per username and address per 10 minutes
  const signups = new Limiter(20, 3600_000);        // 20 new accounts per address per hour
  const soloSaves = new Limiter(60, 3600_000);      // 60 saved Solo Sprint runs per account per hour
  app.use("/api", express.json({ limit: "4kb" }));

  const startSession = async (res: express.Response, status: number, user: { id: string }, full: PublicUser) => {
    const token = randomBytes(32).toString("hex");
    await store.createSession(user.id, sha256(token), Date.now() + SESSION_MS);
    res.status(status).json({ token, user: full });
  };

  app.post("/api/register", async (req, res, next) => {
    try {
      const ip = req.ip ?? "?";
      if (signups.blocked(ip)) return res.status(429).json({ error: "Too many new accounts from this address. Try again later." });
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || !USERNAME_RE.test(username)) return res.status(400).json({ error: "Username must be 3 to 20 characters: letters, numbers and underscores." });
      if (typeof password !== "string" || password.length < 8 || password.length > 100) return res.status(400).json({ error: "Password must be at least 8 characters." });
      signups.hit(ip);
      const user = await store.createUser(username, await hashPassword(password));
      if (!user) return res.status(409).json({ error: "That username is taken." });
      await startSession(res, 201, user, publicUser(user));
    } catch (err) { next(err); }
  });

  app.post("/api/login", async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string" || password.length > 100) return res.status(400).json({ error: "Enter your username and password." });
      const key = `${req.ip}|${username.toLowerCase()}`;
      if (failedLogins.blocked(key)) return res.status(429).json({ error: "Too many wrong attempts. Wait a few minutes and try again." });
      const user = await store.findUserByName(username);
      const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) { failedLogins.hit(key); return res.status(401).json({ error: "Wrong username or password." }); }
      failedLogins.clear(key);
      await startSession(res, 200, user, publicUser(user));
    } catch (err) { next(err); }
  });

  app.post("/api/logout", async (req, res, next) => {
    try {
      const token = bearer(req);
      if (token) await store.deleteSession(sha256(token));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/api/me", async (req, res, next) => {
    try {
      const user = await userFromSession(store, bearer(req));
      if (!user) return res.status(401).json({ error: "Not signed in." });
      res.json({ user });
    } catch (err) { next(err); }
  });

  app.get("/api/leaderboard", async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      res.json({ players: await store.leaderboard(limit, 1) });
    } catch (err) { next(err); }
  });

  /** The signed-in account for a request, or null after replying 401. */
  const signedIn = async (req: Request, res: express.Response): Promise<User | null> => {
    const pub = await userFromSession(store, bearer(req));
    const user = pub ? await store.getUser(pub.id) : null;
    if (!user) res.status(401).json({ error: "Not signed in." });
    return user;
  };

  // The signed-in player's own profile: rated results, rating history and Solo Sprint history.
  app.get("/api/profile", async (req, res, next) => {
    try {
      const user = await signedIn(req, res); if (!user) return;
      const [rank, matches, solo] = await Promise.all([store.rankOf(user), store.recentMatches(user.id, 30), store.soloSummary(user.id, 20)]);
      res.json({ user: profileUser(user), rank, matches, solo });
    } catch (err) { next(err); }
  });

  // Anyone's public profile (rated results only; Solo Sprint history stays private).
  app.get("/api/users/:username", async (req, res, next) => {
    try {
      const name = String(req.params.username);
      const user = USERNAME_RE.test(name) ? await store.findUserByName(name) : null;
      if (!user) return res.status(404).json({ error: "Player not found." });
      const [rank, matches] = await Promise.all([store.rankOf(user), store.recentMatches(user.id, 30)]);
      res.json({ user: profileUser(user), rank, matches });
    } catch (err) { next(err); }
  });

  // Solo Sprint: save a finished run to the account, and read the saved history.
  app.post("/api/solo", async (req, res, next) => {
    try {
      const user = await signedIn(req, res); if (!user) return;
      if (soloSaves.blocked(user.id)) return res.status(429).json({ error: "You are saving runs very quickly. Try again in a little while." });
      const run = parseSolo(req.body);
      if (typeof run === "string") return res.status(400).json({ error: run });
      soloSaves.hit(user.id);
      await store.addSolo(user.id, run);
      res.status(201).json({ ok: true });
    } catch (err) { next(err); }
  });
  app.get("/api/solo", async (req, res, next) => {
    try {
      const user = await signedIn(req, res); if (!user) return;
      res.json(await store.soloSummary(user.id, 20));
    } catch (err) { next(err); }
  });

  // Worlds and looks. The catalog is public; a signed-in player also gets their peak rating, current look and next reward.
  app.get("/api/cosmetics", async (req, res, next) => {
    try {
      const pub = await userFromSession(store, bearer(req));
      const user = pub ? await store.getUser(pub.id) : null;
      const base = { catalog: CATALOG, defaults: DEFAULT_LOOK };
      if (!user) return res.json(base);
      res.json({ ...base, peakRating: user.peakRating, rating: user.rating, look: sanitizeLook(user.look, user.peakRating), next: nextUnlock(user.peakRating) });
    } catch (err) { next(err); }
  });
  app.put("/api/look", async (req, res, next) => {
    try {
      const user = await signedIn(req, res); if (!user) return;
      const v = validateLook(req.body, user.peakRating);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      await store.setLook(user.id, v.look);
      res.json({ look: v.look });
    } catch (err) { next(err); }
  });

  // JSON errors for the API (bad JSON, database trouble), never an HTML page
  app.use("/api", (err: any, _req: Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") return res.status(400).json({ error: "Bad request." });
    console.error("API error:", err?.message ?? err);
    res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
  });
}
