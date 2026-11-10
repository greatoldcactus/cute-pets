# cute-pets

Desktop pets for [OpenCode](https://opencode.ai) that show **real sessions** — titles,
states, approvals and chat — instead of a decorative bubble.

![cute-pets](docs/screenshot.png)

Codex Pets can do this because it *is* a client of its agent. So is cute-pets: it is a
client of OpenCode's own HTTP+SSE server, not an MCP sink. It knows your session titles,
which session is blocked on an approval, what the model just said, and it can type back
into any of them. No tokens spent, no hooks required.

```
          opencode serve ──HTTP+SSE──▶ brain ──HTTP+SSE──▶ faces
                 ▲                    (src/)               ├─ Electron pet window
                 └── plugin announce ──┘                   └─ web tray / pet-only
```

- **brain** (`src/`, Node 22, zero runtime dependencies) — holds the OpenCode client,
  the state machine, the permission queue, and serves snapshots.
- **faces** (`electron/`, `faces/web/`) — a frameless always-on-top sprite window and a
  browser session tray. Both render the same `{pet, sessions, permissions}` snapshot.
- **plugin** (`plugin/cute-pets.ts`, optional) — tells the brain where a server lives.

---

## Install and run

Requirements: **Node ≥ 22**, the **opencode** CLI on `PATH`, and (for the pet window)
Electron, which is already a devDependency.

```bash
npm install
node node_modules/electron/install.js    # only if "Electron failed to install correctly"

npm run brain    # terminal 1 — brain on http://127.0.0.1:4280
npm run shell    # terminal 2 — the floating pet
```

The brain finds `opencode` servers by itself: it scans the listening ports of `opencode`
processes and probes `/global/health` (v1) or `/api/info` (v2). Start a TUI whenever you
like — new servers are picked up within ~10 seconds.

Browser faces, if you prefer: <http://127.0.0.1:4280> (session tray) and
<http://127.0.0.1:4280/min.html> (pet-only view).

### Five things to try first

1. **Click the pet** — the panel opens next to her; click again to close.
2. **Drag her** anywhere, including to the very top of the screen. Double-click flips the
   sprite horizontally.
3. **`+`** opens a compact popover: type a request, pick a folder, start a chat.
4. **`/` in the composer** lists commands — agent ones (`/init`, `/review`) and pet ones
   (`/model`, `/agent`, `/compact`, `/undo`, `/redo`, `/share`, `/abort`, `/pets`).
5. **Right-click a session or bubble → Hide from pet** to clear finished work out of the
   way. Nothing is deleted; Settings has an *unhide* list.

---

## What it does

**Sessions** — every session with its real title, project directory, agent, model and
token/cost totals, deduplicated across the several `opencode serve` processes that can
share one database.

**States** — `running`, `waiting` (an approval is pending), `error`, `idle`, rolled up per
pet with the urgent one winning. Bubbles float above the sprite for the sessions that need
attention; hovering one shows its title, directory, state and the tail of the last message.

**Approvals** — permission requests are rendered as buttons: *once*, *always*, *reject*.
Answered from the pet, the TUI never has to be found.

**Chat** — type into any session from the panel, or start a new one. A folder without a
running server gets its own `opencode serve` (Windows paths only — a Linux path must be an
attached WSL server, and the brain says so instead of guessing).

**New chat popover** — prompt, folder, start; four lines instead of a full panel. `Ctrl+N`
and the pet's right-click menu reach the same thing.

**Pet packs** — Codex/OpenPets-compatible spritesheets (192×208 cells, 8 columns). A
red-armoured chibi knight ships in the repo and is installed by default; any `.zip` or
folder can be imported, switched at runtime and mirrored.

**Placement** — the window is a fixed 560×800 with a transparent margin. Dragging clamps the
*sprite*, not the window, so she can be parked against the top edge. When there is no room
above her, the panel flips **below** and the window shifts by the same amount, so the sprite
never appears to jump. Menus are placed to the side of the sprite and never cover her.

**Hidden sessions** — pet-side only: the session keeps existing (and running) in OpenCode,
it just stops appearing on the pet. Persisted in `~/.cute-pets/hidden.json`, restorable from
*Settings → Hidden from pet*.

---

## Pet packs

### The built-in pet

The repo ships one pack, `pets/chibi-knight/` — an original red-armoured chibi knight,
8 columns × 11 rows of 192×208 cells. It was generated for this project, so a default
install has a pet that belongs to it rather than borrowing a character from a game.

On first run the brain copies it into `~/.cute-pets/pets/` and makes it the active pet
if you have not chosen one; `GET /api/pet` serves it straight from the repo even before
that copy exists. Importing any other pack simply takes over as the active choice — the
built-in one stays in the list, and deleting `~/.cute-pets/pets/chibi-knight` brings it
back on the next start.

```bash
npm run pets -- list                         # installed pets, * = active
npm run pets -- import brawl-worker          # by Codex pet id (~/.codex/pets/<id>)
npm run pets -- import C:/path/pack.zip      # a .zip or a directory
npm run pets -- use saber                    # switch
```

A pack is a directory with `pet.json` and a spritesheet:

```json
{
  "id": "saber",
  "displayName": "Saber",
  "description": "A watchful Saber companion in blue and silver armor.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

Cells are 192×208, 8 columns; rows map to the pet's animations. Packs live in
`~/.cute-pets/pets/<id>/`, and the active one is `activePet` in the config.

---

## Connecting servers

Local processes are discovered automatically. Anything else can be attached:

```bash
curl -X POST http://127.0.0.1:4280/api/attach -d '{"url":"http://localhost:4096"}'
curl -X POST http://127.0.0.1:4280/api/detach -d '{"url":"http://localhost:4096"}'
```

Attached URLs are saved under `servers` in `~/.cute-pets/config.json` and re-attached at
start. WSL2 forwards `localhost`, so a server started inside WSL as
`opencode serve --hostname 0.0.0.0 --port 4096` is reachable from Windows at
`http://localhost:4096`.

**OpenCode 2** needs HTTP Basic credentials (`opencode:<password>`):

```bash
# in WSL
OPENCODE_SERVER_PASSWORD=… /home/user/.opencode/bin/opencode serve --hostname 0.0.0.0 --port 4301

# once, from Windows — the credential is stored and reused at every start
curl -X POST http://127.0.0.1:4280/api/attach \
  -d '{"url":"http://localhost:4301","password":"…"}'
```

or `npm run brain -- --server http://localhost:4301 --password …`. A managed v2 service
writes `~/.local/state/opencode/service.json` with its URL and password.

v2 differences worth knowing: prompts are sent with `delivery: "queue"` (the default
`steer` is dropped when no turn is running), messages come newest-first with `content[]`
instead of `parts[]`, and user text sits at `m.text`. `/model`, `/agent`, `/compact`,
`/share`, `/undo`, `/redo` are **not wired for v2** — their request bodies differ and were
not verified.

---

## Configuration and files

| Path | What |
| --- | --- |
| `~/.cute-pets/config.json` | `facing`, `activePet`, attached `servers` (with credentials) |
| `pets/<id>/` (repo) | packs that ship with cute-pets: `chibi-knight` |
| `~/.cute-pets/pets/<id>/` | installed pet packs (the built-in one is copied here on first run) |
| `~/.cute-pets/hidden.json` | sessions hidden from the pet |
| `~/.cute-pets/brain.json` | written by a running brain |
| `~/.cute-pets/brain.log` | brain log (same lines as stdout) |

Facing is a config value, never inferred from screen position:

```json
{ "facing": "left" }
```

`right` (default) is the sprite as authored, `left` is mirrored. Override per launch with
`npm run shell -- --facing left`.

---

## Brain API

Everything a face needs, all JSON:

```
GET  /api/state            {pet, sessions[], permissions[], servers[], hidden[]}
GET  /api/events           SSE stream of the same snapshot
GET  /api/health           {ok, uptime}
GET  /api/pet  /api/pets   active pet + installed packs
POST /api/pets/import      {path}            .zip or folder
POST /api/pets/active      {id}
GET  /api/commands         agent commands from OpenCode (init, review, …)
GET  /api/models  /api/agents  /api/workspaces
POST /api/prompt           {text, sessionId?|newSession, directory?, model?, agent?}
GET  /api/messages         ?server=&sessionId=&limit=
POST /api/permission       {id, reply: once|always|reject}
POST /api/abort            {server, sessionId}
POST /api/session/hide     {sessionId, hidden:true|false}
POST /api/session/action   {sessionId, action: compact|undo|redo|share|model|agent, …}
POST /api/attach  /api/detach  /api/announce
POST /api/session/close    {server, sessionId}   — deletes in OpenCode, no UI uses it
```

---

## Limitations

- OpenCode 2: model switch, agent switch, compact, share, undo/redo are v1-only.
- Permission replies on v2 use `{action, resources}`; that path has not been exercised
  against a live request.
- The window is fixed-size by design (resizing a transparent window flickers on Windows),
  so the panel flips instead of growing.
- Linux/macOS: the Electron shell is portable, but only Windows has been run in anger;
  click-through and work-area clamping are the platform-specific parts.

## Development

```bash
npm run smoke        # end-to-end: attach, create a session, prompt, read the reply
```

`npm run shell -- --dev` exposes a control server on `:4290` with `/size`, `/eval?js=…`
and `/shot?file=…` — that is how the screenshot above was produced.

```
src/main.mjs        hub: discovery, attach, dispatch, hidden persistence
src/opencode.mjs    v1 client        src/opencode-v2.mjs  v2 client (auth, /api/*, events)
src/state.mjs       session/state machine, permissions, snapshots
src/server.mjs      face API + SSE      src/pets.mjs  pet store + built-in seeding
src/config.mjs      ~/.cute-pets/config.json
pets/chibi-knight/  the pack that ships with the repo
electron/main.cjs   sprite window, drag, dialogs, bounds lock
faces/web/min.html  the pet window UI   faces/web/index.html  full tray
```

`SPEC.md` holds the verified OpenCode surface, the state mapping and the cross-platform
notes.
