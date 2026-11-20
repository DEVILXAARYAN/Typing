// Runs automatically before dev/start/test. Makes sure Node is new enough and that
// every package is installed, so the project runs on a fresh machine with no setup.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const major = Number(process.versions.node.split(".")[0]);

if (major < 20) {
  console.error(`\nThis project needs Node.js 20 or newer, but you have ${process.versions.node}.`);
  console.error("Download the LTS version from https://nodejs.org, install it, then run this again.\n");
  process.exit(1);
}

// On a hosting service (Render, Railway, ...) packages are installed by the build step, so skip the check.
if (process.env.NODE_ENV === "production" || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.CI) process.exit(0);

const needed = ["express", "socket.io", "pg", "tsx", "typescript", "cross-env", "socket.io-client", "@types/node", "@types/express"];
const missing = needed.filter((m) => !existsSync(`${root}node_modules/${m}/package.json`));
if (missing.length) {
  console.log(`\nFirst run: installing packages (${missing.length} missing). This takes about a minute...\n`);
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("\nInstalling packages failed. Check your internet connection and run `npm install` again.\n");
    process.exit(1);
  }
}
