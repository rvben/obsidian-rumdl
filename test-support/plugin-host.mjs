// A minimal Obsidian host that starts the built plugin the way Obsidian does:
// it evaluates main.js as a CommonJS script and awaits onload(). Only the host
// is stubbed; the bundle, its embedded WASM and the WASM loader are the ones
// that ship. It runs unchanged in Node and in a browser page, so the same
// startup check covers both.

/** A value that absorbs any property access, call or construction. */
function inert() {
  return new Proxy(function () {}, {
    // Not thenable, so that awaiting one yields the value itself.
    get: (_, key) => (key === 'then' ? undefined : inert()),
    apply: () => inert(),
    construct: () => inert(),
  });
}

const DOCUMENT_WITHOUT_FINAL_NEWLINE = '# Title\n\nText';

/**
 * Start the plugin from the source text of main.js and report what happened.
 *
 * `WebAssembly` replaces the global the bundle sees, which lets a caller
 * impose a host's compilation rules.
 *
 * `unloadWhileStarting` unloads the plugin while onload() is still pending,
 * as Obsidian does when the plugin is disabled or reloaded during startup:
 * `'loading settings'` lands the unload in the first wait of onload(),
 * `'compiling WASM'` right after the settings tab is added, before the WASM
 * is compiled, and `'reading configuration'` while the plugin looks for its
 * configuration file.
 */
export async function startPlugin(code, { WebAssembly = globalThis.WebAssembly, unloadWhileStarting = null } = {}) {
  const report = {
    wasmReady: false,
    editorExtensions: 0,
    lintsWithOwnLinter: false,
    errors: [],
    // Whether the host's save command runs the plugin's wrapper.
    saveHookedAfterLoad: false,
    saveHookedAfterUnload: false,
    // What the plugin registered with the host once it had been unloaded.
    // Obsidian releases a plugin's registrations at unload, so these outlive it.
    registeredAfterUnload: [],
    holdsLinterAfterUnload: false,
    // Vault lookups the plugin started once it had been unloaded.
    vaultReadsAfterUnload: 0,
  };
  const hostSave = () => true;
  const saveCommand = { checkCallback: hostSave };
  let unloaded = false;
  const registers = name => {
    if (unloaded) report.registeredAfterUnload.push(name);
  };
  const describe = value => (value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value));
  const capturedConsole = {
    ...console,
    debug() {},
    error: (...args) => report.errors.push(args.map(describe).join(' ')),
  };

  class Plugin {
    constructor() {
      this.app = {
        vault: {
          adapter: {
            exists: async () => {
              if (unloaded) report.vaultReadsAfterUnload += 1;
              // Unloads in the middle of the search for a configuration file.
              if (unloadWhileStarting === 'reading configuration') unload(this);
              return false;
            },
          },
        },
        workspace: inert(),
        commands: { commands: { 'editor:save-file': saveCommand } },
      };
      this.manifest = { dir: '' };
    }
    async loadData() {
      if (unloadWhileStarting === 'loading settings') unload(this);
      return null;
    }
    async saveData() {}
    addSettingTab() {
      registers('setting tab');
      if (unloadWhileStarting === 'compiling WASM') unload(this);
    }
    addStatusBarItem() { registers('status bar item'); return inert(); }
    addCommand() { registers('command'); }
    registerEvent() { registers('event'); }
    registerEditorExtension() { registers('editor extension'); report.editorExtensions += 1; }
  }
  const unload = plugin => {
    if (unloaded) return;
    unloaded = true;
    plugin.onunload();
  };
  const obsidian = {
    Plugin,
    PluginSettingTab: class { update() {} },
    Notice: class {},
    Modal: class {},
    Menu: class {},
    MarkdownView: class {},
    TFile: class {},
    FileSystemAdapter: class {},
    Platform: { isDesktop: false },
    normalizePath: path => path,
    setIcon() {},
  };

  const module = { exports: {} };
  // Only what every Obsidian host provides, mobile included. Anything else,
  // such as a Node builtin reached during startup, fails as it would there.
  const hostModules = { obsidian, '@codemirror/lint': inert() };
  const require = id => {
    if (!(id in hostModules)) throw new Error(`Cannot find module '${id}'`);
    return hostModules[id];
  };
  new Function('module', 'exports', 'require', 'WebAssembly', 'console', code)(
    module, module.exports, require, WebAssembly, capturedConsole,
  );

  const plugin = new module.exports.default();
  try {
    await plugin.onload();
    report.wasmReady = plugin.wasmReady === true;
    report.saveHookedAfterLoad = saveCommand.checkCallback !== hostSave;
    if (plugin.linter && !unloaded) {
      const warnings = JSON.parse(plugin.linter.check(DOCUMENT_WITHOUT_FINAL_NEWLINE));
      report.lintsWithOwnLinter = warnings.some(warning => (warning.rule_name ?? warning.rule) === 'MD047');
    }
  } catch (error) {
    report.errors.push(`onload threw: ${describe(error)}`);
  } finally {
    try { unload(plugin); } catch { /* nothing to release when startup failed */ }
    report.saveHookedAfterUnload = saveCommand.checkCallback !== hostSave;
    report.holdsLinterAfterUnload = plugin.linter != null;
  }
  return report;
}

/**
 * Why a report does not describe a working plugin; empty when it does.
 *
 * onload() catches a failed WASM load and returns normally, so a resolved
 * onload() proves nothing. A working start is one where the linter is up,
 * the editor integration was registered and the plugin's own linter finds a
 * known problem.
 */
export function startupProblems(report) {
  const problems = report.errors.map(error => `logged an error: ${error}`);
  if (!report.wasmReady) problems.push('the WASM did not become ready');
  if (report.editorExtensions !== 1) problems.push(`registered ${report.editorExtensions} editor extensions instead of 1`);
  if (!report.lintsWithOwnLinter) problems.push('the plugin linter did not report MD047 for a document without a final newline');
  return problems;
}
