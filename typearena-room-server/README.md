# TypeArena room server

Realtime rooms for TypeArena: create a room, share the invite link, race up to 10 players on the same passage, and get a ranked result. Built with Node.js, TypeScript, Express and Socket.IO. Everything lives in memory for now (no database).

## Run it in VS Code (nothing to set up by hand)

1. Install **Node.js LTS** (version 20 or newer) from https://nodejs.org if you don't have it. This is the only thing you install yourself.
2. Unzip the project, open VS Code, and choose **File > Open Folder** and pick the `typearena-room-server` folder.
3. Open the terminal (**Terminal > New Terminal**) and run:

   ```bash
   npm run dev:solo
   ```

   The first time, it installs all the packages by itself (about a minute). After that it starts the server and prints the address, usually http://localhost:3000.
4. Open that address in two browser tabs: create a room in one, then paste the invite link into the other. `dev:solo` lets a match start with 1 player, so you can also try the race alone.

Prefer clicking? Use **Terminal > Run Task...** and pick **TypeArena: Start (solo test)**, or on Windows double-click `start.bat` (macOS/Linux: `./start.sh`).

To debug with breakpoints, open the **Run and Debug** panel and start **TypeArena: debug server (solo test)**.

If port 3000 is already in use, the server tries 3001, 3002 and so on, and prints the address it picked. Change the starting port with the `PORT` environment variable.

### All commands

| Command | What it does |
|---|---|
| `npm run dev:solo` | Starts the server with auto-restart; a match can start with 1 player (good for testing alone) |
| `npm run dev` | Same, but a match needs 2 or more players (the real rule) |
| `npm start` | Starts the server without auto-restart |
| `npm test` | Runs eight test suites: a private-room race with a cheater and a rematch, the Quick match queue, reconnecting, accounts and ratings, bots, profiles with solo history, worlds and looks, and the race scene. To also test Postgres, set `TEST_DATABASE_URL` to a Postgres you don't mind emptying |
| `npm run typecheck` | Checks the TypeScript for mistakes |
| `npm run setup` | Installs packages (runs automatically when anything is missing) |

Troubleshooting: if you see a "Node.js 20 or newer" message, update Node from https://nodejs.org. If the install step fails, check your internet connection and run `npm install` again.

## Accounts, ratings and the leaderboard

- **Guests and accounts.** Anyone can play as a guest (no signup, invite links still work). Signing in (username and password, no email) gives you a rating and a place on the leaderboard. Passwords are never stored, only a salted `scrypt` hash. You stay signed in for 30 days, and 8 wrong passwords in 10 minutes block further tries for that username and address.
- **Rating.** Everyone starts at 1000. Only **public (Quick match) lobbies are rated**; private rooms never are, so friends can't trade wins. After a match every signed-in player is compared with every other signed-in player as if they had raced head to head (Elo, averaged over the lobby). New accounts move faster (K = 40 for the first 10 games, then 24). Guests still race and rank but are left out of the maths, results the server could not verify are left out too, and a player who did not finish counts as last.
- **Skill-based Quick match.** A new player is placed in the open public lobby whose average rating is closest to theirs, but only within a window of 150 points that grows by 25 per second of that lobby's age. If no lobby is close enough, a new one opens. Guests count as 1000.
- **Leaderboard.** The top 20 by rating (players with at least one rated game) is shown on the home screen. `GET /api/leaderboard?limit=50` returns it as JSON.
- **One seat per account.** A signed-in player's id comes from the account, so the same account can resume from any tab or device, and cannot sit in two lobbies at once.

Where it is saved: with no `DATABASE_URL`, in a local file (`data/typearena.json`), which is fine on your own computer. With `DATABASE_URL` set, in **Postgres** (tables are created automatically). Hosting services like Render lose local files when the service restarts, so **use a Postgres database when you deploy**.

| Setting | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string. Enables Postgres storage |
| `DATABASE_SSL` | `true` or `false` to force SSL on or off (normally the connection string decides, e.g. `sslmode=require`) |
| `DATA_FILE` | Path of the local account file (default `data/typearena.json`) |
| `PUBLIC_WAIT_MS` | How long a public lobby waits for more players (default 20000) |
| `RECONNECT_GRACE_MS` | How long a dropped player can come back (default 30000) |

Not included yet: password reset (there is no email, so a forgotten password cannot be recovered) and account deletion.

## Put it online so friends can play (deploy)

**Do not use Vercel for this server.** Vercel runs your code as short-lived functions. Each player's connection can land on a different instance, and this server keeps every room in one process's memory, so two friends would not end up in the same room. (Vercel's WebSocket support is also still in beta and limits how long a connection can stay open.) Use a host that runs a normal Node.js server instead. **Render** has a free plan that supports WebSockets and is enough for testing with friends.

**What to upload:** the whole project folder (not a single file), through a GitHub repository. Render reads the repository, and the server and the game page are served together from one address.

1. Create a free account at https://github.com, make a new repository, and upload the contents of this folder to it (do not upload `node_modules`; the included `.gitignore` already excludes it). In VS Code you can use the Source Control panel > Publish to GitHub.
2. Create a free Postgres database for accounts (see "Database for accounts" below) and copy its connection string.
3. Create a free account at https://render.com and choose **New > Web Service**, then connect that GitHub repository.
4. Use these settings: **Runtime** Node, **Build Command** `npm install`, **Start Command** `npm start`, **Instance type** Free. (Or choose New > Blueprint and Render reads `render.yaml` for you.)
5. Under **Environment**, add `NODE_VERSION` = `22` and `DATABASE_URL` = the connection string from step 2.
6. Click **Deploy**. When it finishes, Render shows your address, like `https://typearena.onrender.com`. Open it, create a room, and send the invite link to your friend.

**Database for accounts.** Render's own free Postgres expires after 30 days and is then deleted, so it is not a good home for accounts. **Neon** (https://neon.com) has a free Postgres plan that, according to its docs, does not expire (1 GB of storage per project; the database goes to sleep when idle and wakes on the next request, which can add a second or two to the first sign-in). Create a project there, copy the connection string (it looks like `postgres://user:password@host/dbname?sslmode=require`) and use it as `DATABASE_URL`. Keep that string secret. If the service starts with `DATABASE_URL` set, the log says "Accounts are saved in the Postgres database".

Good to know about the free plan: the service goes to sleep after 15 minutes without traffic, and the first visit after that takes about a minute to wake up. Rooms are kept in memory, so they disappear when it sleeps or restarts. For testing with a friend that is fine: open the address yourself a minute before you both play.

## Project layout

```
src/scoring.ts   Word-based typing rules, WPM, accuracy, score, and replay() of a keystroke log
src/rooms.ts     Room state machine: lobby -> countdown -> racing -> results -> (rematch) lobby
src/app.ts       Express + Socket.IO wiring (events below)
src/ratings.ts   Elo-style rating maths
src/cosmetics.ts The catalog of worlds and looks, and the unlock rules
src/bots.ts      Bot names and human-like typing plans for bots
src/store.ts     Account storage interface + local file store
src/pgStore.ts   Postgres store
src/auth.ts      Register, login, logout, leaderboard (HTTP API)
src/server.ts    Starts the server (tries the next port if one is busy)
scripts/check.mjs  Runs before dev/start/test: checks the Node version and installs missing packages
.vscode/         VS Code tasks, debug configuration and settings
start.bat, start.sh  Double-click starters for Windows and macOS/Linux
public/index.html  Browser client: home, lobby, race (the typing engine), results
public/solo.html   Solo Sprint: practise alone with a performance report
public/profile.html Profile page (own and public)
public/scene.js    Race scene: the four worlds, stick figures, hats, trails and fights (pure canvas drawing)
public/locker.html Locker: pick your world, colour, hat and trail
test/smoke.ts    End-to-end test
```

## How a match works

1. The host emits `create_room` and gets a 6-character code. Friends open `/j/CODE` (the invite link) or type the code.
2. The host emits `start_match` (needs `MIN_PLAYERS`). The server picks a passage and sends `room_state` with `status: "countdown"` and `startAt`, a server timestamp 3 seconds ahead. Each browser syncs its clock with the server, so typing unlocks at the same moment for everyone.
3. While racing, browsers send `progress` (what they have typed so far, at most ~7 times a second). This only drives the live leaderboard.
4. When a player finishes the passage the browser sends `finish` with its full keystroke log. The server replays the log itself, recomputes WPM and accuracy, and measures time from the shared start. The server never trusts a number sent by the browser.
5. When everyone has finished (or left), or after 120 seconds, the room moves to `results` with ranks. The host can start a `rematch`.

### Events

| Client to server | Payload | Reply |
|---|---|---|
| `time` | none | server time in ms (clock sync) |
| `resume` | none | `{ok, you}`: `ok` is true if you are still in a room (the server puts you back in it) |
| `quick_match` | name | `{ok, you}` (joins or opens a public lobby) |
| `create_room` | name | `{ok, code, you}` |
| `join_room` | `{name, code}` | `{ok, code, you}` or `{ok:false, error}` |
| `start_match` | none | `{ok}` or error (host only, private rooms only) |
| `progress` | typed text | none |
| `finish` | `{log: [[ms, key], ...]}` (`"\b"` = backspace) | `{ok}` or error |
| `rematch` | none | `{ok}` or error (host only, private rooms only) |
| `leave_room` | none | none |

Server to client: `room_state` (whole room, sent on every change) and `progress` (live leaderboard, about 5 times a second).

## Race scene (the battle view)

During a race, the area under the typing text shows a **dusk landscape where every player is a stick figure running toward the finish flag**.

- **Speed becomes movement.** A runner's place on the track is their real progress through the text, and their legs, speed lines and the scrolling hills follow their live WPM. You always run in the front lane in lime green. Bots carry a "bot" tag.
- **Mistakes and streaks.** Your own figure stumbles when you hit a wrong key, and gets a flame trail after 25 clean characters in a row.
- **Fights on the side.** When one runner overtakes another, the runner who was passed kicks, the passer turns around and punches back, with a "Pow!" or "Bam!" burst. **The fights are only for show: they never change a position or a score.** At most 3 fights happen at once and a runner cannot be in two at once.
- **The finish.** Finished runners celebrate beyond the line, and the first one to finish wears a crown.
- **Readable and kind to phones.** Name tags (with speed) are drawn for you, the leader and the fighters, and never cover each other. The scene gets smaller on small screens. A text line under it says "You are in 2nd place of 5" (also used as the screen-reader label), and a **Hide scene** button brings back the plain leaderboard. The choice is remembered, and the scene starts hidden for people whose system asks for reduced motion. If a browser has no canvas support, the plain leaderboard is used.
- **Worlds and looks.** The scenery can be one of four worlds and every runner can wear a colour, hat and trail chosen in the Locker (see below).
- **Where it lives.** The whole scene is one file, `public/scene.js` (drawn with code, no images), and it only uses data the game already sends: progress and speed. It is tested by `test/scene.ts`, which runs a simulated race on a real canvas (the optional `@napi-rs/canvas` package; the test is skipped if it is not installed).

## Worlds and looks (the Locker)

Signed-in players can change how the race looks. Open the **Locker** (`/locker`, or the **Locker** button on the home screen) for a live preview, and pick:

- **World** (the scenery of your own race screen): **Dusk Hills** (free), **Snowfield** (snowy mountains, pines, falling snow), **Neon City** (a skyline with glowing signs, a retro sun and a neon road) and **Deep Space** (a ringed planet, nebula, stars, shooting stars and craters, with floatier running). Only you see your world.
- **Colour**: Lime, Aqua, Coral, Violet, Amber, Pink, Gold and an animated Rainbow.
- **Hat**: none, Cap, Headband, Top hat, Wizard hat and Halo.
- **Trail**: Speed lines, Sparkles, Flames, Rainbow ribbon and Lightning.

Your **colour, hat and trail are seen by everyone** in the race. Choices save automatically.

**Unlocked by rating.** Every item has a rating at which it unlocks. Unlocks use your **peak rating**, the highest your rating has ever been, so a bad run never takes a reward away.

| Rating | Unlocks |
|---|---|
| start | Dusk Hills, Lime, Aqua, Coral, no hat, Speed lines |
| 1020 | Snowfield |
| 1030 | Violet, Cap |
| 1040 | Sparkles |
| 1050 | Amber |
| 1060 | Neon City, Headband |
| 1070 | Flames |
| 1080 | Pink |
| 1090 | Top hat |
| 1120 | Deep Space |
| 1130 | Wizard hat |
| 1150 | Gold |
| 1160 | Rainbow ribbon |
| 1200 | Halo |
| 1220 | Lightning |
| 1250 | Rainbow colour |

The catalog lives in `src/cosmetics.ts`, so you can change names and thresholds in one place. **All of it is cosmetic:** it never changes a position, a score or a rating. The server only accepts items you have unlocked, and a locked item can never be shown to other players, even if someone edits the database.

- API: `GET /api/cosmetics` (the catalog, plus your peak rating, look and next reward when signed in) and `PUT /api/look` (save a look; 400 for unknown items, 403 for locked ones). `/api/me` also returns your `peakRating` and `look`.
- Guests and bots use the default look and the dusk world. Players' colours otherwise come from a fixed palette.
- Databases created before this feature are upgraded automatically on start (the new `peak_rating` and `look` columns are added, and existing players keep their current rating as their peak).

## Solo Sprint (test your speed alone)

Open `/solo` (or press **Solo Sprint** on the home screen) to practise by yourself, with no account and no server connection. It uses the same typing rules as the races (press space to jump to the next word, blinking cursor, paste blocked, mistakes shown in red).

- **Choose the text:** a **Passage** (10 different ones) or **10, 25 or 50 random common words**.
- **While you type:** live speed (last 5 seconds), accuracy, time and mistakes.
- **When you finish**, a performance report:
  - **Average WPM** and **Raw WPM** (before mistakes are subtracted), **Accuracy**, **Consistency** (how steady your speed was, 100% is perfectly even), **Time** and **Mistakes made**
  - a **typist level** (Beginner under 30 WPM, Intermediate 30+, Advanced 50+, Fast 70+, Expert 90+)
  - a **speed chart**, second by second, with red dots on seconds where you made a mistake
  - **Words to practice**: the words you got wrong
  - your **personal best** for that kind of text and a list of your last 8 runs. These are saved in your browser only (`localStorage`); "Clear history" removes them.
- **Signed in?** Every finished run is **saved to your account**, so your history and personal bests follow you to any device, and show on your profile. The page tells you whether you are signed in. Guests keep their history in the browser only. If saving fails (no connection), the run is kept in the browser instead.
- Solo results are reported by your browser, so they are **practice history only**: they never change your rating or the leaderboard, and only you can see them. The server refuses impossible numbers and allows 60 saved runs an hour. It keeps your newest 500 runs, and your personal bests are never lost.
- `public/solo.html` also works without the server if you open the file directly (then runs stay in the browser).

## Profiles

- **My profile** (`/profile`, or the **My profile** button once you are signed in): your **rating, leaderboard rank, rated games, wins and best match WPM**; a **rating history chart**; a table of your **last 30 rated matches** (result such as "#3 of 6", WPM, accuracy, and the rating change); and your **Solo Sprint** summary (runs saved, average of your last 10, best per text type, a speed chart and your recent runs).
- **Public profiles** (`/u/NAME`, linked from every name on the leaderboard): rating, rank, wins and the rated matches. The Solo Sprint history is private and is never shown there.
- API: `GET /api/profile` (signed in), `GET /api/users/NAME` (public), `POST /api/solo` and `GET /api/solo` (signed in).
- In Postgres, rated results are kept in `match_results` and solo runs in `solo_results` (newest 500 per player) and `solo_bests`; the tables are created automatically.

## Quick match (public lobbies)

Press **Quick match** and the server puts you in a public lobby of up to 10 players:

- It joins the open public lobby **closest to your rating** (see "Accounts, ratings and the leaderboard"), or opens a new one. A lobby that is already racing or about to start is never joined, so late players get a fresh lobby instead.
- Public lobbies have no code and cannot be joined by one, and nobody is host.
- The lobby starts **by itself**. With bots on (the default), a timer starts as soon as the first player joins: **10 seconds** for a lone player, **20 seconds** once a second real player is in. A full lobby of 10 starts after 5 seconds instead. With bots off, the timer only starts when 2 real players are in, and is cancelled if fewer remain.
- A lone player can press **Start now with bots** to skip the wait.
- After the race the results screen shows **Find new match** (there is no rematch in public lobbies).

## Bots

So that a player is never left waiting alone, **empty seats of a public lobby are filled with bots when the match starts**, up to 6 players in total.

- **Always marked.** Bots are tagged **BOT** on the race screen and in the results. Nobody is led to think they are racing a person.
- **They type like people.** Each bot has its own speed (35 to 95 WPM by default, so about 30 to 85 measured), an uneven rhythm, small pauses between words, and sometimes hits a wrong key, notices, deletes it and retypes. Each bot's keystrokes are planned as a normal keystroke log, and the server verifies and scores a bot exactly like a human's result.
- **They never change ratings.** Ratings are calculated between real signed-in players only. A signed-in player racing only bots plays a practice match and the results screen says so. Bots are only used in public lobbies, never in private rooms.
- **No leftovers.** When the last real player leaves, the room and all bot timers are removed.

| Setting | Meaning |
|---|---|
| `BOTS=off` | Turn bots off. Public lobbies then wait for real players (needs 2) |
| `BOT_FILL_TO` | Fill lobbies up to this many players (default 6, at most 10) |
| `BOT_WAIT_MS` | How long a lone player waits before bots fill in (default 10000) |
| `BOT_MIN_WPM`, `BOT_MAX_WPM` | Speed range of bots (default 35 and 95) |

Settings: `PUBLIC_WAIT_MS` (default `20000`) changes how long a lobby with 2 or more real players waits. `MIN_PLAYERS` (2 by default, 1 with `dev:solo`) is the number of players a **private room** needs to start.

## Reconnecting (refresh or a dropped connection)

- Each browser tab creates a random secret token (kept in `sessionStorage`) and sends it when it connects. The server turns it into the player id (a hash, so nobody can copy another player's id from the room state). The same tab is therefore recognised again after a refresh or a lost connection, and Socket.IO reconnects by itself.
- When a connection drops, the player keeps their seat for a **grace period** (30 seconds, change it with `RECONNECT_GRACE_MS`). Others see them as "reconnecting". If they come back in time they are put straight back into the room, the lobby or the running race. If not, they are removed from a lobby, or count as "did not finish" in a race.
- A race **waits** for players who are reconnecting, so a short drop never ends the match without them.
- The browser saves the race in the tab (what you typed and the keystroke log), so after a refresh in the middle of a race you carry on where you stopped. If you finished while offline, the result is sent as soon as you are back.
- A result delivered late is still verified: the server allows for the time the player was offline (at most the grace period) when it checks the timing.
- A closed tab cannot be resumed from another tab, because the token lives in that tab.

### Scoring and ranking

- Average WPM = correct characters / 5 / minutes, from the shared start to the finish. A space after a fully correct word counts as a correct character.
- Accuracy counts every mistake you made, including ones you fixed. Extra letters and skipped letters are errors.
- Score = WPM x accuracy squared. Rank is by score. Unverified results rank below verified ones, and players who did not finish rank last (by progress).

### Basic anti-cheat (v1)

A result is marked **unverified** (score 0) if the keystroke log is inconsistent with the server's own clock by more than 3 seconds, if the speed is above 400 WPM, or if the average gap between keys is under 25 ms. Pasting is blocked in the browser, and the server rebuilds the typed text from the log, so a made-up result cannot be submitted. This stops casual cheating, not a determined bot. Later: statistical checks on keystroke timing, replay review for top scores.

## Known limits (next steps)

- State is in memory, so restarting the server clears all rooms (players who reconnect to a restarted server are told they left the room). Use Redis when you need more than one server process.
- `public/index.html` has its own copy of the typing rules from `src/scoring.ts`. Move them into one shared package when the client moves to React or Next.js.
- No accounts or ratings yet, so there are no global leaderboards.
- Bots are simple: they have a fixed speed per match and do not adapt to how well you are doing. They are meant to make a quiet lobby playable, not to replace real players.
- The session token is kept in the browser's `localStorage`. Every page uses safe text rendering (no HTML from users), but adding a Content-Security-Policy header is a good hardening step before a big launch.
