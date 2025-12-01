import { App, Editor, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { initSync, lint_markdown, apply_all_fixes, get_version, get_available_rules } from 'rumdl-wasm';
import { EditorView } from '@codemirror/view';
import { linter, Diagnostic } from '@codemirror/lint';

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

interface RumdlPluginSettings {
  lintOnSave: boolean;
  showStatusBar: boolean;
}

const DEFAULT_SETTINGS: RumdlPluginSettings = {
  lintOnSave: false,
  showStatusBar: true,
};

// Global reference to the plugin instance for the linter
let pluginInstance: RumdlPlugin | null = null;

// Create a linter extension using @codemirror/lint
const rumdlLinter = linter((view: EditorView) => {
  if (!pluginInstance || !pluginInstance.wasmReady) {
    return [];
  }

  const content = view.state.doc.toString();
  const result = lint_markdown(content);
  const warnings: RumdlWarning[] = JSON.parse(result);

  // Update status bar
  pluginInstance.updateStatusBar(warnings.length);

  // Convert rumdl warnings to CodeMirror diagnostics
  const diagnostics: Diagnostic[] = [];

  for (const warning of warnings) {
    // Convert line/column to document position
    if (warning.line >= 1 && warning.line <= view.state.doc.lines) {
      const line = view.state.doc.line(warning.line);
      const from = line.from + Math.max(0, (warning.column || 1) - 1);
      const to = line.to;

      const diagnostic: Diagnostic = {
        from,
        to,
        severity: 'warning',
        message: warning.message,
        source: warning.rule_name || warning.rule || 'rumdl',
      };

      // Add fix action if available
      if (warning.fix) {
        const fixStart = warning.fix.range.start;
        const fixEnd = warning.fix.range.end;
        const fixReplacement = warning.fix.replacement;

        diagnostic.actions = [{
          name: 'Fix',
          apply: (view: EditorView) => {
            view.dispatch({
              changes: { from: fixStart, to: fixEnd, insert: fixReplacement }
            });
          }
        }];
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
          const currentContent = view.state.doc.toString();
          const fixed = apply_all_fixes(currentContent);
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

export default class RumdlPlugin extends Plugin {
  settings: RumdlPluginSettings;
  statusBarItem: HTMLElement;
  wasmReady = false;

  updateStatusBar(issueCount: number | null) {
    if (!this.statusBarItem) return;

    this.statusBarItem.empty();
    const iconEl = this.statusBarItem.createSpan({ cls: 'rumdl-status-icon' });
    const textEl = this.statusBarItem.createSpan({ cls: 'rumdl-status-text' });

    if (issueCount === null) {
      setIcon(iconEl, 'file-check');
      textEl.setText('ready');
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
        .setTitle('📋 View issues')
        .setDisabled(!view)
        .onClick(() => {
          if (view) this.lintEditor(view.editor);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('🔧 Fix all issues')
        .setDisabled(!view)
        .onClick(() => {
          if (view) this.fixAll(view.editor);
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('📖 Available rules')
        .onClick(() => this.showRules())
    );

    menu.showAtMouseEvent(e);
  }

  async onload() {
    await this.loadSettings();

    // Set global plugin instance for the linter
    pluginInstance = this;

    // Initialize WASM module by loading the .wasm file from plugin directory
    try {
      const pluginDir = this.manifest.dir;
      const wasmPath = `${pluginDir}/rumdl_lib_bg.wasm`;

      // Read the WASM file as binary using Obsidian's adapter
      const wasmBuffer = await this.app.vault.adapter.readBinary(wasmPath);

      // Initialize WASM synchronously with the buffer
      initSync(wasmBuffer);
      this.wasmReady = true;

      const version = get_version();
      console.log(`rumdl v${version} loaded`);
    } catch (error) {
      console.error('Failed to load rumdl-wasm:', error);
      new Notice('Failed to load rumdl markdown linter');
      return;
    }

    // Status bar
    if (this.settings.showStatusBar) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass('rumdl-status');
      this.statusBarItem.addEventListener('click', (e) => this.showStatusMenu(e));
    }

    // Register CodeMirror linter extension (provides underlines + hover tooltips)
    this.registerEditorExtension([rumdlLinter]);

    // Update status bar when switching files
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          this.updateStatusBar(null);
        }
      })
    );

    // Command: Lint current file (shows modal with results)
    this.addCommand({
      id: 'lint-current-file',
      name: 'Check file',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.lintEditor(editor);
      },
    });

    // Command: Fix all issues
    this.addCommand({
      id: 'fix-all-issues',
      name: 'Fix all',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.fixAll(editor);
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

    // Settings tab
    this.addSettingTab(new RumdlSettingTab(this.app, this));
  }

  onunload() {
    pluginInstance = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  lintEditor(editor: Editor, quiet = false) {
    if (!this.wasmReady) {
      new Notice('rumdl is not ready yet');
      return;
    }

    const content = editor.getValue();
    const result = lint_markdown(content);
    const warnings: RumdlWarning[] = JSON.parse(result);

    this.updateStatusBar(warnings.length);

    if (warnings.length === 0) {
      if (!quiet) {
        new Notice('No issues found');
      }
    } else {
      if (!quiet) {
        new LintResultsModal(this.app, warnings, editor, this).open();
      }
    }
  }

  fixAll(editor: Editor) {
    if (!this.wasmReady) {
      new Notice('rumdl is not ready yet');
      return;
    }

    const content = editor.getValue();
    const fixed = apply_all_fixes(content);

    if (fixed !== content) {
      const cursor = editor.getCursor();
      editor.setValue(fixed);
      editor.setCursor(cursor);

      // Re-lint to show remaining issues
      const result = lint_markdown(fixed);
      const remaining: RumdlWarning[] = JSON.parse(result);

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
      new Notice('rumdl is not ready yet');
      return;
    }

    const rules = JSON.parse(get_available_rules());
    new RulesModal(this.app, rules).open();
  }
}

class LintResultsModal extends Modal {
  warnings: RumdlWarning[];
  editor: Editor;
  plugin: RumdlPlugin;

  constructor(app: App, warnings: RumdlWarning[], editor: Editor, plugin: RumdlPlugin) {
    super(app);
    this.warnings = warnings;
    this.editor = editor;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Lint Results (${this.warnings.length} issues)` });

    const fixable = this.warnings.filter(w => w.fix).length;
    if (fixable > 0) {
      const fixAllBtn = contentEl.createEl('button', { text: `Fix all ${fixable} auto-fixable issues` });
      fixAllBtn.addEventListener('click', () => {
        this.plugin.fixAll(this.editor);
        this.close();
      });
    }

    const list = contentEl.createEl('div', { cls: 'rumdl-results' });

    for (const warning of this.warnings) {
      const item = list.createEl('div', { cls: 'rumdl-warning' });

      const header = item.createEl('div', { cls: 'rumdl-warning-header' });
      header.createEl('strong', { text: warning.rule_name || warning.rule || 'Unknown' });
      header.createEl('span', { text: ` Line ${warning.line}:${warning.column}` });

      if (warning.fix) {
        header.createEl('span', { text: ' [fixable]', cls: 'rumdl-fixable' });
      }

      item.createEl('div', { text: warning.message, cls: 'rumdl-message' });

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
  rules: { name: string; description: string }[];

  constructor(app: App, rules: { name: string; description: string }[]) {
    super(app);
    this.rules = rules;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Available Rules (${this.rules.length})` });

    const list = contentEl.createEl('div', { cls: 'rumdl-rules' });

    for (const rule of this.rules) {
      const item = list.createEl('div', { cls: 'rumdl-rule' });
      item.createEl('strong', { text: rule.name });
      item.createEl('span', { text: `: ${rule.description}` });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class RumdlSettingTab extends PluginSettingTab {
  plugin: RumdlPlugin;

  constructor(app: App, plugin: RumdlPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'rumdl Settings' });

    new Setting(containerEl)
      .setName('Lint on save')
      .setDesc('Automatically lint files when they are saved')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.lintOnSave).onChange(async (value) => {
          this.plugin.settings.lintOnSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show status bar')
      .setDesc('Show lint status in the status bar')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
