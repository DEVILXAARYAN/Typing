// Scoring rules. The server uses these to verify results; public/index.html has the
// same word-based rules for the browser (later we can share one copy of this file).

export const MAX_EXTRA = 10; // extra letters allowed after the end of a word

export const PASSAGES = [
  "Every champion was once a beginner who refused to stop typing. Speed is built one clean keystroke at a time.",
  "The fastest typists are not the ones who rush. They keep a steady rhythm, look ahead of the cursor, and let accuracy carry them forward.",
  "Rain tapped softly on the window while the keyboard clicked like a small drum. By midnight the whole story was finished and the coffee was cold.",
  "A good race is won in the first ten seconds and saved in the last ten. Stay calm, breathe out, and trust the practice you have already done.",
  "Distant mountains turned gold as the morning train crossed the river. Passengers opened their laptops and the carriage filled with quiet typing.",
  "Learning a new skill feels slow until the day it suddenly feels easy. Keep showing up, and your fingers will remember what your mind forgot.",
];

export const splitWords = (text: string): string[] => text.split(" ");

/** Same input rules as the browser: no leading or double spaces, no extra words, capped extra letters. */
export function normalize(value: string, words: string[]): string {
  const parts = value.replace(/^ +/, "").replace(/ {2,}/g, " ").split(" ");
  if (parts.length > words.length) parts.length = words.length;
  const last = parts.length - 1;
  parts[last] = parts[last].slice(0, words[last].length + MAX_EXTRA);
  return parts.join(" ");
}

/** Correct characters. A space after a fully correct word counts as one more. */
export function correctCount(typed: string, words: string[]): number {
  const parts = typed.split(" ");
  let n = 0;
  for (let w = 0; w < parts.length && w < words.length; w++) {
    const t = parts[w], word = words[w];
    for (let i = 0; i < t.length && i < word.length; i++) if (t[i] === word[i]) n++;
    if (w < parts.length - 1 && t === word) n++;
  }
  return n;
}

/** Finished = the last word has been typed to its full length. */
export function isComplete(typed: string, words: string[]): boolean {
  const parts = typed.split(" ");
  return parts.length === words.length && parts[parts.length - 1].length >= words[words.length - 1].length;
}

export const progressPct = (typed: string, text: string): number =>
  Math.min(100, Math.round((typed.length / text.length) * 100));

export const wpmOf = (correct: number, ms: number): number =>
  ms >= 1000 ? Math.round((correct / 5 / (ms / 60000)) * 10) / 10 : 0;

export const accuracyOf = (total: number, errors: number): number =>
  total ? Math.round(((total - errors) / total) * 1000) / 10 : 100;

/** Ranking score: speed matters, but mistakes cost a lot. */
export const scoreOf = (wpm: number, accuracy: number): number =>
  Math.round(wpm * (accuracy / 100) ** 2 * 10) / 10;

export type LogEntry = [t: number, key: string]; // key is one character, or "\b" for backspace

export interface Replay {
  typed: string;
  total: number;
  errors: number;
  lastT: number;
  valid: boolean;
}

/** Rebuild what the player typed from their keystroke log (the server never trusts a claimed result). */
export function replay(log: LogEntry[], words: string[]): Replay {
  let s = "", total = 0, errors = 0, lastT = 0;
  for (const entry of log) {
    if (!Array.isArray(entry) || typeof entry[0] !== "number" || typeof entry[1] !== "string") {
      return { typed: s, total, errors, lastT, valid: false };
    }
    const [t, key] = entry;
    if (!Number.isFinite(t) || t < lastT || key.length !== 1) return { typed: s, total, errors, lastT, valid: false };
    lastT = t;
    if (isComplete(s, words)) break;
    if (key === "\b") { s = s.slice(0, -1); continue; }
    const next = normalize(s + key, words);
    if (next.length <= s.length) continue; // the browser would have ignored this key too
    const wi = s.split(" ").length - 1;
    const cur = s.slice(s.lastIndexOf(" ") + 1);
    const word = words[wi] ?? "";
    total++;
    if (key === " ") { if (cur.length < word.length) errors++; }
    else if (!(cur.length < word.length && key === word[cur.length])) errors++;
    s = next;
  }
  return { typed: s, total, errors, lastT, valid: true };
}
