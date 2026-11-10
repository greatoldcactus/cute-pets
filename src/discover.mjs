// Finds running `opencode` servers by looking at which ports its processes listen on.
// Works without any plugin and without knowing the port (the TUI picks a random one).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

function uniqPorts(entries) {
  return [...new Set(entries)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

async function windows() {
  const [tasks, netstat] = await Promise.all([
    pexec("tasklist", ["/FO", "CSV", "/NH"], { maxBuffer: 8 << 20 }).catch(() => ({ stdout: "" })),
    pexec("netstat", ["-ano", "-p", "TCP"], { maxBuffer: 16 << 20 }).catch(() => ({ stdout: "" })),
  ]);
  const pids = new Set();
  for (const line of tasks.stdout.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 2) continue;
    const name = cols[0].replace(/"/g, "").toLowerCase();
    const pid = cols[1].replace(/"/g, "");
    if (name.startsWith("opencode") || name === "bun.exe") pids.add(pid);
  }
  const ports = [];
  for (const line of netstat.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;
    if (!pids.has(parts[4])) continue;
    const m = parts[1].match(/:(\d+)$/);
    if (m) ports.push(Number(m[1]));
  }
  return uniqPorts(ports);
}

async function linux() {
  const { stdout } = await pexec("ss", ["-ltnpH"], { maxBuffer: 8 << 20 }).catch(() => ({ stdout: "" }));
  const ports = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!/opencode/i.test(line)) continue;
    const m = line.match(/\s(\S+):(\d+)\s/);
    if (m) ports.push(Number(m[2]));
  }
  return uniqPorts(ports);
}

async function darwin() {
  const { stdout } = await pexec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { maxBuffer: 8 << 20 }).catch(() => ({ stdout: "" }));
  const ports = [];
  let isOpencode = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("p")) isOpencode = false;
    else if (line.startsWith("c")) isOpencode = /opencode/i.test(line.slice(1));
    else if (line.startsWith("n") && isOpencode) {
      const m = line.match(/:(\d+)$/);
      if (m) ports.push(Number(m[1]));
    }
  }
  return uniqPorts(ports);
}

export async function findOpencodePorts() {
  try {
    if (process.platform === "win32") return await windows();
    if (process.platform === "darwin") return await darwin();
    return await linux();
  } catch {
    return [];
  }
}
