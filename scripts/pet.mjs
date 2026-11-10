// Pet store CLI: import, list, switch the active pet.
//   node scripts/pet.mjs list
//   node scripts/pet.mjs import <path-or-codex-pet-id>
//   node scripts/pet.mjs use <id>
import { listPets, importPet, usePet } from "../src/pets.mjs";

const [cmd, arg] = process.argv.slice(2);

try {
  if (cmd === "list" || !cmd) {
    const { active, pets } = listPets();
    if (!pets.length) console.log("no pets installed — import one with: node scripts/pet.mjs import <path|id>");
    for (const p of pets) console.log(`${p.id === active ? "*" : " "} ${p.id.padEnd(20)} ${p.name}`);
    process.exit(0);
  }
  if (cmd === "import") {
    if (!arg) throw new Error("usage: node scripts/pet.mjs import <path-or-codex-pet-id>");
    const pet = importPet(arg);
    console.log(`imported ${pet.id} (${pet.name})${pet.active ? " — active" : ""}`);
    process.exit(0);
  }
  if (cmd === "use") {
    if (!arg) throw new Error("usage: node scripts/pet.mjs use <id>");
    console.log(`active pet: ${usePet(arg)}`);
    process.exit(0);
  }
  throw new Error(`unknown command: ${cmd}`);
} catch (err) {
  console.error("error:", err.message);
  process.exit(1);
}
