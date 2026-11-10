# cute-pets

Desktop pets for [OpenCode](https://opencode.ai) that show **real sessions** — titles,
states, approvals, and chat — instead of a decorative bubble.

You already see the difference: Codex Pets tell you *"Needs input"* and let you jump
back to the thread. OpenPets tells you *"thinking…"* and nothing else. cute-pets is
built the other way round: it is a **client of OpenCode's own server API**, so it
knows your session titles, which session is blocked on approval, what the model
just said, and it can type back into any session.

```
cute-pets/
  src/          brain daemon (Node 22, zero dependencies)
  plugin/       OpenCode plugin that points the brain at a running server
  faces/web/    browser face (session tray + approvals + chat)
  scripts/      smoke test
```

## Run it

Requirements: Node ≥ 22 and the `opencode` CLI on PATH.

```bash
cd C:/projects/cute-pets
npm install                                  # first time
node node_modules/electron/install.js        # only if the Electron binary is missing

npm run brain     # terminal 1: brain on http://127.0.0.1:4280
npm run shell     # terminal 2: the floating pet
```

The shell finds opencode servers by itself (it scans listening ports of `opencode`
processes), so you do not have to point it at anything. Start `opencode` / the TUI
whenever you like — new servers are picked up within ~10 s.

Useful extras:

```bash
npm run pets -- list                              # installed pets, * = active
npm run pets -- import brawl-worker               # a Codex pet id
npm run pets -- import C:/path/pack.zip           # a .zip pack or a folder
npm run pets -- use saber                         # switch

npm run shell -- --facing left                    # override facing for one run
npm run smoke                                     # end-to-end check against the brain
```

Browser face instead of the floating window: open **http://127.0.0.1:4280** (full
session tray, approvals, chat) — or `/min.html` for the pet-only view.

Config lives in `~/.cute-pets/config.json` (`facing`, `activePet`); pets are stored in
`~/.cute-pets/pets/<id>/`; a running brain writes `~/.cute-pets/brain.json`.

### Optional: zero-config attachment

Copy `plugin/cute-pets.ts` into `~/.config/opencode/plugins/` (auto-discovered). The
plugin announces the server URL to the brain every 30 s, so ordering never matters.
Without it, discovery still works by port scan.

### Troubleshooting

- `EADDRINUSE` on 4280 — an older brain is still running: find the PID with
  `netstat -ano | findstr :4280` and `taskkill /F /PID <pid>`.
- `Electron failed to install correctly` — run `node node_modules/electron/install.js`.
- Pet shows but nothing reacts — check `curl http://127.0.0.1:4280/api/state`; if
  `servers` is empty, no opencode server is running.

## What it does today

- Lists every session with its real title, project directory, agent and token/cost totals.
- Tracks per-session state from the event bus: `running` / `waiting` (approval pending) /
  `error` / `idle`, with a pet-level rollup that prioritizes what needs you.
- Shows the streaming tail of the assistant's latest message.
- **Approves or rejects permission requests** from the face — `once` / `always` / `reject`.
- Sends new requests (new session or into an existing one) and aborts a running session.

## Moving and facing the pet

Drag her by the sprite: the window follows the cursor, clamped to the work area. A press
that moves less than 4px counts as a click and opens the panel instead.

Facing is **not** derived from where the window sits — it is a config value:

```json
// ~/.cute-pets/config.json
{ "facing": "left" }
```

- `"right"` (default) — sprite as authored
- `"left"` — horizontally mirrored
- override per launch: `npx electron electron/main.cjs --facing left`
- double-click the pet to flip and save it

## Architecture

```
opencode serve  ──HTTP+SSE──▶  brain (src/)  ──HTTP+SSE──▶  faces (web, later Electron)
       ▲                          │
       └──── plugin announce ─────┘
```

The brain holds no model logic and no UI. Faces are replaceable: the web face today,
an Electron pet window tomorrow, each rendering the same `pet / sessions / permissions`
snapshot.

See `SPEC.md` for the verified API surface, the state mapping, and the cross-platform
plan (X11 / Wayland / Windows).
