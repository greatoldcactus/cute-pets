# cute-pets — spec

Desktop pets for OpenCode that carry **real session information** and let you **chat
from the pet**. Not a decorative bubble: a client of OpenCode's own server API.

## 1. Problem

Existing pet products put a sprite on screen and let an agent *push* reactions to it:
`react(thinking)`, `say("working…")`. That channel is write-only, sanitized to the point
of uselessness (no prompts, no paths, no titles), and unavailable at all on agents
without lifecycle hooks. The result is decoration that cannot answer:

- which of my sessions needs me right now,
- what is this session actually about,
- let me answer that approval without hunting for the terminal,
- let me continue this conversation from where I am looking.

Codex Pets solves this because it *is* the client. OpenCode's TUI is also just a client
of a local HTTP server — so a pet can be an equal peer instead of a notification sink.

## 2. Shape

```
opencode serve ──HTTP + SSE──▶ brain (src/) ──HTTP + SSE──▶ faces
      ▲                            │                        ├─ faces/web     (exists)
      └──── plugin announce ───────┘                        └─ faces/electron (planned)
```

- **Brain** (`src/`): no UI, no model logic. Holds the OpenCode client, the session/state
  machine, the permission queue, and serves snapshots to faces. Node 22+, zero deps.
- **Faces**: render `{pet, sessions, permissions}` and post commands back. Web face today;
  Electron pet window later. Same contract, so a platform problem never blocks features.
- **Plugin** (`plugin/cute-pets.ts`): announces where a server lives. Optional — the brain
  also discovers servers by scanning listening ports of `opencode` processes.

## 3. Verified OpenCode surface (1.18.7)

Checked against the live OpenAPI 3.1 spec at `/doc` and by driving a real session.

| Need | Call |
| --- | --- |
| session titles, dirs, tokens, cost | `GET /session` |
| state of every session | `GET /session/status` → `idle` \| `busy` \| `retry{attempt,message,action}` |
| pending approvals | `GET /permission` |
| answer an approval | `POST /permission/{id}/reply` `{reply: "once"\|"always"\|"reject"}` |
| create session | `POST /session` `{title?, agent?, model?}` |
| send prompt (no wait) | `POST /session/{id}/prompt_async` `{parts:[{type:"text",text}]}` |
| abort | `POST /session/{id}/abort` |
| history | `GET /session/{id}/message?limit=N` |
| live updates | `GET /event` (SSE) |
| jump the TUI to a session | `POST /tui/select-session` (planned) |

Event bus names confirmed in a real run: `session.created`, `session.updated`,
`session.status`, `session.idle`, `session.error`, `session.deleted`, `message.updated`,
`message.part.updated`, `message.part.delta`, `permission.asked`, `permission.replied`,
plus noisy infrastructure events (`plugin.added`, `server.heartbeat`, `catalog.updated`)
that the brain ignores.

Two traps found the hard way:

1. **`PluginInput.serverUrl` is not the listening URL.** With a server on port 4126 it
   reported `http://localhost:4096`. Never trust it for discovery; probe health first,
   then fall back to a port scan.
2. **All servers share one session database.** Four processes listed the same 18 sessions.
   The snapshot therefore collapses duplicates by session id, preferring an online server
   with live activity.

## 4. State model

Per session: `running` (busy), `waiting` (approval or question pending), `error`
(retry / session.error), `idle`. Priority for the pet and for list order:
`waiting > error > running > idle`.

| Input | Effect |
| --- | --- |
| `session.status {status:{type:"busy"}}` | running |
| `session.status {type:"idle"}` / `session.idle` | idle (unless a permission is pending → waiting) |
| `session.status {type:"retry"}` | error, detail from `action.label` |
| `session.error` | error |
| `permission.asked` / `permission.replied` | refetch `GET /permission`, recompute waiting |
| `message.part.updated` (text) | `lastText` tail |
| `message.part.delta` | append to `lastText` |

Pet rollup: `waiting` if any session waits, else `error`, else `running`, else `idle`;
label like "2 need you" / "1 failed" / "3 working" / "all done".

## 5. Face API (stable contract)

- `GET /api/state` — snapshot `{generatedAt, pet, servers[], sessions[], permissions[]}`
- `GET /api/events` — SSE, `event: state` with the same snapshot on every change (~120 ms debounce)
- `POST /api/prompt` — `{text, sessionId?|server?, newSession?, title?}` → `{server, sessionId}`
- `POST /api/abort` — `{server, sessionId}`
- `POST /api/permission` — `{id, reply}`
- `GET /api/messages?server&sessionId&limit` — normalized `{role, parts, tokens, time}`
- `POST /api/announce` — plugin discovery `{serverUrl, directory}`
- `GET /` — web face

Session object: `{server,id,title,slug,directory,dirName,agent,model,state,detail,tokens,cost,lastText,updatedAt,pending[]}`.

## 6. Pet rendering

Art stays compatible with the Codex/OpenPets format already on disk (`~/.codex/pets/<id>/`):
base frames 192×208, OpenPets-style activity strips (`activities/<id>.webp`, 4–32 frames,
1–12 fps), `pet.json` manifest. State → reaction mapping for the first Electron face:

| state | animation |
| --- | --- |
| idle | idle loop |
| running | working loop (thinking/editing variants from tool events later) |
| waiting | attention pose + badge, speech bubble with the permission name |
| error | error pose, stays until acknowledged |

## 7. Cross-platform

| | Windows | Linux X11 | Linux Wayland (native) | Linux Wayland (XWayland) |
| --- | --- | --- | --- | --- |
| transparent frameless | ✓ | ✓ | ✓ | ✓ |
| click-through | ✓ | ✓ (Electron ≥43) | ✓ (Electron ≥43; before that a no-op) | ✓ |
| drag pet | ✓ | ✓ | ✓ (draggable regions) | ✓ |
| park at position | ✓ | ✓ | ✗ `setPosition` unsupported | ✓ |
| always on top | ✓ | ✓ | ✗ `alwaysOnTop` unsupported | ✓ (compositor honors `_NET_WM_STATE_ABOVE`) |
| global hotkey | ✓ | mostly | portal-restricted | same |

Plan: one Electron binary (≥43). On Linux, detect `XDG_SESSION_TYPE=wayland` and default
to `--ozone-platform=x11` so the pet can be parked and pinned; offer `--ozone-platform=wayland`
for native mode (positions are compositor-controlled, user drags once). If a true
Wayland-native pet is ever required, add a `gtk4-layer-shell` face — a third surface, not
a rewrite, because the brain holds all state.

Platform isolation: faces keep the OS-specific bits behind `placePet / setClickThrough /
tray / notify / hotkey`. Tray is never the only door (GNOME needs AppIndicator), so the pet
window must open the session menu and composer itself. Autostart: XDG desktop file,
Run key, LaunchAgent. Packaging: AppImage first, deb/rpm later, no Flatpak in v1.

## 7b. Shell config

`~/.cute-pets/config.json` (shared dir with `brain.json`), read by the Electron shell:

| key | values | meaning |
| --- | --- | --- |
| `facing` | `"right"` (default) \| `"left"` | which way the sprite is drawn; `left` is a horizontal mirror |

Precedence: `--facing` CLI flag → config file → default. Changing facing in the UI
(double-click) writes the file, so it survives restarts. Window position is also worth
persisting later; it is desktop-owned state, not a session concern.

## 8. Risks to verify

1. **Two writers.** Chatting from the pet while the TUI has the same session open — does
   the TUI repaint live? If not, the face must warn or defer to the TUI.
2. **Title generation timing.** Titles appear after the first exchange; keep a placeholder.
3. **Question requests** (`/api/session/{id}/question`) — not wired yet; these are "needs
   input" too and deserve the same approval UI.
4. **Permission replies are powerful.** Anyone who can reach 4280 can approve tool calls.
   v1 binds 127.0.0.1 and documents that; a token is the next step.
5. **Platform spikes.** XWayland always-on-top under GNOME, native-Wayland click-through
   on Electron 46, tray availability, fractional-scaling sharpness.

## 9. Status

Done: brain daemon with discovery, state machine, permission queue, SSE fanout; web face
(tray + approvals + chat); plugin; smoke test that drives a real session end-to-end.

Next: Electron pet face with sprite rendering; TUI jump; question requests; token auth;
packaging.
