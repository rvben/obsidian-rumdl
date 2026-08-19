import { App, Editor, FileSystemAdapter, MarkdownFileInfo, MarkdownView, Menu, Modal, Notice, Platform, Plugin, PluginSettingTab, SettingDefinition, SettingDefinitionItem, TFile, normalizePath, setIcon } from 'obsidian';
import { initSync, Linter, get_version, get_available_rules, resolve_config_chain } from 'rumdl-wasm';
import { EditorView } from '@codemirror/view';
import { linter, Diagnostic } from '@codemirror/lint';
import { inflateSync } from 'fflate';

// Internal Obsidian API type for command manipulation
interface InternalAppCommands {
  commands?: {
    commands?: Record<string, {
      checkCallback?: (checking: boolean) => boolean;
    }>;
  };
}

interface RumdlWarning {
  line: number;
  column: number;
  message: string;
  rule_name?: string;
  rule?: string;
  fix?: {
    range: {
      start: number;
      end: number;
    };
    replacement: string;
  };
}

/** A rule as listed by rumdl's `get_available_rules`. */
interface RuleInfo {
  name: string;
  description: string;
}

type HeadingStyle = 'atx' | 'setext' | 'consistent';
type EmphasisStyle = 'asterisk' | 'underscore' | 'consistent';
type StrongStyle = 'asterisk' | 'underscore' | 'consistent';
type UlStyle = 'dash' | 'asterisk' | 'plus' | 'consistent';

interface RumdlPluginSettings {
  formatOnSave: boolean;
  showStatusBar: boolean;
  disabledRules: string[];
  lineLength: number;
  useConfigFile: boolean;
  // Style options
  headingStyle: HeadingStyle;
  emphasisStyle: EmphasisStyle;
  strongStyle: StrongStyle;
  ulStyle: UlStyle;
}

const DEFAULT_SETTINGS: RumdlPluginSettings = {
  formatOnSave: false,
  showStatusBar: true,
  disabledRules: ['MD041'], // Disable first-line-heading by default for Obsidian
  lineLength: 0, // 0 = unlimited
  useConfigFile: true, // Auto-detect .rumdl.toml by default
  // Style defaults
  headingStyle: 'consistent',
  emphasisStyle: 'consistent',
  strongStyle: 'consistent',
  ulStyle: 'consistent',
};

const CONFIG_FILE_NAMES = ['.rumdl.toml', 'rumdl.toml'];

/** Status returned by rumdl's `resolve_config_chain` while walking an `extends` chain. */
type ConfigChainStatus =
  | { status: 'need-file'; path: string }
  | { status: 'complete'; files: string[] }
  | { status: 'error'; message: string };

/**
 * Node builtins for reading `extends` targets outside the vault. They are
 * loaded on first use rather than imported statically because the plugin also
 * runs on mobile, where there is no Node runtime and a static import would
 * fail when the plugin loads.
 */
async function loadDesktopNode() {
  if (!Platform.isDesktop) {
    throw new Error('Node builtins are only available in the desktop app');
  }
  const [fs, path, os, process] = await Promise.all([import('fs'), import('path'), import('os'), import('process')]);
  return { fs, path, os, process: process.default };
}

/** Whether a caught value is a Node filesystem error carrying the given code. */
function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Parse JSON produced by rumdl. Every WASM call returns its result as a JSON
 * string whose shape is fixed by the rumdl version the plugin bundles, so the
 * caller names the type it expects.
 */
function parseJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

/** Decode the WASM binary that esbuild deflated and inlined into main.js. */
function embeddedWasm(): Uint8Array {
  const deflated = atob(RUMDL_WASM_DEFLATED_BASE64);
  const bytes = new Uint8Array(deflated.length);
  for (let i = 0; i < deflated.length; i++) {
    bytes[i] = deflated.charCodeAt(i);
  }
  return inflateSync(bytes);
}

/**
 * Whether a path rumdl asks for while following `extends` lies outside the
 * vault. Paths are as rumdl resolved them: vault-relative for targets under the
 * vault root, and absolute, `../`-prefixed or still `~/`-prefixed (no home was
 * available to expand it) for everything else.
 */
function isOutsideVault(path: string): boolean {
  return (
    path.startsWith('/') ||
    path.startsWith('../') ||
    path === '..' ||
    path.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

// Generate URL for rule documentation
function getRuleDocsUrl(ruleName: string): string {
  return `https://github.com/rvben/rumdl/blob/main/docs/${ruleName.toLowerCase()}.md`;
}

/**
 * Detect if an EditorView is in an isolated/embedded context (like a table cell).
 *
 * In Obsidian's live preview mode, table cells get their own CodeMirror EditorView
 * instances. Linting these isolated cells causes false positives for document-level
 * rules like MD041 (first line heading) since the linter sees just the cell content.
 *
 * This function uses multiple detection strategies:
 * 1. DOM hierarchy analysis - check if editor is inside embed/table containers
 * 2. Content heuristics - detect table-cell-like content patterns
 * 3. View root analysis - check if this is a nested/embedded view
 */
function isIsolatedEditorContext(view: EditorView): boolean {
  // Strategy 1: DOM hierarchy analysis
  // Check if the editor's DOM is inside an embedded context
  const editorDom = view.dom;

  // Table cell detection - check for table-related parent elements
  const tableParent = editorDom.closest('table, td, th, .cm-table-cell, .table-cell-wrapper');
  if (tableParent) {
    return true;
  }

  // Embed block detection - Obsidian uses these for various embedded editors
  const embedParent = editorDom.closest('.cm-embed-block, .markdown-embed, .internal-embed');
  if (embedParent) {
    return true;
  }

  // Strategy 2: Check if we're NOT in a main editor context
  // Main document editors are inside workspace-leaf containers
  const workspaceLeaf = editorDom.closest('.workspace-leaf');
  const markdownView = editorDom.closest('.markdown-source-view, .markdown-reading-view');

  // If we're not in a workspace leaf but the editor exists, it's likely embedded
  // However, we need to be careful not to flag the main editor
  if (!workspaceLeaf && !markdownView) {
    // Additional check: main editors have .cm-editor as a direct structure
    // Embedded editors often have wrapper classes
    const cmEditor = editorDom.closest('.cm-editor');
    if (cmEditor) {
      // Check if this cm-editor is inside a known embed wrapper
      const parent = cmEditor.parentElement;
      if (parent && (
        parent.classList.contains('cm-embed-block') ||
        parent.classList.contains('table-cell-wrapper') ||
        parent.closest('.cm-line')  // Editor nested inside a line = embedded
      )) {
        return true;
      }
    }
  }

  // Strategy 3: Content heuristics for edge cases
  // Table cells typically have specific patterns
  const content = view.state.doc.toString();

  // Single-line content that looks like a table cell
  // (very short, no document structure, possibly has pipe boundaries)
  if (!content.includes('\n') && content.length < 200) {
    // Check if it looks like table cell content
    // - No markdown headings
    // - No frontmatter
    // - No list markers at start
    const trimmed = content.trim();
    const hasDocStructure =
      trimmed.startsWith('#') ||           // Heading
      trimmed.startsWith('---') ||         // Frontmatter/HR
      trimmed.startsWith('- ') ||          // List
      trimmed.startsWith('* ') ||          // List
      trimmed.startsWith('> ') ||          // Blockquote
      trimmed.startsWith('```');           // Code fence

    // If no document structure and very short, likely a table cell
    // But only flag if we also have some DOM uncertainty
    if (!hasDocStructure && !workspaceLeaf) {
      return true;
    }
  }

  return false;
}

// Create a linter extension factory - returns a linter bound to the plugin instance
function createRumdlLinter(plugin: RumdlPlugin) {
  return linter((view: EditorView) => {
    if (!plugin.wasmReady || !plugin.linter) {
      return [];
    }

    // Skip linting for isolated editor contexts (table cells, embeds)
    // These are transient editing contexts where document-level rules
    // produce false positives. The full document is linted separately.
    if (isIsolatedEditorContext(view)) {
      return [];
    }

    const content = view.state.doc.toString();
    const filePath = plugin.filePathForEditorView(view);
    const warnings = parseJson<RumdlWarning[]>(plugin.linter.check(content, filePath));

    // Update status bar
    plugin.updateStatusBar(warnings.length);

    // Convert rumdl warnings to CodeMirror diagnostics
    const diagnostics: Diagnostic[] = [];

    for (const warning of warnings) {
      // Convert line/column to document position
      if (warning.line >= 1 && warning.line <= view.state.doc.lines) {
        const line = view.state.doc.line(warning.line);
        const from = line.from + Math.max(0, (warning.column || 1) - 1);
        const to = line.to;

        const ruleName = warning.rule_name || warning.rule || 'rumdl';
        const diagnostic: Diagnostic = {
          from,
          to,
          severity: 'warning',
          message: warning.message,
          source: ruleName,
        };

        // Build actions array
        const actions: Array<{ name: string; apply: (view: EditorView) => void }> = [];

        // Add fix action if available
        if (warning.fix) {
          const fixStart = warning.fix.range.start;
          const fixEnd = warning.fix.range.end;
          const fixReplacement = warning.fix.replacement;

          actions.push({
            name: 'Fix',
            apply: (view: EditorView) => {
              view.dispatch({
                changes: { from: fixStart, to: fixEnd, insert: fixReplacement }
              });
            }
          });
        }

        // Add docs action if we have a valid rule name (MD###)
        if (ruleName.match(/^MD\d{3}$/i)) {
          actions.push({
            name: 'Docs',
            apply: () => {
              window.open(getRuleDocsUrl(ruleName), '_blank');
            }
          });
        }

        if (actions.length > 0) {
          diagnostic.actions = actions;
        }

        diagnostics.push(diagnostic);
      }
    }

    // Add a "Fix All" footer diagnostic if there are multiple fixable issues
    const fixableCount = warnings.filter(w => w.fix).length;
    if (fixableCount > 1 && diagnostics.length > 0) {
      // Use the same position as the first diagnostic for the "Fix All" footer
      const firstDiag = diagnostics[0];
      diagnostics.push({
        from: firstDiag.from,
        to: firstDiag.to,
        severity: 'hint' as const,
        message: '',
        source: `${fixableCount} fixable issues`,
        actions: [{
          name: 'Fix All',
          apply: (view: EditorView) => {
            if (!plugin.linter) return;
            const currentContent = view.state.doc.toString();
            const fixedFilePath = plugin.filePathForEditorView(view);
            const fixed = plugin.linter.fix(currentContent, fixedFilePath);
            if (fixed !== currentContent) {
              view.dispatch({
                changes: { from: 0, to: currentContent.length, insert: fixed }
              });
            }
          }
        }]
      });
    }

    return diagnostics;
  }, {
    delay: 500,
  });
}

export default class RumdlPlugin extends Plugin {
  settings!: RumdlPluginSettings;
  settingTab!: RumdlSettingTab;
  statusBarItem: HTMLElement | null = null;
  wasmReady = false;
  linter: Linter | null = null;
  private rules: RuleInfo[] | null = null;
  originalSaveCallback: ((checking: boolean) => boolean) | undefined;
  configFilePath: string | null = null;
  /** Every config file the active linter was built from, root first; empty without a config file. */
  configChain: string[] = [];
  // Caches the TFile backing each CodeMirror EditorView so the linter can
  // pass the vault-relative path to WASM for exclude-pattern matching.
  // Populated lazily on lookup + eagerly on `file-open` / `active-leaf-change`.
  private editorViewFiles: WeakMap<EditorView, TFile> = new WeakMap();

  /** Resolve the vault-relative path for a CM6 EditorView, or null if unknown. */
  filePathForEditorView(view: EditorView): string | null {
    const cached = this.editorViewFiles.get(view);
    if (cached) return cached.path;
    // Fallback: background leaves (not yet seen via events) or newly-opened views.
    // A deferred leaf's view has no editor yet, hence the optional chaining.
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const mdView = leaf.view as MarkdownView;
      const cm = (mdView.editor as unknown as { cm?: EditorView } | undefined)?.cm;
      if (cm === view && mdView.file) {
        this.editorViewFiles.set(view, mdView.file);
        return mdView.file.path;
      }
    }
    return null;
  }

  /** Refresh the EditorView→TFile map from all open markdown leaves. */
  private refreshEditorViewFiles() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const mdView = leaf.view as MarkdownView;
      const cm = (mdView.editor as unknown as { cm?: EditorView } | undefined)?.cm;
      if (cm && mdView.file) {
        this.editorViewFiles.set(cm, mdView.file);
      }
    }
  }

  updateStatusBar(issueCount: number | null) {
    if (!this.statusBarItem) return;

    this.statusBarItem.empty();
    const iconEl = this.statusBarItem.createSpan({ cls: 'rumdl-status-icon' });
    const textEl = this.statusBarItem.createSpan({ cls: 'rumdl-status-text' });

    if (issueCount === null) {
      setIcon(iconEl, 'file-check');
    } else if (issueCount === 0) {
      setIcon(iconEl, 'check-circle');
      this.statusBarItem.addClass('rumdl-clean');
      this.statusBarItem.removeClass('rumdl-issues');
    } else {
      setIcon(iconEl, 'alert-circle');
      textEl.setText(String(issueCount));
      this.statusBarItem.addClass('rumdl-issues');
      this.statusBarItem.removeClass('rumdl-clean');
    }
  }

  showStatusMenu(e: MouseEvent) {
    const menu = new Menu();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    menu.addItem((item) =>
      item
        .setTitle('View issues')
        .setDisabled(!view)
        .onClick(() => {
          if (view) this.lintEditor(view.editor, view.file?.path ?? null);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Fix all issues')
        .setDisabled(!view)
        .onClick(() => {
          if (view) this.fixAll(view.editor, view.file?.path ?? null);
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('Available rules')
        .onClick(() => this.showRules())
    );

    menu.showAtMouseEvent(e);
  }

  async createLinter() {
    // Try to load from config file first if enabled
    if (this.settings.useConfigFile) {
      for (const configName of CONFIG_FILE_NAMES) {
        if (await this.app.vault.adapter.exists(configName)) {
          try {
            const { linter, chain } = await this.linterFromConfigFile(configName);
            this.linter = linter;
            this.configFilePath = configName;
            this.configChain = chain;
            console.debug('rumdl: loaded config from', chain.join(' -> '), parseJson<unknown>(linter.get_config()));
            const warnings = parseJson<string[]>(linter.get_config_warnings());
            if (warnings.length > 0) {
              console.warn('rumdl: config warnings:', warnings);
              new Notice(`rumdl: ${configName} has ${warnings.length} config warning(s)\n${warnings.join('\n')}`, 10000);
            }
            return;
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            console.error(`rumdl: failed to load ${configName}:`, e);
            new Notice(`rumdl: config error in ${configName}\n${errorMsg}`, 10000);
            // Continue to try next config file or fall back to settings
          }
        }
      }
    }

    // Fall back to plugin settings
    this.configFilePath = null;
    this.configChain = [];
    const config: Record<string, unknown> = {
      // Always use obsidian flavor for Obsidian-specific syntax support
      // (tags, callouts, highlights, comments, Dataview, Templater, etc.)
      flavor: 'obsidian',
    };

    if (this.settings.disabledRules.length > 0) {
      config.disable = this.settings.disabledRules;
    }

    if (this.settings.lineLength > 0) {
      config['line-length'] = this.settings.lineLength;
    }

    // Style options (only add if not 'consistent' - let rumdl detect)
    if (this.settings.headingStyle !== 'consistent') {
      config.MD003 = { style: this.settings.headingStyle };
    }
    if (this.settings.emphasisStyle !== 'consistent') {
      config.MD049 = { style: this.settings.emphasisStyle };
    }
    if (this.settings.strongStyle !== 'consistent') {
      config.MD050 = { style: this.settings.strongStyle };
    }
    if (this.settings.ulStyle !== 'consistent') {
      config.MD004 = { style: this.settings.ulStyle };
    }

    this.linter = new Linter(config);
  }

  /**
   * Build a linter from a vault-root config file and the `extends` chain it
   * declares. rumdl resolves each `extends` value and merges the chain exactly
   * as the CLI does; this method only reads the files it asks for, one round
   * trip per link, since the vault adapter is async.
   */
  async linterFromConfigFile(root: string): Promise<{ linter: Linter; chain: string[] }> {
    const files: Record<string, string | null> = { [root]: await this.app.vault.adapter.read(root) };
    const env = await this.configEnvironment();
    const home = await this.homeDirectory();
    const request = () => ({ root, files, env, home, 'default-flavor': 'obsidian' });
    let chain: string[];
    for (;;) {
      const status = parseJson<ConfigChainStatus>(resolve_config_chain(request()));
      if (status.status === 'need-file') {
        files[status.path] = await this.readConfigFile(status.path);
      } else if (status.status === 'error') {
        throw new Error(status.message);
      } else {
        chain = status.files;
        break;
      }
    }
    return { linter: Linter.from_config_files(request()), chain };
  }

  /**
   * Read a file rumdl asks for while following `extends`: through the vault
   * adapter when it is inside the vault, through Node's fs on desktop when it
   * is not. Returns null for a file that does not exist, which rumdl reports
   * as a missing `extends` target.
   */
  async readConfigFile(path: string): Promise<string | null> {
    if (!isOutsideVault(path)) {
      const vaultPath = normalizePath(path);
      if (!(await this.app.vault.adapter.exists(vaultPath))) return null;
      return this.app.vault.adapter.read(vaultPath);
    }
    const adapter = this.app.vault.adapter;
    if (!Platform.isDesktop || !(adapter instanceof FileSystemAdapter)) {
      throw new Error(`extends target '${path}' is outside the vault, which only the desktop app can read`);
    }
    const node = await loadDesktopNode();
    const absolute = node.path.resolve(adapter.getBasePath(), path);
    try {
      return await node.fs.promises.readFile(absolute, 'utf8');
    } catch (e) {
      if (hasErrnoCode(e, 'ENOENT')) return null;
      throw e;
    }
  }

  /** Environment variables for `$VAR` in `extends`; the desktop app has the process's, mobile has none. */
  async configEnvironment(): Promise<Record<string, string>> {
    if (!Platform.isDesktop) return {};
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries((await loadDesktopNode()).process.env)) {
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  /** The home directory for `~/` in `extends`; undefined on mobile, where `~/` is left as written. */
  async homeDirectory(): Promise<string | undefined> {
    if (!Platform.isDesktop) return undefined;
    return (await loadDesktopNode()).os.homedir();
  }

  async onload() {
    await this.loadSettings();

    // Settings tab - register early so it's always available
    this.settingTab = new RumdlSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    try {
      initSync({ module: embeddedWasm() });

      // Create the linter instance with configuration
      await this.createLinter();
      this.wasmReady = true;

      const version = get_version();
      console.debug(`rumdl v${version} loaded`);

      // Setup format on save hook
      this.setupFormatOnSave();
    } catch (error) {
      console.error('Failed to load rumdl-wasm:', error);
      new Notice('Failed to load rumdl linter');
      return;
    }

    // The settings tab lists the rules, which only exist once the WASM is up.
    this.settingTab.update();

    this.applyStatusBarSetting();

    // Register CodeMirror linter extension (provides underlines + hover tooltips)
    this.registerEditorExtension([createRumdlLinter(this)]);

    // Update status bar + refresh EditorView→TFile map when switching files.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.refreshEditorViewFiles();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          this.updateStatusBar(null);
        }
      })
    );

    // Refresh the EditorView→TFile map whenever a file is opened so
    // subsequent lint calls resolve paths via WeakMap (O(1)) instead of
    // iterating open leaves.
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        this.refreshEditorViewFiles();
      })
    );

    // Command: Lint current file (shows modal with results)
    this.addCommand({
      id: 'lint-current-file',
      name: 'Check file',
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        this.lintEditor(editor, ctx.file?.path ?? null);
      },
    });

    // Command: Fix all issues
    this.addCommand({
      id: 'fix-all-issues',
      name: 'Fix all',
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        this.fixAll(editor, ctx.file?.path ?? null);
      },
    });

    // Command: Show available rules
    this.addCommand({
      id: 'show-rules',
      name: 'Rules',
      callback: () => {
        this.showRules();
      },
    });
  }

  onunload() {
    this.restoreOriginalSave();
    if (this.linter) {
      this.linter.free();
      this.linter = null;
    }
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<RumdlPluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Copy the array so that edits never reach DEFAULT_SETTINGS.
      disabledRules: [...(stored?.disabledRules ?? DEFAULT_SETTINGS.disabledRules)],
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Recreate linter with new settings
    if (this.wasmReady) {
      await this.createLinter();
    }
  }

  /** Create or remove the status bar item so that it matches the setting. */
  applyStatusBarSetting() {
    if (this.settings.showStatusBar && !this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass('rumdl-status');
      this.statusBarItem.addEventListener('click', (e) => this.showStatusMenu(e));
      this.updateStatusBar(null);
    } else if (!this.settings.showStatusBar && this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
  }

  /** The rules rumdl knows, in rumdl's order; empty until the WASM is loaded. */
  availableRules(): RuleInfo[] {
    if (!this.wasmReady) return [];
    this.rules ??= parseJson<RuleInfo[]>(get_available_rules());
    return this.rules;
  }

  settingsToToml(): string {
    const lines: string[] = [
      '# rumdl configuration',
      '# Generated from Obsidian plugin settings',
      '# Schema: https://raw.githubusercontent.com/rvben/rumdl/main/rumdl.schema.json',
      '',
    ];
    lines.push('[global]');

    if (this.settings.lineLength > 0) {
      lines.push(`line-length = ${this.settings.lineLength}`);
    }

    if (this.settings.disabledRules.length > 0) {
      const rulesStr = this.settings.disabledRules.map(r => `"${r}"`).join(', ');
      lines.push(`disable = [${rulesStr}]`);
    }

    // Style options - only export if not 'consistent'
    if (this.settings.headingStyle !== 'consistent') {
      lines.push('', '[MD003]', `style = "${this.settings.headingStyle}"`);
    }
    if (this.settings.ulStyle !== 'consistent') {
      lines.push('', '[MD004]', `style = "${this.settings.ulStyle}"`);
    }
    if (this.settings.emphasisStyle !== 'consistent') {
      lines.push('', '[MD049]', `style = "${this.settings.emphasisStyle}"`);
    }
    if (this.settings.strongStyle !== 'consistent') {
      lines.push('', '[MD050]', `style = "${this.settings.strongStyle}"`);
    }

    return lines.join('\n') + '\n';
  }

  async exportToConfigFile(): Promise<boolean> {
    const configPath = '.rumdl.toml';

    // Check if file already exists
    if (await this.app.vault.adapter.exists(configPath)) {
      new Notice(`${configPath} already exists. Delete it first to export.`);
      return false;
    }

    try {
      const toml = this.settingsToToml();
      await this.app.vault.create(configPath, toml);

      // Enable config file mode and reload
      this.settings.useConfigFile = true;
      await this.saveSettings();

      new Notice(`Created ${configPath} - now using config file`);
      return true;
    } catch (e) {
      console.error('Failed to create config file:', e);
      new Notice(`Failed to create ${configPath}`);
      return false;
    }
  }

  lintEditor(editor: Editor, filePath: string | null, quiet = false) {
    if (!this.wasmReady || !this.linter) {
      new Notice('Linter is not ready yet');
      return;
    }

    const content = editor.getValue();
    const warnings = parseJson<RumdlWarning[]>(this.linter.check(content, filePath));

    this.updateStatusBar(warnings.length);

    if (warnings.length === 0) {
      if (!quiet) {
        new Notice('No issues found');
      }
    } else {
      if (!quiet) {
        new LintResultsModal(this.app, warnings, editor, this, filePath).open();
      }
    }
  }

  fixAll(editor: Editor, filePath: string | null) {
    if (!this.wasmReady || !this.linter) {
      new Notice('Linter is not ready yet');
      return;
    }

    const content = editor.getValue();
    const fixed = this.linter.fix(content, filePath);

    if (fixed !== content) {
      const cursor = editor.getCursor();
      editor.setValue(fixed);
      editor.setCursor(cursor);

      // Re-lint to show remaining issues
      const remaining = parseJson<RumdlWarning[]>(this.linter.check(fixed, filePath));

      this.updateStatusBar(remaining.length);

      if (remaining.length === 0) {
        new Notice('All issues fixed');
      } else {
        new Notice(`Fixed. ${remaining.length} remaining.`);
      }
    } else {
      new Notice('No auto-fixable issues found');
    }
  }

  showRules() {
    if (!this.wasmReady) {
      new Notice('Linter is not ready yet');
      return;
    }

    new RulesModal(this.app, this.availableRules()).open();
  }

  setupFormatOnSave() {
    const saveCommandDefinition = (this.app as unknown as InternalAppCommands).commands?.commands?.['editor:save-file'];
    this.originalSaveCallback = saveCommandDefinition?.checkCallback;

    if (saveCommandDefinition && typeof this.originalSaveCallback === 'function') {
      saveCommandDefinition.checkCallback = (checking: boolean) => {
        if (checking) {
          return this.originalSaveCallback!(checking);
        }

        // Apply fixes before the actual save
        if (this.settings.formatOnSave && this.wasmReady && this.linter) {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view?.file?.extension === 'md') {
            const editor = view.editor;
            const content = editor.getValue();
            const fixed = this.linter.fix(content, view.file.path);

            if (fixed !== content) {
              const cursor = editor.getCursor();
              editor.setValue(fixed);
              editor.setCursor(cursor);
            }
          }
        }

        return this.originalSaveCallback!(checking);
      };
    }
  }

  restoreOriginalSave() {
    if (this.originalSaveCallback) {
      const saveCommandDefinition = (this.app as unknown as InternalAppCommands).commands?.commands?.['editor:save-file'];
      if (saveCommandDefinition) {
        saveCommandDefinition.checkCallback = this.originalSaveCallback;
      }
    }
  }
}

class LintResultsModal extends Modal {
  warnings: RumdlWarning[];
  editor: Editor;
  plugin: RumdlPlugin;
  filePath: string | null;

  constructor(app: App, warnings: RumdlWarning[], editor: Editor, plugin: RumdlPlugin, filePath: string | null) {
    super(app);
    this.warnings = warnings;
    this.editor = editor;
    this.plugin = plugin;
    this.filePath = filePath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Lint results (${this.warnings.length} issues)` });

    const fixable = this.warnings.filter(w => w.fix).length;
    if (fixable > 0) {
      const fixAllBtn = contentEl.createEl('button', { text: `Fix all ${fixable} auto-fixable issues` });
      fixAllBtn.addEventListener('click', () => {
        this.plugin.fixAll(this.editor, this.filePath);
        this.close();
      });
    }

    const list = contentEl.createDiv({ cls: 'rumdl-results' });

    for (const warning of this.warnings) {
      const item = list.createDiv({ cls: 'rumdl-warning' });

      const header = item.createDiv({ cls: 'rumdl-warning-header' });
      header.createEl('strong', { text: warning.rule_name || warning.rule || 'Unknown' });
      header.createSpan({ text: ` Line ${warning.line}:${warning.column}` });

      if (warning.fix) {
        header.createSpan({ text: ' [fixable]', cls: 'rumdl-fixable' });
      }

      item.createDiv({ text: warning.message, cls: 'rumdl-message' });

      // Click to go to line
      item.addEventListener('click', () => {
        this.editor.setCursor({ line: warning.line - 1, ch: warning.column - 1 });
        this.editor.scrollIntoView({ from: { line: warning.line - 1, ch: 0 }, to: { line: warning.line - 1, ch: 0 } }, true);
        this.close();
      });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class RulesModal extends Modal {
  rules: RuleInfo[];

  constructor(app: App, rules: RuleInfo[]) {
    super(app);
    this.rules = rules;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Available rules (${this.rules.length})` });

    const list = contentEl.createDiv({ cls: 'rumdl-rules' });

    for (const rule of this.rules) {
      const item = list.createDiv({ cls: 'rumdl-rule' });
      item.createEl('strong', { text: rule.name });
      item.createSpan({ text: `: ${rule.description}` });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Control keys of the per-rule toggles. Rules are stored as the
 * `disabledRules` list, so each rule gets a pseudo-key that the tab maps to
 * membership of that list instead of to a settings property.
 */
const RULE_KEY_PREFIX = 'rule:';

function ruleKey(rule: RuleInfo): string {
  return `${RULE_KEY_PREFIX}${rule.name}`;
}

function isSettingKey(key: string): key is keyof RumdlPluginSettings {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
}

const CONSISTENT_STYLE = 'Consistent (detect from file)';

class RumdlSettingTab extends PluginSettingTab {
  plugin: RumdlPlugin;

  constructor(app: App, plugin: RumdlPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // The rule settings below only apply while no config file is in charge.
    const settingsActive = () => !this.plugin.settings.useConfigFile || this.plugin.configFilePath === null;

    return [
      {
        name: 'Format on save',
        desc: 'Fix issues automatically when a file is saved',
        control: { type: 'toggle', key: 'formatOnSave', defaultValue: DEFAULT_SETTINGS.formatOnSave },
      },
      {
        name: 'Show status bar',
        desc: 'Show the issue count of the active file in the status bar',
        control: { type: 'toggle', key: 'showStatusBar', defaultValue: DEFAULT_SETTINGS.showStatusBar },
      },
      {
        type: 'group',
        heading: 'Linting',
        items: [
          {
            name: 'Use config file',
            desc: this.configFileDesc(),
            control: { type: 'toggle', key: 'useConfigFile', defaultValue: DEFAULT_SETTINGS.useConfigFile },
          },
          {
            type: 'page',
            name: 'Rules',
            desc: 'Choose which rules are checked',
            displayValue: () => this.rulesSummary(),
            visible: settingsActive,
            items: [this.rulesGroup()],
          },
          {
            name: 'Line length',
            desc: 'Maximum line length, 0 for no limit',
            visible: settingsActive,
            control: {
              type: 'number',
              key: 'lineLength',
              min: 0,
              step: 1,
              placeholder: '80',
              defaultValue: DEFAULT_SETTINGS.lineLength,
              validate: (value) => (Number.isInteger(value) && value >= 0 ? undefined : 'Use a whole number, 0 for no limit'),
            },
          },
          {
            name: 'Heading style',
            desc: 'Preferred heading format',
            visible: settingsActive,
            control: {
              type: 'dropdown',
              key: 'headingStyle',
              defaultValue: DEFAULT_SETTINGS.headingStyle,
              options: { consistent: CONSISTENT_STYLE, atx: 'Hash style (# heading)', setext: 'Setext (underlined)' },
            },
          },
          {
            name: 'Unordered list style',
            desc: 'Preferred bullet character',
            visible: settingsActive,
            control: {
              type: 'dropdown',
              key: 'ulStyle',
              defaultValue: DEFAULT_SETTINGS.ulStyle,
              options: { consistent: CONSISTENT_STYLE, dash: 'Dash (-)', asterisk: 'Asterisk (*)', plus: 'Plus (+)' },
            },
          },
          {
            name: 'Emphasis style',
            desc: 'Preferred marker for *italic* text',
            visible: settingsActive,
            control: {
              type: 'dropdown',
              key: 'emphasisStyle',
              defaultValue: DEFAULT_SETTINGS.emphasisStyle,
              options: { consistent: CONSISTENT_STYLE, asterisk: 'Asterisk (*text*)', underscore: 'Underscore (_text_)' },
            },
          },
          {
            name: 'Strong style',
            desc: 'Preferred marker for **bold** text',
            visible: settingsActive,
            control: {
              type: 'dropdown',
              key: 'strongStyle',
              defaultValue: DEFAULT_SETTINGS.strongStyle,
              options: { consistent: CONSISTENT_STYLE, asterisk: 'Asterisk (**text**)', underscore: 'Underscore (__text__)' },
            },
          },
          {
            name: 'Export to config file',
            desc: 'Create .rumdl.toml in the vault root from the settings above and switch to it',
            visible: settingsActive,
            action: () => {
              void this.exportSettings();
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key.startsWith(RULE_KEY_PREFIX)) {
      return !this.plugin.settings.disabledRules.includes(key.slice(RULE_KEY_PREFIX.length));
    }
    return isSettingKey(key) ? this.plugin.settings[key] : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if (key.startsWith(RULE_KEY_PREFIX)) {
      const rule = key.slice(RULE_KEY_PREFIX.length);
      const others = settings.disabledRules.filter((r) => r !== rule);
      settings.disabledRules = value ? others : [...others, rule];
    } else if (isSettingKey(key)) {
      // Each key is bound to a control whose value type is the property's type.
      (settings as Record<keyof RumdlPluginSettings, unknown>)[key] = value;
    } else {
      return;
    }
    await this.plugin.saveSettings();
    if (key === 'showStatusBar') {
      this.plugin.applyStatusBarSetting();
    } else if (key === 'useConfigFile') {
      // The config file description and the visibility of the rule settings
      // depend on the linter that saveSettings just rebuilt.
      this.update();
    }
  }

  private async exportSettings(): Promise<void> {
    if (await this.plugin.exportToConfigFile()) {
      this.update();
    }
  }

  /** One row per rule, each with a toggle and a link to the rule's documentation. */
  private rulesGroup(): SettingDefinitionItem {
    const rules = this.plugin.availableRules();
    const descriptions = new Map(rules.map((rule) => [rule.name, rule.description.toLowerCase()]));
    return {
      type: 'group',
      search: {
        placeholder: 'Search rules',
        match: (def: SettingDefinition, query: string) => {
          const needle = query.toLowerCase();
          return def.name.toLowerCase().includes(needle) || (descriptions.get(def.name) ?? '').includes(needle);
        },
      },
      items: rules.map((rule) => ({
        name: rule.name,
        desc: createFragment((fragment) => {
          fragment.appendText(`${rule.description} `);
          fragment.createEl('a', { text: 'Docs', href: getRuleDocsUrl(rule.name) });
        }),
        control: { type: 'toggle', key: ruleKey(rule), defaultValue: true },
      })),
    };
  }

  private rulesSummary(): string {
    const disabled = this.plugin.settings.disabledRules.length;
    return disabled === 0 ? 'All enabled' : `${disabled} disabled`;
  }

  private configFileDesc(): DocumentFragment {
    const { settings, configChain } = this.plugin;
    const status = !settings.useConfigFile
      ? 'The settings below apply.'
      : configChain.length > 0
        ? `Using ${configChain.join(' -> ')}.`
        : 'No config file in the vault root, so the settings below apply.';
    return createFragment((fragment) => {
      fragment.appendText(`Read .rumdl.toml from the vault root instead of the settings below. ${status} `);
      fragment.createEl('a', { text: 'Config file reference', href: 'https://github.com/rvben/rumdl#configuration' });
    });
  }
}
