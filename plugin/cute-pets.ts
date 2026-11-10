// cute-pets – OpenCode plugin.
//
// Purpose: tell a running cute-pets brain where this OpenCode server lives, so
// the pet can attach without manual configuration. The brain then talks to the
// server's own HTTP API (sessions, status, permissions, SSE events) directly.
//
// Enable it by copying this file to ~/.config/opencode/plugins/ (auto-discovered)
// or by adding the directory to "plugins" in opencode.jsonc.
//
// Env: CUTE_PETS_BRAIN overrides the brain URL (default http://127.0.0.1:4280).

const BRAIN = (process.env.CUTE_PETS_BRAIN ?? "http://127.0.0.1:4280").replace(/\/+$/, "");
const ANNOUNCE_EVERY_MS = 30_000;

type PluginInput = {
  serverUrl: URL | string;
  directory: string;
};

async function announce(serverUrl: string, directory: string): Promise<boolean> {
  try {
    const res = await fetch(`${BRAIN}/api/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverUrl, directory }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const CutePets = async ({ serverUrl, directory }: PluginInput) => {
  const url = String(serverUrl);
  void announce(url, directory);

  // Re-announce on an interval so a brain started after OpenCode still finds us.
  const timer = setInterval(() => void announce(url, directory), ANNOUNCE_EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {};
};
