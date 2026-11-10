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

```bash
# 1. start an opencode server you can attach to (any port)
opencode serve --port 4096

# 2. start the brain; it finds opencode servers by scanning their listening ports
node src/main.mjs
# or attach explicitly:
node src/main.mjs --server http://127.0.0.1:4123

# 3. open the face
#    http://127.0.0.1:4280
```

Zero-config alternative: copy `plugin/cute-pets.ts` into `~/.config/opencode/plugins/`
(auto-discovered) and start the brain whenever you like — the plugin re-announces its
server URL every 30s, so ordering never matters.

```bash
node scripts/smoke.mjs    # end-to-end check against a live server
```

## What it does today

- Lists every session with its real title, project directory, agent and token/cost totals.
- Tracks per-session state from the event bus: `running` / `waiting` (approval pending) /
  `error` / `idle`, with a pet-level rollup that prioritizes what needs you.
- Shows the streaming tail of the assistant's latest message.
- **Approves or rejects permission requests** from the face — `once` / `always` / `reject`.
- Sends new requests (new session or into an existing one) and aborts a running session.

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
