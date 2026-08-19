import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// Two-space indentation with a trailing newline is what the auto-update
// workflow's jq writes, so a manual bump and a bot bump do not reformat
// each other's files.
// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
