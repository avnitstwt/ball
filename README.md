# Ball Drop Endless Live Stream

A complete, local, zero-mandatory-cost 9:16 livestream project for an Apple Silicon Mac. It runs an original, automatic physics merge game, renders a real webpage at `http://localhost:3000`, captures the 1080×1920 canvas in headless Chromium, and pipes frames in memory to FFmpeg. Test mode writes an MP4. Production sends H.264/AAC to a manually created YouTube Live RTMPS destination.

The supplied local photo and payment QR are already in `assets/`. The application does not upload, inspect, decode, regenerate, or modify the QR. It only validates that the file is a readable image and draws it as an opaque local image.

## Original-game statement

The game design, tier names, art drawn by Canvas, HUD, container, effects, bot behavior, scoring, recovery behavior, and session presentation in this project are original. No reference-app name, logo, UI, art, font, button, text, or game asset is included.

## Project tree

```text
ball-drop-endless-live/
├── assets/
│   ├── payment-qr.jpg
│   └── person-photo.jpg
├── public/
│   ├── client.js
│   ├── index.html
│   └── styles.css
├── runtime/
│   └── .gitkeep
├── src/
│   ├── better-sqlite3.d.ts
│   ├── database.ts
│   ├── game.ts
│   ├── index.ts
│   └── streamer.ts
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── tsconfig.json
```

Generated files stay in `runtime/` and are excluded from Git and from the distributed ZIP.

## Architecture

```text
Matter.js fixed-step game (Node.js, authoritative state)
              │
              ├── SQLite checkpoints/session results
              │
              └── validated local WebSocket state
                          │
                Canvas 2D browser renderer
                          │
             Playwright headless Chromium screenshot
                          │ PNG buffers in memory
                          ▼
                  FFmpeg child process
              ┌───────────┴────────────┐
          local test MP4          YouTube RTMPS
```

- One authoritative Node.js game state controls physics, scoring, merges, recovery, and restarts.
- Matter.js advances at a fixed 60 Hz with a monotonic accumulator, delta clamping, and bounded catch-up.
- The browser only renders serialized state and sends strictly validated development controls.
- Playwright captures the actual 9:16 canvas at device scale factor 1. No screen capture or screen sharing is used.
- FFmpeg is launched by `child_process.spawn` with argument arrays. The project does not use `exec` or `fluent-ffmpeg`.
- Frame files are never written. Backpressure keeps at most one newest pending frame and drops stale frames without affecting game time or score.
- The Playwright/PNG approach keeps browser preview and stream visuals identical and avoids a second rendering implementation. PNG encoding can use more CPU than a native raw-frame renderer; the reliability controls fail safely on repeated capture errors instead of silently streaming damaged frames.

## 9:16 layout

The render is 1080×1920 at 30 FPS by default.

- **Top game area:** approximately Y 0–1120, with score, best score, timer, level/stage, next preview, container, balls, merges, particles, and a small status indicator.
- **QR panel:** middle-right, configured by `QR_X`, `QR_Y`, `QR_WIDTH`, and `QR_PADDING`. It preserves aspect ratio, uses integer placement, high-quality interpolation, a white quiet-zone panel, and the configurable `QR_LABEL`. It is rendered as a protected top layer.
- **Lower photo area:** starts at `PHOTO_AREA_Y=1120`, preserves aspect ratio, and uses configurable `cover` or `contain`. The crop is centered and receives a subtle dark gradient so local text remains readable.
- **Development guides:** optional safe-area and boundary guides appear only outside production.

## Why OBS or screen sharing is unnecessary

The canvas is captured directly inside headless Chromium and passed to FFmpeg in memory. There is no desktop capture, window capture, screen share, OBS, Streamlabs, or virtual camera. This reduces moving parts and prevents unrelated desktop content from entering the stream.

# ZERO-COST ARCHITECTURE

There is no mandatory paid service. The only external network destination in production is the manually configured YouTube Live RTMPS endpoint.

| Dependency or capability | Classification | Cost and role |
|---|---|---|
| Apple Silicon Mac | Local | Existing computer; all game, browser, database, and encoding work stays local. |
| Node.js | Local / open source / free official download | Runs TypeScript output, HTTP, WebSocket, physics orchestration, persistence, and FFmpeg control. |
| TypeScript + `tsx` | Local / open source | Strict local build and development execution. |
| FFmpeg | Local / open source | Encodes test MP4 or RTMPS output. Homebrew package is free. |
| `h264_videotoolbox` | Free official macOS functionality | Uses Apple VideoToolbox hardware H.264 in production. |
| SQLite through `better-sqlite3` | Local / open source | A file at `runtime/game.db`; no hosted database or account. |
| Canvas 2D | Local / free browser functionality | Draws the complete original visual output. |
| Matter.js | Local / open source (MIT) | Deterministic rigid-body physics and collision events. |
| `ws` WebSocket | Local / open source (MIT) | Sends state only between local Node.js and local browser. |
| Zod | Local / open source (MIT) | Validates environment values and every inbound WebSocket message. |
| dotenv | Local / open source (BSD-2-Clause) | Loads the ignored local `.env` file. |
| Playwright + Chromium | Local / open source / free browser binary | Captures the real local canvas; installation is optional for preview-only use but required for MP4/RTMPS capture. |
| YouTube Live RTMPS | Free official functionality | Manual destination; no YouTube API and no API key. Account eligibility and YouTube's own live-stream policies still apply. |
| Local music file | Optional | Not included. Use only audio you created or are licensed to stream. |
| LAN preview | Optional | `HOST=0.0.0.0`; local network only, with no port forwarding. |

## Dependencies and licenses

Direct npm dependencies are pinned by compatible major/minor ranges in `package.json`:

- `better-sqlite3` — MIT
- `dotenv` — BSD-2-Clause
- `matter-js` — MIT
- `playwright` — Apache-2.0
- `ws` — MIT
- `zod` — MIT
- `tsx` — MIT
- `typescript` — Apache-2.0
- `@types/node`, `@types/ws`, `@types/matter-js` — MIT when installed as development type packages

Run `npm view <package> license` on a connected machine if you need to re-audit a future dependency upgrade. This project contains no paid game asset, font, music, API client, analytics SDK, or monitoring agent.

## Apple Silicon setup — exact commands in order

Open Terminal and run:

```bash
# 1. Install Apple's free command-line build tools when prompted.
xcode-select --install

# 2. Install Homebrew if it is not already installed.
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 3. Make Homebrew available in the current Apple Silicon shell.
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# 4. Install local Node.js and FFmpeg.
brew install node ffmpeg

# 5. Verify versions and the required production encoder.
node --version
npm --version
ffmpeg -version
ffmpeg -hide_banner -encoders | grep h264_videotoolbox

# 6. Unzip and enter the project.
unzip ball-drop-endless-live.zip
cd ball-drop-endless-live

# 7. Install open-source npm packages and the free local Chromium binary.
npm install
npx playwright install chromium

# 8. Create the private local configuration.
cp .env.example .env

# 9. Run checks, then create the layout image.
npm run typecheck
npm run build
npm run diagnostics
npm run preview:layout
open runtime/layout-preview.png

# 10. Open the interactive local preview.
npm run dev
# In another Terminal tab:
open http://localhost:3000
```

If `xcode-select --install` says the tools are already installed, continue. Homebrew, Node.js, FFmpeg, npm packages, and Chromium are local and free; downloads require internet only during installation.

## Project setup and exact asset filenames

These files are already present:

```text
assets/person-photo.jpg
assets/payment-qr.jpg
```

Do not rename them unless you also change `PERSON_PHOTO_PATH` or `PAYMENT_QR_PATH`. The reference screenshot is intentionally not included. `assets/background-music.mp3` is intentionally not included.

Create `.env` from `.env.example`. `.env` is ignored by Git and excluded from the ZIP.

## Local preview

```bash
npm run dev
open http://localhost:3000
```

The default bind is `127.0.0.1`, so only the same Mac can connect. The dashboard shows the scaled 9:16 output, local controls, and diagnostics. It does not start FFmpeg in preview mode.

Development controls are validated and contain no shell command path:

- pause/resume physics;
- spawn the next ball;
- force a safe merge;
- trigger a controlled recovery;
- test game-over;
- reset the session;
- toggle layout and QR safe-area guides;
- fullscreen the preview;
- locally preview/mute optional music if a file exists.

Controls are rejected when `NODE_ENV=production`.

## Test mode

`TEST_MODE=true` always prevents RTMPS output, even if `YOUTUBE_RTMPS_URL` has a value. It uses the real physics, renderer, images, score, WebSocket, Playwright, and FFmpeg pipeline and writes:

```text
runtime/test-output.mp4
```

Default test:

```bash
npm run test:local
```

Shorter test without editing `.env`:

```bash
TEST_DURATION_SECONDS=30 npm run test:local
```

The normal 120-second scenario forces representative safe merges, multiple tiers, scoring, one explained recovery, a game-over overlay, and an accelerated automatic restart. Very short tests can end before every scenario event occurs.

Inspect the output:

```bash
open runtime/test-output.mp4
ffprobe -hide_banner runtime/test-output.mp4
```

Test mode uses `libx264` so it can be verified on non-macOS systems. Production remains hard-restricted to `h264_videotoolbox`.

## Production mode

1. Run `npm run test:local` and watch the entire MP4 first.
2. Confirm `npm run diagnostics` reports `h264_videotoolbox: AVAILABLE`.
3. Edit `.env`:

```dotenv
NODE_ENV=production
TEST_MODE=false
YOUTUBE_RTMPS_URL=rtmps://YOUR-YOUTUBE-RTMPS-SERVER/YOUR-PRIVATE-STREAM-KEY
```

4. Start production:

```bash
npm run build
npm run start:production
```

The terminal shows a local-only 5-4-3-2-1 countdown. The RTMPS URL is never printed, included in exports, or returned to the browser. FFmpeg diagnostics redact RTMPS-looking strings before writing `runtime/ffmpeg.log`.

Production video defaults to H.264 `h264_videotoolbox`, `yuv420p`, 4500 kbit/s, 30 FPS, and a two-second keyframe interval. Audio defaults to silent stereo AAC at 128 kbit/s and 44.1 kHz.

## YouTube Studio manual broadcast preparation

No YouTube API is used.

1. Sign in to YouTube Studio in your browser.
2. Choose **Create → Go live**.
3. Create or schedule a stream and select the vertical-friendly title/settings you want.
4. In Stream settings, choose the RTMPS server when available.
5. Combine the shown RTMPS server URL and the private stream key into the single full URL required by `YOUTUBE_RTMPS_URL`.
6. Save it only in `.env`.
7. Start this project and wait for YouTube Studio to show a healthy incoming signal.
8. Start the public broadcast manually in YouTube Studio if your channel workflow requires it.

Channel verification, first-live activation delay, account eligibility, and policy requirements are controlled by YouTube, not this project.

## Keep the stream key private

- Never paste `.env`, the stream key, or the full RTMPS URL into chat, screenshots, Git, issue trackers, or logs.
- Never commit `.env`; it is already in `.gitignore`.
- Rotate the stream key in YouTube Studio if it is exposed.
- Runtime JSON exports contain no URL or key.
- The browser never receives the RTMPS destination.

## Auto player

The bot uses seeded pseudo-random decisions. The initial `GAME_SEED` can be supplied for repeatable tests; otherwise a local random seed is generated. Each restart gets a new seed, and every session summary stores its seed.

The bot:

- favors columns with lower stack pressure;
- targets compatible tiers when safe;
- adds bounded aim error and occasional risky choices;
- reduces high-tier drops and slows down near high stacks;
- adds hesitation and occasional quick double drops;
- checks the spawn area before creating a body;
- varies rhythm so the stream is not a fixed loop.

## Scoring and merging

There are eight original tiers:

1. Mint Dot
2. Sky Pop
3. Grape Orb
4. Coral Bubble
5. Golden Bounce
6. Lime Planet
7. Violet Giant
8. Rainbow Core

Same-tier balls must remain in low-relative-velocity contact for `MERGE_CONTACT_MS`. A merge lock is acquired before removal, both source bodies are removed once, and the next tier appears near their midpoint with a controlled upward impulse. Two Rainbow Cores create a large score/effect and disappear.

Score comes only from actual game events: merges, bounded chain multipliers, final-tier bonuses, and explained recovery bonuses. Floating `+score` labels and distinct chain effects are visualized. The HUD smoothly counts toward the authoritative score; it never invents score client-side.

## Long-session recovery and delayed game-over

Normal sessions target a random duration between `MIN_GAME_DURATION_SECONDS=7200` and `MAX_GAME_DURATION_SECONDS=10800` (two to three hours).

Before the minimum duration, a critical high stack does not permanently end the session. The game applies subtle, bounded controls:

- slightly easier merge contact tolerance;
- lower-tier preference and longer drop delays;
- tiny settling forces on nearly stationary high balls;
- small nudges for old stuck bodies;
- an explained **Stability Bonus** that removes at most three small, low-tier bottom candidates and awards points.

It does not mass-delete the board, silently reset score, teleport visible balls, or freeze time. After the minimum duration, a sustained critical stack can end the session. Otherwise, game-over occurs at the randomized target. Spawning stops, bodies settle, the original overlay shows score/best, state is saved, and the game waits a random 8–15 seconds before safely starting a new seeded session. FFmpeg stays running.

`STREAM_DURATION_SECONDS=0` means the stream continues until stopped. A positive value stops the process after that many seconds.

## Physics and long-running safety

- Fixed 60 Hz Matter.js update with monotonic timing.
- Large deltas are clamped; catch-up is limited to eight steps.
- Restitution, friction, static friction, air friction, density, and collision slop are bounded.
- Active balls, particles, floating labels, incoming message size, sockets, timers, and pending frames are bounded.
- Out-of-bounds bodies and all pair/merge bookkeeping are cleaned.
- `MAX_ACTIVE_BALLS` and `MAX_PARTICLES` are clamped at startup.
- Session restart removes bodies and transient collections without recreating listeners or FFmpeg.
- Browser/page crashes, repeated capture failures, physics errors, broken pipes, and unexpected FFmpeg exits trigger coordinated failure shutdown.

## SQLite

The local database is `runtime/game.db`. Startup enables:

```text
journal_mode=WAL
synchronous=NORMAL
busy_timeout=5000
foreign_keys=ON
```

Tables are `settings`, `sessions`, and `checkpoints`. SQL values are parameterized. Session completion, best-score update, and final checkpoint run in one transaction. Periodic checkpoints use serialized authoritative state. No database server, account, network port, or hosted storage exists.

## Runtime exports

Each session completion updates `runtime/session-summary.json` and appends one JSON line to `runtime/session-history.jsonl` with:

- session ID and seed;
- start/end time, status, and duration;
- final and best score;
- balls dropped, merges, highest tier, longest combo, and recoveries;
- game-over reason and stream mode;
- total attempted/dropped frames and FFmpeg restart count.

Exports contain no RTMPS value, stream key, QR payload, decoded QR data, photo metadata, token, or credential.

## Diagnostics

```bash
npm run diagnostics
```

It reports Node version, platform, architecture, FFmpeg version, VideoToolbox availability, project directory, runtime write access, SQLite access, local image presence and dimensions, port availability, Playwright/Chromium availability, test mode, width, height, FPS, raw RGBA frame size, and whether an RTMPS URL is configured. It reports only YES/NO for the URL.

The local dashboard reports current/average FPS, physics rate, active balls/particles, score/best, session duration, merges, frame writes, dropped frames, FFmpeg status, WebSocket connections, memory RSS, and event-loop delay. The livestream shows only the small status indicator.

## Layout preview and QR clarity checks

```bash
npm run preview:layout
open runtime/layout-preview.png
```

Check the PNG at 100% zoom:

1. The QR panel is fully inside frame and has white space around it.
2. No ball, particle, overlay, text, or status badge covers it.
3. The QR image is not stretched; its proportions match the original local file.
4. Test scanning from a second phone at the expected viewing size.
5. If needed, increase `QR_WIDTH` while keeping `QR_X + QR_WIDTH <= WIDTH`.
6. Keep `QR_PADDING` at least 8; 18 is recommended.
7. Do not crop, edit, sharpen, regenerate, or decode the QR image.

`SHOW_DEVELOPMENT_GUIDES=true` adds a QR safe-area outline only in development. Production forces controls off and does not need guides; leave the value false.

## CPU and memory guidance

- Keep the Mac connected to power and prevent sleep during a long stream.
- Close heavy applications and browser tabs.
- Use the default 1080×1920 at 30 FPS before attempting higher values.
- Production VideoToolbox reduces H.264 CPU cost; Playwright PNG capture still uses CPU.
- Watch the dashboard's FPS, dropped-frame, RSS, and event-loop-delay fields during a full-length test.
- Do not raise `MAX_ACTIVE_BALLS` or `MAX_PARTICLES` unless a long test proves stable.
- Do not run multiple copies; the second should fail safely because port 3000 or SQLite is in use.

## Safe stopping

Press `Control+C` once. SIGINT/SIGTERM causes spawning to pause, the active session and checkpoint to be saved, frame capture to stop, FFmpeg stdin to close, Chromium to close, sockets/server to close, and SQLite to checkpoint/close. Do not force-quit Terminal unless graceful stop has already failed.

## Security

- HTTP binds to `127.0.0.1` by default.
- The server has an exact static allowlist and path-traversal rejection.
- `runtime/`, `.env`, `src/`, database files, logs, tokens, and arbitrary files are never served.
- WebSocket input is limited to 4096 bytes and validated by a strict Zod union.
- Production rejects all game controls.
- There is no upload route, auth service, OAuth, API key, shell endpoint, `exec`, or user-provided command execution.
- Secrets remain in Node/FFmpeg process memory and the ignored `.env` file.

### LAN preview warning

`HOST=0.0.0.0` allows devices on the same LAN to open the preview. It is optional and not authentication. Use only on a trusted network, keep development controls in mind, and **never configure router port forwarding**. Return to `HOST=127.0.0.1` before production.

## Audio and copyright warning

Audio is disabled by default. FFmpeg supplies silent stereo audio so YouTube receives a stable A/V stream. To use local music:

1. Provide `assets/background-music.mp3` yourself.
2. Confirm you own it or have livestream rights.
3. Set `ENABLE_AUDIO=true`.
4. Adjust `BACKGROUND_MUSIC_VOLUME` conservatively.

The file loops locally at low volume. No music is included or downloaded by this project. A fade-in is not applied; use an audio file with its own gentle opening if required.

## Troubleshooting

### Node not found

Run `brew install node`, restart Terminal, and check `which node` plus `node --version`. Node 20.11 or newer is required.

### `npm install` fails

Confirm internet access, `npm config get registry`, free disk space, and system time. Try `npm cache verify` and rerun `npm install`. Corporate proxies may block public packages; use the organization's approved npm configuration rather than disabling TLS.

### `better-sqlite3` native build fails

Run `xcode-select --install`, verify `xcode-select -p`, delete `node_modules` and `package-lock.json`, then run `npm install` again. Use an active LTS Node release if a brand-new Node version has no prebuilt binary yet.

### Matter.js types fail

Run `npm install`, ensure `@types/matter-js` is present in development dependencies, then run `npm run typecheck`. Do not add `@ts-ignore` or switch off strict mode.

### FFmpeg missing

Run `brew install ffmpeg` and `which ffmpeg`. Restart Terminal if Homebrew was just added to the shell path.

### `h264_videotoolbox` unavailable

Run `ffmpeg -hide_banner -encoders | grep h264_videotoolbox`. Reinstall the Homebrew FFmpeg build. Test mode can use `libx264`; production intentionally refuses to start without VideoToolbox.

### RTMPS rejected or invalid key

Confirm the complete URL begins with `rtmps://`, the stream key is current, the scheduled broadcast accepts that key, and no whitespace was copied. Rotate an exposed key. Do not post the URL while asking for help.

### Renderer not starting / Playwright Chromium missing

Run `npx playwright install chromium`, then `npm run diagnostics`. Confirm free disk space. A browser/page crash stops the stream safely rather than falling back to desktop capture.

### Blank page

Check the terminal for startup errors, open exactly `http://localhost:3000`, hard-refresh, and inspect whether the two asset files exist. Run `npm run diagnostics`.

### WebSocket disconnected

Ensure only one server uses port 3000 and no proxy rewrites localhost WebSockets. The browser retries with bounded exponential backoff.

### Port 3000 in use

Find the process with `lsof -nP -iTCP:3000 -sTCP:LISTEN`. Stop the old project or set the same unused `PORT` in `.env`; then reopen the matching URL.

### Photo or QR missing

Use the exact names `assets/person-photo.jpg` and `assets/payment-qr.jpg`, or update the corresponding `.env` paths. Test mode displays placeholders; production fails before streaming.

### QR blurry or not scanning

Use `npm run preview:layout`, inspect at 100%, increase `QR_WIDTH`, preserve padding, and scan from a second device. Do not resize the source file. Avoid screenshots of the generated preview because another resampling step can blur it.

### Photo stretched or bad crop

Set `PERSON_PHOTO_FIT=contain` to show the full image or `cover` for a filled centered crop. The renderer never changes source aspect ratio.

### Game overlaps the QR

Do not move the game container into the QR column. Keep default container geometry and use the guide overlay. Adjust QR values only inside the 1080-wide frame.

### Balls escape

Restore default gravity and dimensions. Out-of-bounds cleanup prevents leaks, but repeated escapes indicate edited container coordinates or extreme physics values.

### Permanent overlaps

Restore `PHYSICS_HZ=60`, `MERGE_CONTACT_MS=120`, and default maximum bodies. The game nudges old near-stationary bodies and bounds catch-up steps.

### Duplicate merges

Do not remove merge locks or mutate Matter bodies in browser code. Node is authoritative; each pair is locked before body removal.

### Score rises too fast

Increase auto-drop delays or reduce forced development actions. Score values and combo multiplier are bounded in `src/game.ts`; the renderer does not control score.

### Game ends early

Verify minimum duration settings were not reduced. Genuine critical-stack game-over is blocked before the minimum in normal mode. Test mode intentionally accelerates game-over/restart.

### Game never restarts

Check `GAME_RESTART_MIN_SECONDS` and `GAME_RESTART_MAX_SECONDS`, and watch for a fatal FFmpeg/browser/database error. A fatal stream failure intentionally shuts everything down instead of restarting gameplay without output.

### Bot looks repetitive

Leave `GAME_SEED` blank for a random first seed and allow multiple sessions. The bot uses hesitation, quick drops, aim error, matching, safe columns, and bounded risk; fixed seeds are intentionally repeatable.

### High CPU

Close other apps, confirm production uses VideoToolbox, keep 30 FPS, and run a long test. PNG capture is intentionally lossless for QR clarity. Do not add screen capture or a second renderer.

### High memory

Restore default active-ball/particle limits, inspect RSS in the dashboard, and stop duplicate processes. Frame backpressure stores at most one newest pending frame.

### FFmpeg broken pipe

Read the redacted `runtime/ffmpeg.log`. In production, check network and YouTube acceptance. The project pauses spawning, checkpoints, marks the session failed, and exits non-zero on unexpected FFmpeg exit.

### SQLite locked or corrupt

Stop all copies. For a lock, wait for the first process to close. For a confirmed corrupt disposable test database, move `runtime/game.db*` to a private backup and restart. Do not share a sensitive database.

### Test MP4 not playable

Allow graceful completion or press `Control+C` once and wait. Check `runtime/ffmpeg.log`, available disk space, and `ffprobe runtime/test-output.mp4`. Force-killing FFmpeg can leave an unfinalized MP4.

### Stream ends unexpectedly

Review the redacted FFmpeg log and terminal error, then run diagnostics and a full local test. Common causes are RTMPS rejection, network loss, browser crash, broken pipe, or sleep.

### Audio missing

The default is intentional silence. For music, provide the local MP3, set `ENABLE_AUDIO=true`, and restart. Browser preview audio and FFmpeg audio are separate.

### Music loop has a gap

Use a properly prepared seamless-loop MP3 that you are licensed to stream. FFmpeg uses `-stream_loop -1`; encoder padding in the source can still create a small gap.

### Guides visible in production

Keep `SHOW_DEVELOPMENT_GUIDES=false`, set `NODE_ENV=production`, rebuild, and start with `npm run start:production`. Do not stream from `npm run dev`.

# HOW TO SHARE THIS PROJECT WITH COPILOT FOR DEBUGGING

Share only the minimum reproducible technical material:

- `package.json`;
- `tsconfig.json`;
- `.env.example`;
- all files in `src/` and `public/`;
- the exact command you ran;
- the complete error output;
- the redacted `runtime/ffmpeg.log`;
- Node, FFmpeg, and macOS versions;
- Apple Silicon model;
- current `TEST_MODE` value;
- a preview screenshot if the issue is visual.

Never share:

- `.env`;
- stream key or full RTMPS URL;
- OAuth tokens;
- passwords or credentials;
- a sensitive SQLite database;
- decoded QR payload or payment details.

## Final zero-cost audit checklist

- [x] Node.js runs locally; no paid runtime.
- [x] TypeScript compiles locally.
- [x] FFmpeg is local and open source.
- [x] SQLite is a local file; no hosted server or hosted database.
- [x] Canvas 2D is local browser functionality.
- [x] Matter.js is free/open source.
- [x] WebSocket traffic is local.
- [x] Playwright/Chromium is local and free.
- [x] YouTube is configured manually through free official RTMPS functionality; no YouTube API.
- [x] No AWS.
- [x] No Azure.
- [x] No GCP.
- [x] No Firebase.
- [x] No Vercel, Render, Railway, DigitalOcean, VPS, or cloud hosting.
- [x] No hosted database.
- [x] No paid API.
- [x] No paid AI and no OpenAI, Gemini, or Claude API.
- [x] No paid media and no downloaded music.
- [x] No paid monitoring.
- [x] No paid authentication.
- [x] No paid CDN.
- [x] No paid storage.
- [x] No paid SaaS.
- [x] No paid game assets.
- [x] No paid or downloaded font.
- [x] No OBS.
- [x] No Streamlabs.
- [x] No screen capture or screen sharing.
- [x] No credit card is required by this project.
# web_game_stream
# web_game_stream
