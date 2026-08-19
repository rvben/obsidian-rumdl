// Copy a built plugin into a local Obsidian vault for testing.
//
// Usage: OBSIDIAN_VAULT=~/path/to/vault npm run deploy
//
// The files land in <vault>/.obsidian/plugins/<id>/, the folder Obsidian and
// BRAT use for this plugin id, so a dev build and a BRAT-installed release
// share one install. Reload Obsidian (Cmd+R) afterwards to pick it up.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const vault = process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error("Set OBSIDIAN_VAULT to the vault directory, e.g. OBSIDIAN_VAULT=~/Notes npm run deploy");
  process.exit(1);
}
const vaultDir = resolve(vault.replace(/^~(?=$|\/)/, homedir()));
if (!existsSync(join(vaultDir, ".obsidian"))) {
  console.error(`${vaultDir} has no .obsidian directory; is it a vault?`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = join(vaultDir, ".obsidian", "plugins", manifest.id);
mkdirSync(target, { recursive: true });

const files = ["main.js", "manifest.json", "styles.css"];
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`${file} is missing; run npm run build first`);
    process.exit(1);
  }
}
for (const file of files) {
  copyFileSync(file, join(target, file));
}
console.log(`Deployed ${manifest.id} ${manifest.version} to ${target}`);
