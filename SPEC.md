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
      ▲                            │                        ├─ faces/web
      └──── plugin announce ───────┘                        ├─ pet window     (sprite)
                                                            ├─ bubbles window (bubble stack)
                                                            └─ panel window   (sessions + chat)
```

- **Brain** (`src/`): no UI, no model logic. Holds the OpenCode client, the session/state
  machine, the permission queue, and serves snapshots to faces. Node 22+, zero deps.
- **Faces**: render `{pet, sessions, permissions}` and post commands back. The Electron
  shell is three windows sharing one page by `#pet`/`#bubbles`/`#panel`; the web face is
  another surface. Same contract, so a platform problem never blocks features. The sprite
  window never resizes: the bubble and panel windows are sized/placed around it.
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

Per session: `running` (busy), `waiting` (approval, agent form/question, or plan answer
pending), `error` (retry / session.error), `idle`. Priority for the pet and for list
order: `waiting > error > running > idle`. Within a priority, active sessions are sorted by
creation time (`createdAt`, oldest first) and idle sessions by `updatedAt` (newest first).
Active sessions deliberately ignore last-update recency: several sessions streaming at once
would otherwise reshuffle the list and the bubble stack every few frames, moving buttons out
from under the cursor. `updatedAt` uses the server's `session.time.updated` and local
message/activity events; periodic syncs do not refresh it, so idle order stays stable and
reflects the last real update.

| Input | Effect |
| --- | --- |
| `session.status {status:{type:"busy"}}` | running |
| `session.status {type:"idle"}` / `session.idle` | idle (unless a permission or form is pending → waiting) |
| `session.status {type:"retry"}` | error, detail from `action.label` |
| `session.error` | error |
| `permission.asked` / `permission.replied` | refetch `GET /permission`, recompute waiting |
| `form.created` (v2) | add the pending form, recompute waiting |
| `form.replied` / `form.cancelled` (v2) | drop the form, recompute waiting (back to `running` if the turn is still busy) |
| `message.part.updated` (text) | `lastText` tail |
| `message.part.delta` | append to `lastText` |
| `session.deleted` | remove the session immediately |
| `session.activity` (v2 reasoning/tool) | update the live trace preview |

`GET /api/session` is authoritative on the 30 s sync; sessions that disappear from it are
removed, which also cleans up deleted sessions whose event was missed.

Pet rollup: `waiting` if any session waits, else `error`, else `running`, else `idle`;
label like "2 need you" / "1 failed" / "3 working" / "all done". The driving session is the
first in list order, except that a plan session wins within the same priority. If it uses
the `plan` agent and is not idle, the snapshot's `pet.plan` is true and the kind is
`planning`.

Message errors are rendered as fatal (red) only when the turn did not continue: if any
later assistant message without an error exists, the earlier error was retried and is
shown muted as `retried`. A retryable error (429/5xx/network/timeout) is shown as
`retrying` while the session is still running. The same rule keeps the collapsed process
trace from turning red for a recovered provider/tool failure.

Session records include a live `activity`
`{kind:"thinking"|"tool", text, tool, detail, status, at}` from v2
`session.reasoning.*` and `session.tool.*` events; the face uses it for the last process
trace preview and clears it when the session becomes idle.

## 5. Face API (stable contract)

- `GET /api/state` — snapshot `{generatedAt, pet, servers[], sessions[], permissions[], forms[]}`
- `GET /api/events` — SSE, `event: state` with the same snapshot on every change (~120 ms debounce)
- `POST /api/prompt` — `{text, sessionId?|server?, newSession?, title?, directory?, model?, agent?, delivery?}`
  → `{server, sessionId, session}`; v2 creates the session with a `location`
- `GET /api/defaults` — `{directory, server, model, agent}`: the fallback for a blank
  chat when no session is selected (last used values / server default)
- `POST /api/checkdir` — `{directory, server?}` → `{ok, directory, server, wsl}`;
  validates on the brain host or its WSL UNC mount
- `POST /api/abort` — `{server, sessionId}`
- `POST /api/permission` — `{id, reply}`
- `POST /api/form` — `{server, sessionId, formId, answer}`; answers a v2 agent question
  and returns `{ok:true}`
- `POST /api/session/action` — `{sessionId, action, value}`; includes `move` (v2),
  `fork`, `model`, `agent`
- `GET /api/messages?server&sessionId&limit` — normalized
  `{role, parts, tokens, time, error}`; parts are `text`, `reasoning`, `tool`
  (`name/status/input/output`) or `file`, so faces can collapse the process trace
- `GET /api/message-page?server&sessionId&limit&order&type&cursor&compact`
  — the same normalized messages plus the v2 `cursor` (`{previous,next}`) and `hasMore`.
  A lookahead row is requested because v2 returns a cursor even on the last page;
  `hasMore` is what decides whether the face shows “Load earlier”. Cursor pages are used
  for “Load earlier”; `type=user&order=asc&limit=1` fetches the opening prompt.
- `POST /api/announce` — plugin discovery `{serverUrl, directory}`
- `GET /` — web face

Session object: `{server,id,title,slug,directory,dirName,agent,model:{id,providerID,variant},state,detail,activity,tokens,cost,lastText,createdAt,updatedAt,pending[],forms[]}`.

## 6. Pet rendering

Art stays compatible with the Codex/OpenPets format already on disk (`~/.codex/pets/<id>/`):
base frames 192×208, OpenPets-style activity strips (`activities/<id>.webp`, 4–32 frames,
1–12 fps), `pet.json` manifest. State → reaction mapping for the first Electron face:

| state | animation |
| --- | --- |
| idle | idle loop |
| running | working loop (thinking/editing variants from tool events later) |
| waiting | attention pose + badge; bubble with an `answer`/`approve` badge, amber pulsing dot and the permission/form named in its tooltip |
| error | error pose, stays until acknowledged |
| plan | review pose (row 8) with a violet aura |

Each state has a coloured aura: idle green (`#6ee7a8`), running blue (`#5ac8ff`),
waiting amber (`#ffc65c`), error red (`#ff6b6b`), plan violet (`#a78bfa`). Plan mode keeps
the waiting/error pose when it needs attention, but uses the violet aura; its bubble still
shows the amber waiting badge/dot. The whole aura layer is gated by the shell config
`auras` (Settings → Auras).

Codex V2 sheets use `0 idle, 1 running-right, 2 running-left, 3 waving, 4 jumping,
5 failed, 6 waiting, 7 running, 8 review, 9–10 look directions`. The face uses
`{idle:0, running:2, waiting:6, error:5, plan:8}` by default; a pack can override any
entry with `"rows"` in `pet.json` (the built-in chibi-knight declares `error:9` because
its sheet is custom and has no review row). Plan mode keeps the waiting/error pose when
it needs attention, but always keeps the violet colour/aura.

## 7. Cross-platform

| | Windows | Linux X11 | Linux Wayland (native) | Linux Wayland (XWayland) |
| --- | --- | --- | --- | --- |
| transparent frameless | ✓ | ✓ | ✓ | ✓ |
| click-through | ✗ see note | ✗ see note | ✗ see note | ✗ see note |
| drag pet | ✓ | ✓ | ✓ (draggable regions) | ✓ |
| park at position | ✓ | ✓ | ✗ `setPosition` unsupported | ✓ |
| always on top | ✓ | ✓ | ✗ `alwaysOnTop` unsupported | ✓ (compositor honors `_NET_WM_STATE_ABOVE`) |
| global hotkey | ✓ | mostly | portal-restricted | same |

Click-through note: `IgnoreMouseEventsOptions.forward` is Windows/macOS only, and
XWayland derives a surface's input region from the X input shape. Electron's
`setIgnoreMouseEvents(true)` empties that shape, and nothing can restore it from the page
once it is empty. Instead of click-through, the shell uses three content-sized windows:
the sprite window is fixed (`260×222`, never resized), the bubble window is sized to the
stack, and the panel window is sized to the room above/below the sprite when it opens.
Each window covers only what it draws, so the space around them belongs to other apps,
and nothing ever resizes the sprite window — a bubble appearing/disappearing or the panel
opening cannot move the pet. The tooltip is drawn pointer-transparently in the pet window
on behalf of the bubble window.

Plan: one Electron binary (≥43). On Linux, detect `XDG_SESSION_TYPE=wayland` and default
to `--ozone-platform=x11` so the pet can be parked and pinned; offer `--ozone-platform=wayland`
for native mode (positions are compositor-controlled, user drags once). If a true
Wayland-native pet is ever required, add a `gtk4-layer-shell` face — a third surface, not
a rewrite, because the brain holds all state.

Platform isolation: faces keep the OS-specific bits behind `placePet / placePanel /
placeBubbles / tray / notify / hotkey`. Tray is never the only door (GNOME needs
AppIndicator), so the pet window opens the shell-owned panel window, which carries the
session menu and composer. Autostart: XDG desktop file, Run key, LaunchAgent. Packaging:
AppImage first, deb/rpm later, no Flatpak in v1.

## 7b. Shell config

`~/.cute-pets/config.json` (shared dir with `brain.json`), read by the Electron shell:

| key | values | meaning |
| --- | --- | --- |
| `facing` | `"right"` (default) \| `"left"` | which way the sprite is drawn; `left` is a horizontal mirror |
| `lastDirectory` | absolute path | last directory a chat was created in / moved to; fallback for a blank chat when no session is selected |
| `lastModel` | `{id,providerID,variant}` | last model or effort picked with `/model` / `/effort`; fallback for a blank chat |
| `lastAgent` | string | last agent picked with `/agent`; fallback for a blank chat |
| `auras` | boolean (default `true`) | coloured glow around the pet for idle/running/waiting/error/plan |
| `sendWith` | `"ctrl-enter"` (default) \| `"enter"` | whether Ctrl/Cmd+Enter or Enter sends; in Enter mode Shift+Enter adds a newline |
| `petPosition` | `{x,y}` | last pet window position in screen coordinates; restored if it still overlaps a display |

Precedence: `--facing` CLI flag → config file → default. Changing facing in the UI
(double-click) writes the file, so it survives restarts. The pet position is written on
drag end and menu moves; it is desktop-owned state, not a session concern.

Multi-monitor placement uses the union of all display work areas (`screen.getAllDisplays`)
rather than the display the window currently matches, so the sprite can cross a monitor
seam. If a diagonal layout leaves a hole, the position snaps to the nearest work area;
`display-added`/`display-removed`/`display-metrics-changed` re-clamp it. The bubble and
panel windows use `getDisplayMatching(petWin)` and therefore follow the pet to its
monitor. Right-click → **Move to display** parks the pet on a chosen display. Native
Wayland may still refuse programmatic positioning; the shell's XWayland mode is unaffected.

## 7c. Remote / WSL servers

- `POST /api/attach` / `/api/detach` attach by URL; attached URLs persist in
  `~/.cute-pets/config.json` (`servers`) and are re-attached at startup.
- A workspace is matched by the server's own `GET /path.directory`, **not** by session
  directories: every opencode process reports every session (shared store), so session
  directories cannot identify a server.
- On Windows, a new chat with a POSIX path is rejected with instructions to attach the
  WSL server instead of spawning a local one.
- **OpenCode 2.x is supported** through `src/opencode-v2.mjs`, detected by probing
  `/global/health` then `/api/info`. Differences handled there: HTTP Basic auth
  (`opencode:<password>`), `/api/*` prefix, `{data}` envelope, `location.directory`,
  `content[]` instead of `parts[]` (user text is `m.text`), newest-first message order,
  `delivery:"steer"` for follow-ups while a turn is running and `delivery:"queue"` for
  `/queue`, `interrupt` instead of `abort`, `{action,resources}` permission replies, and
  event translation
  (`session.execution.*`/`session.text.*` → v1 names, plus `session.deleted`,
  `session.reasoning.*` and `session.tool.*` for the live activity preview). The durable
  inbox (`GET /api/session/{id}/inbox`, `PATCH`/`DELETE .../{inboxID}`) backs the queue
  strip; the brain tracks inbox items from `session.inbox.*` events and hydrates active
  sessions on attach. Fork is implemented
  (`POST /api/session/{id}/fork`; `session.forked` carries no info, so the client fetches
  the new session to pick up its `(fork #N)` title). Model/agent switch
  (`/api/session/{id}/model`, `/agent`), session move (`/api/session/{id}/move`) and
  creating at a `location` are implemented for v2. Compact/share/revert are not.
- **v2 forms** are agent questions that block a session: `GET /api/form?location[directory]=…`
  lists pending forms for a location, `POST /api/session/{id}/form/{formID}/reply`
  `{answer}` answers one, and `DELETE …/form/{formID}?message=…` cancels. Events are
  `form.created` (`data.form`), `form.replied` and `form.cancelled`. Fields are
  `string` (optionally with `options`/`custom`), `number`, `integer`, `boolean`,
  `multiselect` and `external`; the answer is `{key: value}` and an external field must be
  acknowledged with `true`. The brain fetches forms per session directory, turns a
  pending form into `waiting`, and exposes the answer route as `POST /api/form`.
- **Plan mode uses a synthetic reminder.** Creating a session with the `plan` agent (or
  switching to or from it) enqueues a `synthetic` message with `delivery:"steer"` and
  `resume:false` containing the Plan-mode reminder. It does not start a turn by itself:
  the next prompt wakes the session and the reminder is delivered first. The brain checks
  the session inbox (waiting briefly right after a plan create/switch, because the
  reminder is admitted asynchronously) and sends that prompt with `delivery:"steer"` too,
  so both are delivered into the same turn. Queueing would make the model answer the
  reminder alone first and only see the user's message after that turn.
- **Directories are server-side.** v2 servers host sessions at arbitrary locations on
  one server; v1 servers are bound to one cwd and need a spawned server per directory.
  `/cd` validates the path on the brain host (or maps a WSL POSIX path through
  `//wsl.localhost/<distro>`), then moves a v2 session or sets the draft directory for
  the first message. No native folder picker: it only sees the Windows filesystem.

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
