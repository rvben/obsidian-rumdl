import { App, Editor, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import * as rumdlWasm from 'rumdl-wasm';
import initWasm, { initSync, lint_markdown, apply_all_fixes, apply_fix, get_version, get_available_rules } from 'rumdl-wasm';

interface RumdlWarning {
  line: number;
  column: number;
  message: string;
  rule_name?: string;
  rule?: string;
  fix?: {
    start: number;
    end: number;
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

    // Lint active file on load and when switching files
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
          this.lintEditor(view.editor, true);
        } else {
          this.updateStatusBar(null);
        }
      })
    );

    // Lint on editor changes (debounced)
    let debounceTimer: number;
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor: Editor) => {
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          this.lintEditor(editor, true);
        }, 500);
      })
    );

    // Lint current file if one is already open
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.lintEditor(activeView.editor, true);
    }

    // Command: Lint current file
    this.addCommand({
      id: 'lint-current-file',
      name: 'Lint current file',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.lintEditor(editor);
      },
    });

    // Command: Fix all issues
    this.addCommand({
      id: 'fix-all-issues',
      name: 'Fix all issues in current file',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.fixAll(editor);
      },
    });

    // Command: Show available rules
    this.addCommand({
      id: 'show-rules',
      name: 'Show available rules',
      callback: () => {
        this.showRules();
      },
    });

    // Settings tab
    this.addSettingTab(new RumdlSettingTab(this.app, this));

    // Lint on file change (if enabled)
    if (this.settings.lintOnSave) {
      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view && view.file === file) {
            this.lintEditor(view.editor, true);
          }
        })
      );
    }
  }

  onunload() {}

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
