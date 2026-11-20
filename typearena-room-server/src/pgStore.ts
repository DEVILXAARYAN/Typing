import pg from "pg";
import { randomUUID } from "node:crypto";
import { START_RATING } from "./ratings.js";
import type { Look } from "./cosmetics.js";
import { avgOfLast10, type LeaderRow, type MatchHistoryRow, type MatchRow, type SoloRun, type SoloSummary, type Store, type User } from "./store.js";

const KEEP_SOLO_PER_USER = 500;

const toUser = (r: any): User => ({
  id: r.id, username: r.username, passwordHash: r.password_hash, rating: r.rating, games: r.games,
  wins: r.wins, bestWpm: Number(r.best_wpm), peakRating: Math.max(r.peak_rating ?? r.rating, r.rating), look: r.look ?? null, createdAt: new Date(r.created_at).getTime(),
});

/**
 * Providers such as Neon give a connection string ending in "sslmode=require". The pg library already treats that as
 * "verify-full" but prints a long warning about it on every start. Saying "verify-full" ourselves is the same
 * behaviour without the warning. Strings that ask for libpq behaviour (uselibpqcompat) are left alone.
 */
export const normalizeSslMode = (url: string): string =>
  /uselibpqcompat=/i.test(url) ? url : url.replace(/([?&]sslmode=)(require|prefer|verify-ca)(?=&|$)/i, "$1verify-full");

/** Postgres storage (works with Neon, Supabase, Render Postgres or any Postgres). Pass the DATABASE_URL connection string. */
export class PgStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    // sslmode in the connection string is honoured by pg. DATABASE_SSL=true/false overrides it.
    const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : process.env.DATABASE_SSL === "false" ? false : undefined;
    this.pool = new pg.Pool({ connectionString: normalizeSslMode(connectionString), ssl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000, keepAlive: true });
    // An idle connection can be closed by the database (Neon sleeps when idle). That must not crash the server.
    this.pool.on("error", (err) => console.error("Database connection error (it will reconnect):", err.message));
  }

  async init(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) { // the database may be waking up
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS users (
            id text PRIMARY KEY,
            username text NOT NULL,
            username_lower text NOT NULL UNIQUE,
            password_hash text NOT NULL,
            rating integer NOT NULL DEFAULT ${START_RATING},
            games integer NOT NULL DEFAULT 0,
            wins integer NOT NULL DEFAULT 0,
            best_wpm real NOT NULL DEFAULT 0,
            peak_rating integer NOT NULL DEFAULT ${START_RATING},
            look jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS sessions (
            token_hash text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at timestamptz NOT NULL
          );
          CREATE TABLE IF NOT EXISTS match_results (
            id bigserial PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            finished_at timestamptz NOT NULL DEFAULT now(),
            rank integer NOT NULL,
            players integer NOT NULL,
            wpm real NOT NULL,
            accuracy real NOT NULL,
            rating_before integer NOT NULL,
            rating_after integer NOT NULL
          );
          CREATE TABLE IF NOT EXISTS solo_results (
            id bigserial PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL DEFAULT now(),
            mode text NOT NULL,
            wpm real NOT NULL,
            raw_wpm real NOT NULL,
            accuracy real NOT NULL,
            consistency real,
            duration_ms integer NOT NULL,
            errors integer NOT NULL
          );
          CREATE TABLE IF NOT EXISTS solo_bests (
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            mode text NOT NULL,
            wpm real NOT NULL,
            PRIMARY KEY (user_id, mode)
          );
          -- databases created before worlds and looks existed get the new columns
          ALTER TABLE users ADD COLUMN IF NOT EXISTS peak_rating integer NOT NULL DEFAULT ${START_RATING};
          ALTER TABLE users ADD COLUMN IF NOT EXISTS look jsonb;
          UPDATE users SET peak_rating = rating WHERE peak_rating < rating;
          CREATE INDEX IF NOT EXISTS solo_results_user_idx ON solo_results (user_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS users_rating_idx ON users (rating DESC);
          CREATE INDEX IF NOT EXISTS match_results_user_idx ON match_results (user_id, finished_at DESC);
        `);
        return;
      } catch (err) {
        lastError = err;
        console.error(`Could not reach the database (attempt ${attempt} of 5):`, (err as Error).message);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastError;
  }

  async createUser(username: string, passwordHash: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, username, username_lower, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username_lower) DO NOTHING RETURNING *`,
      [randomUUID(), username, username.toLowerCase(), passwordHash],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }
  async findUserByName(username: string): Promise<User | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE username_lower = $1", [username.toLowerCase()]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async createSession(userId: string, tokenHash: string, expiresAt: number): Promise<void> {
    await this.pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))", [tokenHash, userId, expiresAt]);
  }
  async userBySession(tokenHash: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async applyMatch(rows: MatchRow[]): Promise<void> {
    if (!rows.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        const res = await client.query(
          `UPDATE users SET rating = GREATEST(0, rating + $2), peak_rating = GREATEST(peak_rating, GREATEST(0, rating + $2)), games = games + 1, wins = wins + $3, best_wpm = GREATEST(best_wpm, $4)
           WHERE id = $1 RETURNING rating`,
          [r.userId, r.delta, r.rank === 1 ? 1 : 0, r.wpm],
        );
        if (!res.rows[0]) continue;
        await client.query(
          `INSERT INTO match_results (user_id, rank, players, wpm, accuracy, rating_before, rating_after) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [r.userId, r.rank, r.players, r.wpm, r.accuracy, r.ratingBefore, res.rows[0].rating],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async leaderboard(limit: number, minGames: number): Promise<LeaderRow[]> {
    const { rows } = await this.pool.query(
      `SELECT username, rating, games, wins, best_wpm FROM users WHERE games >= $2
       ORDER BY rating DESC, games DESC, username ASC LIMIT $1`, [limit, minGames]);
    return rows.map((r, i) => ({ rank: i + 1, username: r.username, rating: r.rating, games: r.games, wins: r.wins, bestWpm: Number(r.best_wpm) }));
  }

  async rankOf(user: User): Promise<number | null> {
    if (user.games < 1) return null;
    const { rows } = await this.pool.query("SELECT 1 + count(*)::int AS rank FROM users WHERE games >= 1 AND rating > $1", [user.rating]);
    return rows[0].rank;
  }
  async recentMatches(userId: string, limit: number): Promise<MatchHistoryRow[]> {
    const { rows } = await this.pool.query(
      `SELECT finished_at, rank, players, wpm, accuracy, rating_before, rating_after FROM match_results
       WHERE user_id = $1 ORDER BY finished_at DESC, id DESC LIMIT $2`, [userId, limit]);
    return rows.map((r) => ({
      finishedAt: new Date(r.finished_at).getTime(), rank: r.rank, players: r.players, wpm: Number(r.wpm),
      accuracy: Number(r.accuracy), ratingBefore: r.rating_before, ratingAfter: r.rating_after,
    }));
  }

  async setLook(userId: string, look: Look): Promise<void> {
    await this.pool.query("UPDATE users SET look = $2::jsonb WHERE id = $1", [userId, JSON.stringify(look)]);
  }

  async addSolo(userId: string, run: SoloRun): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO solo_results (user_id, mode, wpm, raw_wpm, accuracy, consistency, duration_ms, errors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, run.mode, run.wpm, run.raw, run.accuracy, run.consistency, Math.round(run.durationMs), run.errors]);
      await client.query(
        `INSERT INTO solo_bests (user_id, mode, wpm) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, mode) DO UPDATE SET wpm = GREATEST(solo_bests.wpm, EXCLUDED.wpm)`, [userId, run.mode, run.wpm]);
      await client.query( // keep the newest runs only; the personal bests are stored separately so they are never lost
        `DELETE FROM solo_results WHERE user_id = $1 AND id NOT IN
           (SELECT id FROM solo_results WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${KEEP_SOLO_PER_USER})`, [userId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async soloSummary(userId: string, recentLimit: number): Promise<SoloSummary> {
    const [recent, count, bests] = await Promise.all([
      this.pool.query(
        `SELECT created_at, mode, wpm, raw_wpm, accuracy, consistency, duration_ms, errors FROM solo_results
         WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, recentLimit]),
      this.pool.query("SELECT count(*)::int AS n FROM solo_results WHERE user_id = $1", [userId]),
      this.pool.query("SELECT mode, wpm FROM solo_bests WHERE user_id = $1", [userId]),
    ]);
    const rows = recent.rows.map((r) => ({
      at: new Date(r.created_at).getTime(), mode: r.mode, wpm: Number(r.wpm), raw: Number(r.raw_wpm), accuracy: Number(r.accuracy),
      consistency: r.consistency == null ? null : Number(r.consistency), durationMs: r.duration_ms, errors: r.errors,
    }));
    return { runs: count.rows[0].n, recent: rows, bests: Object.fromEntries(bests.rows.map((b) => [b.mode, Number(b.wpm)])), avgLast10: avgOfLast10(rows) };
  }

  /** Empties all tables. Only for tests. */
  async _reset(): Promise<void> { await this.pool.query("TRUNCATE match_results, solo_results, solo_bests, sessions, users"); }

  async close(): Promise<void> { await this.pool.end(); }
}
