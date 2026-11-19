import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startPlugin, startupProblems } from '../test-support/plugin-host.mjs';

// The bundle that ships, with the WASM embedded; `npm test` builds it first.
const mainJs = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

function refuse(name) {
  return class {
    constructor() {
      throw new Error(`synchronous WebAssembly.${name} on the main thread`);
    }
  };
}

// Obsidian runs plugins on the renderer's main thread, where Chromium refuses
// to compile or instantiate a large module synchronously. The plugin must
// therefore never use the synchronous constructors at startup, whatever the
// size of the WASM: this host refuses them outright.
const mainThreadWebAssembly = Object.create(WebAssembly, {
  Module: { value: refuse('Module') },
  Instance: { value: refuse('Instance') },
});

test('the shipped bundle starts without synchronous WebAssembly compilation', async () => {
  const report = await startPlugin(mainJs, { WebAssembly: mainThreadWebAssembly });
  assert.deepEqual(startupProblems(report), []);
});

test('a loaded plugin formats on save and stops when it is unloaded', async () => {
  const report = await startPlugin(mainJs);
  assert.equal(report.saveHookedAfterLoad, true);
  assert.equal(report.saveHookedAfterUnload, false);
  assert.equal(report.holdsLinterAfterUnload, false);
});

// Obsidian releases what a plugin registered when it unloads the plugin, and
// it does not wait for a pending onload(). Whatever the rest of onload() sets
// up after that point is never released: a save hook that keeps formatting for
// a plugin that is off, an editor extension, commands, and the linter's memory.
for (const moment of ['loading settings', 'compiling WASM', 'reading configuration']) {
  test(`a plugin unloaded while ${moment} leaves nothing behind`, async () => {
    const report = await startPlugin(mainJs, { unloadWhileStarting: moment });
    assert.deepEqual(report.errors, []);
    assert.equal(report.saveHookedAfterUnload, false);
    assert.deepEqual(report.registeredAfterUnload, []);
    assert.equal(report.holdsLinterAfterUnload, false);
    assert.equal(report.wasmReady, false);
  });
}

// Reading the configuration can put notices on screen, so it must not begin
// for a plugin that is already off.
test('a plugin unloaded while compiling WASM does not go on to read its configuration', async () => {
  const report = await startPlugin(mainJs, { unloadWhileStarting: 'compiling WASM' });
  assert.equal(report.vaultReadsAfterUnload, 0);
});
