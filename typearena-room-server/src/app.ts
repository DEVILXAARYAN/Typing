import express from "express";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Server, Socket } from "socket.io";
import { registerAuthRoutes, userFromSession } from "./auth.js";
import { sanitizeLook } from "./cosmetics.js";
import { Ident, Options, RoomManager } from "./rooms.js";
import { FileStore, PublicUser, Store, publicUser } from "./store.js";

export function createApp(opts: Options = {}, store: Store = new FileStore()) {
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  const app = express();
  app.set("trust proxy", 1); // behind Render's proxy, so req.ip is the real visitor address
  registerAuthRoutes(app, store);
  app.use(express.static(publicDir));
  app.get("/j/:code", (_req, res) => res.sendFile("index.html", { root: publicDir })); // invite link
  app.get("/solo", (_req, res) => res.sendFile("solo.html", { root: publicDir }));      // Solo Sprint (practice alone)
  app.get("/locker", (_req, res) => res.sendFile("locker.html", { root: publicDir }));                   // worlds and looks
  app.get(["/profile", "/u/:name"], (_req, res) => res.sendFile("profile.html", { root: publicDir })); // own profile, public profiles
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 }); // same-origin by default, so no CORS

  const manager: RoomManager = new RoomManager({
    state: (room) => io.to(room.code).emit("room_state", manager.snapshot(room)),
    progress: (room) =>
      io.to(room.code).emit("progress", [...room.players.values()].map((p) => ({ id: p.id, pct: p.pct, wpm: p.liveWpm }))),
    matchEnded: (updates) => {
      store.applyMatch(updates).catch((err) => console.error("Could not save rating changes:", err?.message ?? err));
    },
  }, opts);

  // Every browser sends a random secret token when it connects (and, if signed in, its session token).
  // Guests: the player id is a hash of the tab token, so the same tab is recognised after a refresh or a lost connection.
  // Signed-in players: the id comes from the account, so any tab or device can come back, and one account has one seat.
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth ?? {};
    const token = auth.token;
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return next(new Error("Missing player token"));
    let user: PublicUser | null = null;
    if (auth.session) { try { user = await userFromSession(store, auth.session); } catch { /* database trouble: play as a guest */ } }
    socket.data.user = user;
    socket.data.pid = createHash("sha256").update(user ? `user:${user.id}` : token).digest("hex").slice(0, 16);
    next();
  });

  /** Name and rating to use when this connection joins a game. Signed-in players use their account name and current rating. */
  async function identity(socket: Socket, typedName: unknown): Promise<{ name: unknown; ident?: Ident }> {
    let user = socket.data.user as PublicUser | null;
    if (!user) return { name: typedName };
    try { const fresh = await store.getUser(user.id); if (fresh) user = publicUser(fresh); } catch { /* keep the rating we had */ }
    socket.data.user = user;
    return { name: user.username, ident: { userId: user.id, rating: user.rating, games: user.games, look: sanitizeLook(user.look, user.peakRating) } };
  }

  io.on("connection", (socket) => {
    const pid = socket.data.pid as string;
    let lastProgress = 0;
    const isFn = (f: unknown): f is (r: unknown) => void => typeof f === "function";
    const enter = (code: string) => { // be in exactly one Socket.IO room: the player's current game room
      for (const r of [...socket.rooms]) if (r !== socket.id && r !== code) socket.leave(r);
      socket.join(code);
    };
    const rejoin = () => {
      const room = manager.attach(pid, socket.id);
      if (room) { enter(room.code); io.to(room.code).emit("room_state", manager.snapshot(room)); }
      return room;
    };

    rejoin(); // a refresh or a dropped connection: put the player back in their room straight away
    socket.on("resume", (ack) => { if (isFn(ack)) ack({ ok: !!rejoin(), you: pid }); });

    // Clock sync, so the countdown ends at the same moment for everyone.
    socket.on("time", (ack) => { if (isFn(ack)) ack(Date.now()); });

    socket.on("create_room", async (name, ack) => {
      if (!isFn(ack)) return;
      const who = await identity(socket, name);
      const room = manager.create(pid, who.name, socket.id, who.ident);
      enter(room.code);
      ack({ ok: true, code: room.code, you: pid });
      io.to(room.code).emit("room_state", manager.snapshot(room));
    });
    socket.on("quick_match", async (name, ack) => {
      if (!isFn(ack)) return;
      const who = await identity(socket, name);
      const room = manager.quickMatch(pid, who.name, socket.id, who.ident);
      enter(room.code);
      ack({ ok: true, you: pid });
      io.to(room.code).emit("room_state", manager.snapshot(room));
    });
    socket.on("join_room", async (data, ack) => {
      if (!isFn(ack)) return;
      const who = await identity(socket, data?.name);
      const res = manager.join(pid, who.name, data?.code, socket.id, who.ident);
      if (!res.ok) return ack(res);
      enter(res.room.code);
      ack({ ok: true, code: res.room.code, you: pid });
      io.to(res.room.code).emit("room_state", manager.snapshot(res.room));
    });
    socket.on("start_match", (ack) => { const r = manager.start(pid); if (isFn(ack)) ack(r); });
    socket.on("start_now", (ack) => { const r = manager.startNow(pid); if (isFn(ack)) ack(r); });
    socket.on("progress", (typed) => {
      const now = Date.now();
      if (now - lastProgress < 60) return; // ignore floods
      lastProgress = now;
      manager.progress(pid, typed);
    });
    socket.on("finish", (data, ack) => { const r = manager.finish(pid, data?.log); if (isFn(ack)) ack(r); });
    socket.on("rematch", (ack) => { const r = manager.rematch(pid); if (isFn(ack)) ack(r); });
    socket.on("leave_room", () => {
      manager.leave(pid);
      for (const r of [...socket.rooms]) if (r !== socket.id) socket.leave(r);
    });
    socket.on("disconnect", () => manager.disconnect(pid, socket.id));
  });

  return { app, httpServer, io, manager, store };
}
