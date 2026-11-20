import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { PgStore } from "./pgStore.js";
import { FileStore, Store } from "./store.js";

// Accounts and ratings are saved in Postgres when DATABASE_URL is set (use this when hosting),
// otherwise in a local JSON file (fine for trying it on your own computer).
let store: Store;
if (process.env.DATABASE_URL) {
  store = new PgStore(process.env.DATABASE_URL);
  console.log("Accounts are saved in the Postgres database (DATABASE_URL).");
} else {
  const file = process.env.DATA_FILE ?? "data/typearena.json";
  store = new FileStore(file);
  console.log(`Accounts are saved in the local file ${file}.`);
  if (process.env.RENDER || process.env.NODE_ENV === "production") {
    console.warn("WARNING: this service has no DATABASE_URL, so accounts and ratings are lost whenever it restarts. Add a Postgres database and set DATABASE_URL.");
  }
}
try { await store.init(); } catch (err) {
  console.error(`Could not set up the account storage: ${(err as Error).message}`);
  process.exit(1);
}

const firstPort = Number(process.env.PORT ?? 3000);
const { httpServer } = createApp({}, store);

// If the port is taken (for example by another copy of the server), try the next one.
function listen(port: number, tries = 0): void {
  const onListening = () => {
    httpServer.off("error", onError);
    const actual = (httpServer.address() as AddressInfo).port;
    console.log(`\nTypeArena room server is running.`);
    console.log(`Open http://localhost:${actual} in two browser tabs to race against yourself.`);
    console.log(`Players needed to start a private room: ${process.env.MIN_PLAYERS ?? 2}\n`);
  };
  function onError(err: NodeJS.ErrnoException) {
    httpServer.off("listening", onListening);
    if (err.code === "EADDRINUSE" && tries < 10) {
      console.log(`Port ${port} is busy, trying ${port + 1}...`);
      listen(port + 1, tries + 1);
    } else {
      console.error(`Could not start the server: ${err.message}`);
      process.exit(1);
    }
  }
  httpServer.once("error", onError);
  httpServer.once("listening", onListening);
  httpServer.listen(port);
}
listen(firstPort);

// Save the account file when the server is stopped (Ctrl+C, or Render replacing the instance).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void store.close().finally(() => process.exit(0)); });
}
