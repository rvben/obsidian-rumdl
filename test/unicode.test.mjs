import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';
import { EditorState } from '@codemirror/state';
import { setDiagnostics } from '@codemirror/lint';
import * as wasm from 'rumdl-wasm';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
wasm.initSync({ module: readFileSync(require.resolve('rumdl-wasm/rumdl_lib_bg.wasm')) });

// @codemirror/state is pinned to Obsidian's exact peer version so all
// CodeMirror packages use the same state instance.
// Exercise the plugin's actual diagnostic source and save handler. Only the
// Obsidian host and linter registration are stubbed; WASM and CodeMirror's
// document, diagnostic validation and edit application are real.
const built = await build({
  stdin: {
    contents: readFileSync(new URL('../main.ts', import.meta.url), 'utf8') + '\nexport { createRumdlLinter };',
    loader: 'ts', resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['obsidian', '@codemirror/view', '@codemirror/lint', 'rumdl-wasm'],
});
const module = { exports: {} };
const obsidian = new Proxy({}, { get: () => class {} });
runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, console,
  require(id) {
    if (id === 'obsidian') return obsidian;
    if (id === 'rumdl-wasm') return wasm;
    if (id === '@codemirror/lint') return { linter: source => source };
    return require(id);
  },
});

async function fixture(input) {
  const plugin = new module.exports.default();
  plugin.settings = {
    formatOnSave: true, showStatusBar: true, disabledRules: ['MD041', 'MD013', 'MD025'],
    lineLength: 0, useConfigFile: false, headingStyle: 'atx', emphasisStyle: 'consistent',
    strongStyle: 'consistent', ulStyle: 'asterisk',
  };
  plugin.wasmReady = true;
  plugin.filePathForEditorView = () => 'unicode.md';
  plugin.updateStatusBar = () => {};
  await plugin.createLinter();
  let state = EditorState.create({ doc: input });
  const view = {
    get state() { return state; },
    dom: { closest: selector => selector === '.workspace-leaf' ? {} : null },
    dispatch(spec) { state = state.update(spec).state; },
  };
  return { plugin, view, source: module.exports.createRumdlLinter(plugin) };
}

for (const symbol of ['æ', 'æøå', '😀', 'æ😀𝄞']) {
  for (const ending of ['', '\n', '\n\n']) {
    test(`Unicode diagnostics and quick fixes: ${JSON.stringify(symbol + ending)}`, async () => {
      const input = `# Heading\n\nContent with Unicode "${symbol}".${ending}`;
      const expected = input.trimEnd() + '\n';
      const { plugin, view, source } = await fixture(input);
      try {
        const diagnostics = source(view);
        view.dispatch(setDiagnostics(view.state, diagnostics));
        assert.equal(plugin.linter.fix(input, 'unicode.md'), expected);
        const fixable = diagnostics.filter(d => d.actions?.some(a => a.name === 'Fix'));
        assert.equal(fixable.length, ending === '\n' ? 0 : 1);
        fixable[0]?.actions.find(a => a.name === 'Fix').apply(view);
        assert.equal(view.state.doc.toString(), expected);
        if (!ending) {
          const diagnostic = diagnostics.find(d => d.source === 'MD047');
          assert.equal(diagnostic.from, input.length);
          assert.equal(diagnostic.to, input.length);
        }
        assert.equal(source(view).length, 0);
      } finally {
        plugin.linter.free();
      }
    });
  }
}

test('format on save preserves the Unicode text and calls the original save handler', async () => {
  const input = '# Heading\n\nContent with Norwegian letter "æ" and emoji 😀.';
  const { plugin, view } = await fixture(input);
  let saved;
  const editor = {
    getValue: () => view.state.doc.toString(),
    setValue: value => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }),
    getCursor: () => ({ line: 2, ch: 0 }),
    setCursor: () => {},
  };
  const command = { checkCallback: checking => {
    if (!checking) saved = editor.getValue();
    return true;
  } };
  const original = command.checkCallback;
  plugin.app = {
    commands: { commands: { 'editor:save-file': command } },
    workspace: { getActiveViewOfType: () => ({ editor, file: { extension: 'md', path: 'unicode.md' } }) },
  };
  try {
    plugin.setupFormatOnSave();
    assert.equal(command.checkCallback(true), true);
    assert.equal(editor.getValue(), input);
    assert.equal(saved, undefined);
    assert.equal(command.checkCallback(false), true);
    assert.equal(saved, input + '\n');
    command.checkCallback(false);
    assert.equal(saved, input + '\n');
    plugin.restoreOriginalSave();
    assert.equal(command.checkCallback, original);
  } finally {
    plugin.linter.free();
  }
});
