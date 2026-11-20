import type { LogEntry } from "./scoring.js";

const NAMES = ["Aria", "Milo", "Zara", "Kai", "Luna", "Orion", "Nova", "Finn", "Maya", "Leo", "Ivy", "Arlo", "Juno", "Rex", "Sage", "Tara", "Nico", "Esha", "Ravi", "Mira"];

/** n different bot names, in random order. */
export function pickBotNames(n: number): string[] {
  const pool = [...NAMES];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * A bot "types" like a person: it reacts after the countdown, keeps an uneven rhythm, pauses between words now
 * and then, and sometimes hits a wrong key, notices, deletes it and types the right one.
 * The result is a normal keystroke log, so the server checks and scores a bot exactly like a human.
 */
export function planBotRun(text: string, wpm: number, errRate: number): LogEntry[] {
  const log: LogEntry[] = [];
  const perChar = 60000 / (wpm * 5); // milliseconds per character at this speed
  let t = 300 + Math.random() * 400;  // reaction time after "Go"
  const press = (key: string) => log.push([Math.round(t), key]);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    t += perChar * (0.55 + Math.random() * 1.05) * (c === " " ? 1.1 : 1);
    if (c === " " && Math.random() < 0.05) t += 150 + Math.random() * 350; // a small hesitation between words
    if (c !== " " && i < text.length - 2 && Math.random() < errRate) { // slip: wrong key, notice, delete, retype
      let wrong = c;
      while (wrong === c) wrong = LETTERS[Math.floor(Math.random() * LETTERS.length)];
      press(wrong);
      t += 120 + Math.random() * 160;
      press("\b");
      t += perChar * (0.8 + Math.random() * 0.6);
    }
    press(c);
  }
  return log;
}
