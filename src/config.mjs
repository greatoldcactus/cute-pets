// Shared shell/brain config: ~/.cute-pets/config.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir() {
  // Tests and portable installs can point the brain at an isolated directory.
  return process.env.CUTE_PETS_STATE_DIR || path.join(os.homedir(), ".cute-pets");
}

export function configPath() {
  return path.join(stateDir(), "config.json");
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[cute-pets] config write failed:", err.message);
  }
  return next;
}
