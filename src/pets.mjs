// Pet store: ~/.cute-pets/pets/<id>/ (pet.json + spritesheet).
// Imports come from a folder or a .zip pack, e.g. a Codex pet in ~/.codex/pets/<id>.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readConfig, writeConfig, stateDir } from "./config.mjs";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// The pack that ships with the repo. It is installed on first run and becomes the
// default pet, so a fresh checkout has something to show without importing anything.
export const BUILTIN_ID = "chibi-knight";

export function petsDir() {
  return path.join(stateDir(), "pets");
}

export function builtinDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "pets", BUILTIN_ID);
}

// Idempotent: copy the built-in pack into the store if it is missing, and make it
// the active pet when the user has not chosen one yet.
export function ensureBuiltin() {
  const src = builtinDir();
  if (!readPetJson(src)) return null;
  const dest = path.join(petsDir(), BUILTIN_ID);
  if (!readPetJson(dest)) {
    ensureDir(petsDir());
    try {
      // Only the pack itself: build scripts, source poses and vendored wheels stay
      // in the repo, not in the user's store.
      fs.cpSync(src, dest, {
        recursive: true,
        filter: (from) => !path.basename(from).startsWith("_"),
      });
    } catch {
      return null;
    }
  }
  if (!readConfig().activePet) writeConfig({ activePet: BUILTIN_ID });
  return BUILTIN_ID;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readPetJson(dir) {
  const file = path.join(dir, "pet.json");
  if (!fs.existsSync(file)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!meta.spritesheetPath) return null;
    return meta;
  } catch {
    return null;
  }
}

// A pack may put pet.json at the root or inside a single wrapper folder.
function locatePetRoot(dir) {
  if (readPetJson(dir)) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const sub = path.join(dir, entry.name);
    if (readPetJson(sub)) return sub;
  }
  return null;
}

function extractZip(zipPath, target) {
  ensureDir(target);
  try {
    execFileSync("tar", ["-xf", zipPath, "-C", target], { stdio: "pipe" });
    return true;
  } catch {}
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${target}' -Force`],
      { stdio: "pipe" },
    );
    return true;
  }
  return false;
}

export function listPets() {
  ensureBuiltin();
  const dir = petsDir();
  const active = readConfig().activePet ?? null;
  if (!fs.existsSync(dir)) return { active, pets: [] };
  const pets = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readPetJson(path.join(dir, entry.name));
    if (!meta) continue;
    pets.push({
      id: entry.name,
      name: meta.displayName || meta.name || entry.name,
      description: meta.description ?? "",
      active: entry.name === active,
      spritesheetPath: meta.spritesheetPath,
    });
  }
  pets.sort((a, b) => a.name.localeCompare(b.name));
  return { active, pets };
}

export function activePet() {
  const { active, pets } = listPets();
  if (!pets.length) return null;
  const chosen = pets.find((p) => p.id === active) ?? pets[0];
  return { ...chosen, builtin: chosen.id === BUILTIN_ID };
}

export function petAsset(petId, relPath) {
  // Serve from the store, falling back to the shipped pack before it is seeded.
  const roots = [path.join(petsDir(), petId)];
  if (petId === BUILTIN_ID) roots.push(builtinDir());
  for (const root of roots) {
    const resolved = path.resolve(path.join(root, relPath));
    if (!resolved.startsWith(path.resolve(root) + path.sep)) return null; // traversal guard
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function usePet(petId) {
  const { pets } = listPets();
  if (!pets.some((p) => p.id === petId)) throw new Error(`pet not installed: ${petId}`);
  writeConfig({ activePet: petId });
  return petId;
}

export function importPet(source) {
  if (!source) throw new Error("source path required");
  let src = path.resolve(source.replace(/^~(?=$|[\\/])/, os.homedir()));

  // convenience: `import brawl-worker` resolves a Codex pet by id
  if (!fs.existsSync(src)) {
    const codex = path.join(os.homedir(), ".codex", "pets", source);
    if (fs.existsSync(codex)) src = codex;
    else throw new Error(`path not found: ${source}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cute-pets-"));
  let root;
  try {
    if (fs.statSync(src).isDirectory()) {
      root = locatePetRoot(src);
      if (!root) throw new Error("pet.json not found in that folder");
    } else {
      const unpack = path.join(tmp, "unpack");
      extractZip(src, unpack);
      root = locatePetRoot(unpack);
      if (!root) throw new Error("pet.json not found in the zip");
    }

    const meta = readPetJson(root);
    const sheet = path.join(root, meta.spritesheetPath);
    if (!fs.existsSync(sheet)) throw new Error(`spritesheet missing: ${meta.spritesheetPath}`);

    const id = String(meta.id || path.basename(root)).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!ID_RE.test(id)) throw new Error(`invalid pet id: ${id}`);

    const dest = path.join(petsDir(), id);
    fs.rmSync(dest, { recursive: true, force: true });
    ensureDir(petsDir());
    fs.cpSync(root, dest, { recursive: true });

    const cfg = readConfig();
    if (!cfg.activePet) writeConfig({ activePet: id });
    return { id, name: meta.displayName || id, active: (cfg.activePet ?? id) === id };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
