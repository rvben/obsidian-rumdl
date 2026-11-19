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
