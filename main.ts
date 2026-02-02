import { App, Editor, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { initSync, Linter, get_version, get_available_rules } from 'rumdl-wasm';
import * as TOML from '@iarna/toml';
import { EditorView } from '@codemirror/view';
import { linter, Diagnostic } from '@codemirror/lint';

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

interface RumdlPluginSettings {
  formatOnSave: boolean;
  showStatusBar: boolean;
  disabledRules: string[];
  lineLength: number;
  useConfigFile: boolean;
  // Style options
  headingStyle: 'atx' | 'setext' | 'consistent';
  emphasisStyle: 'asterisk' | 'underscore' | 'consistent';
  strongStyle: 'asterisk' | 'underscore' | 'consistent';
  ulStyle: 'dash' | 'asterisk' | 'plus' | 'consistent';
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

// Generate URL for rule documentation
function getRuleDocsUrl(ruleName: string): string {
  return `https://github.com/rvben/rumdl/blob/main/docs/${ruleName.toLowerCase()}.md`;
}

// Create a linter extension factory - returns a linter bound to the plugin instance
function createRumdlLinter(plugin: RumdlPlugin) {
  return linter((view: EditorView) => {
    if (!plugin.wasmReady || !plugin.linter) {
      return [];
    }

    const content = view.state.doc.toString();
    const result = plugin.linter.check(content);
    const warnings: RumdlWarning[] = JSON.parse(result);

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
            const fixed = plugin.linter.fix(currentContent);
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
  statusBarItem!: HTMLElement;
  wasmReady = false;
  linter: Linter | null = null;
  originalSaveCallback: ((checking: boolean) => boolean) | undefined;
  configFilePath: string | null = null;

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
          if (view) this.lintEditor(view.editor);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Fix all issues')
        .setDisabled(!view)
        .onClick(() => {
          if (view) this.fixAll(view.editor);
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
            const tomlContent = await this.app.vault.adapter.read(configName);
            const parsed = TOML.parse(tomlContent) as Record<string, unknown>;
            // Flatten: merge global section with top-level config
            const globalSection = (parsed.global || {}) as Record<string, unknown>;
            const config = { ...parsed, ...globalSection };
            delete config.global;
            // Default to obsidian flavor if not specified in config
            if (!config.flavor) {
              config.flavor = 'obsidian';
            }
            this.linter = new Linter(config);
            this.configFilePath = configName;
            console.debug('rumdl: loaded config from', configName, config);
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

  async onload() {
    await this.loadSettings();

    // Settings tab - register early so it's always available
    this.addSettingTab(new RumdlSettingTab(this.app, this));

    // Initialize WASM module from embedded base64
    try {
      // Decode base64 WASM (injected by esbuild at build time)
      const wasmBinary = Uint8Array.from(atob(RUMDL_WASM_BASE64), c => c.charCodeAt(0));
      initSync(wasmBinary);

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

    // Status bar
    if (this.settings.showStatusBar) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass('rumdl-status');
      this.statusBarItem.addEventListener('click', (e) => this.showStatusMenu(e));
    }

    // Register CodeMirror linter extension (provides underlines + hover tooltips)
    this.registerEditorExtension([createRumdlLinter(this)]);

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
      editorCallback: (editor: Editor) => {
        this.lintEditor(editor);
      },
    });

    // Command: Fix all issues
    this.addCommand({
      id: 'fix-all-issues',
      name: 'Fix all',
      editorCallback: (editor: Editor) => {
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
  }

  onunload() {
    this.restoreOriginalSave();
    if (this.linter) {
      this.linter.free();
      this.linter = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Recreate linter with new settings
    if (this.wasmReady) {
      await this.createLinter();
    }
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

  lintEditor(editor: Editor, quiet = false) {
    if (!this.wasmReady || !this.linter) {
      new Notice('Linter is not ready yet');
      return;
    }

    const content = editor.getValue();
    const result = this.linter.check(content);
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
    if (!this.wasmReady || !this.linter) {
      new Notice('Linter is not ready yet');
      return;
    }

    const content = editor.getValue();
    const fixed = this.linter.fix(content);

    if (fixed !== content) {
      const cursor = editor.getCursor();
      editor.setValue(fixed);
      editor.setCursor(cursor);

      // Re-lint to show remaining issues
      const result = this.linter.check(fixed);
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
      new Notice('Linter is not ready yet');
      return;
    }

    const rules = JSON.parse(get_available_rules());
    new RulesModal(this.app, rules).open();
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
            const fixed = this.linter.fix(content);

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

  constructor(app: App, warnings: RumdlWarning[], editor: Editor, plugin: RumdlPlugin) {
    super(app);
    this.warnings = warnings;
    this.editor = editor;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Lint results (${this.warnings.length} issues)` });

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

    contentEl.createEl('h2', { text: `Available rules (${this.rules.length})` });

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

    // Plugin behavior settings
    new Setting(containerEl)
      .setName('Format on save')
      .setDesc('Automatically fix issues when files are saved')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.formatOnSave).onChange(async (value) => {
          this.plugin.settings.formatOnSave = value;
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

    // Linting section
    new Setting(containerEl).setName('Linting').setHeading();

    const configDesc = this.plugin.configFilePath
      ? `Using config from: ${this.plugin.configFilePath}`
      : 'No config file found. Using settings below.';

    new Setting(containerEl)
      .setName('Use config file')
      .setDesc(`Auto-detect .rumdl.toml in vault root. ${configDesc}`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useConfigFile).onChange(async (value) => {
          this.plugin.settings.useConfigFile = value;
          await this.plugin.saveSettings();
          this.display(); // Refresh to show/hide rule settings
        })
      );

    // Only show rule settings if not using config file
    if (!this.plugin.settings.useConfigFile || !this.plugin.configFilePath) {
      const noteEl = containerEl.createEl('p', { cls: 'rumdl-settings-note' });
      noteEl.setText('These settings apply when no config file is active. For full control of 60+ rules, use a ');
      noteEl.createEl('a', {
        text: '.rumdl.toml config file',
        href: 'https://github.com/rvben/rumdl#configuration',
      });
      noteEl.appendText('.');

      // Rules section - single list with disabled rules at top
      if (this.plugin.wasmReady) {
        const allRules: { name: string; description: string }[] = JSON.parse(get_available_rules());

        // Helper to create a rule setting
        const createRuleSetting = (rule: { name: string; description: string }, container: HTMLElement) => {
          const isDisabled = this.plugin.settings.disabledRules.includes(rule.name);
          const setting = new Setting(container)
            .setName(rule.name)
            .setDesc(rule.description)
            .addExtraButton((button) =>
              button
                .setIcon('external-link')
                .setTooltip('View documentation')
                .onClick(() => {
                  window.open(getRuleDocsUrl(rule.name), '_blank');
                })
            )
            .addToggle((toggle) =>
              toggle.setValue(!isDisabled).onChange(async (enabled) => {
                if (enabled) {
                  this.plugin.settings.disabledRules = this.plugin.settings.disabledRules.filter(r => r !== rule.name);
                } else {
                  if (!this.plugin.settings.disabledRules.includes(rule.name)) {
                    this.plugin.settings.disabledRules.push(rule.name);
                  }
                }
                await this.plugin.saveSettings();
                this.display();
              })
            );

          // Add visual styling for disabled rules
          if (isDisabled) {
            setting.settingEl.addClass('rumdl-rule-disabled');
          }
        };

        // Single collapsible rules list
        const disabledCount = this.plugin.settings.disabledRules.length;
        const rulesHeader = containerEl.createEl('div', { cls: 'rumdl-rules-header' });
        const collapseIcon = rulesHeader.createSpan({ cls: 'rumdl-collapse-icon' });
        setIcon(collapseIcon, 'chevron-right');
        rulesHeader.createSpan({
          text: disabledCount > 0
            ? `Rules (${disabledCount} disabled)`
            : `Rules (${allRules.length})`
        });

        const rulesContainer = containerEl.createEl('div', { cls: 'rumdl-rules-container rumdl-collapsed' });

        rulesHeader.addEventListener('click', () => {
          rulesContainer.classList.toggle('rumdl-collapsed');
          setIcon(collapseIcon, rulesContainer.classList.contains('rumdl-collapsed') ? 'chevron-right' : 'chevron-down');
        });

        // Sort rules: disabled first, then alphabetically
        const sortedRules = [...allRules].sort((a, b) => {
          const aDisabled = this.plugin.settings.disabledRules.includes(a.name);
          const bDisabled = this.plugin.settings.disabledRules.includes(b.name);
          if (aDisabled && !bDisabled) return -1;
          if (!aDisabled && bDisabled) return 1;
          return a.name.localeCompare(b.name);
        });

        // Add divider after disabled rules if any exist
        let addedDivider = false;
        for (const rule of sortedRules) {
          const isDisabled = this.plugin.settings.disabledRules.includes(rule.name);

          // Add divider between disabled and enabled sections
          if (!isDisabled && !addedDivider && disabledCount > 0) {
            rulesContainer.createEl('div', { cls: 'rumdl-rules-divider' });
            addedDivider = true;
          }

          createRuleSetting(rule, rulesContainer);
        }
      }

      new Setting(containerEl)
        .setName('Line length')
        .setDesc('Maximum line length (0 = unlimited)')
        .addText((text) =>
          text
            .setPlaceholder('80')
            .setValue(String(this.plugin.settings.lineLength))
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              this.plugin.settings.lineLength = isNaN(num) ? 0 : Math.max(0, num);
              await this.plugin.saveSettings();
            })
        );

      // Style settings
      new Setting(containerEl)
        .setName('Heading style')
        .setDesc('Preferred heading format (# vs underline)')
        .addDropdown((dropdown) =>
          dropdown
            .addOption('consistent', 'Consistent (detect from file)')
            .addOption('atx', 'Hash style (# heading)')
            .addOption('setext', 'Setext (underlined)')
            .setValue(this.plugin.settings.headingStyle)
            .onChange(async (value) => {
              this.plugin.settings.headingStyle = value as 'atx' | 'setext' | 'consistent';
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Unordered list style')
        .setDesc('Preferred bullet character')
        .addDropdown((dropdown) =>
          dropdown
            .addOption('consistent', 'Consistent (detect from file)')
            .addOption('dash', 'Dash (-)')
            .addOption('asterisk', 'Asterisk (*)')
            .addOption('plus', 'Plus (+)')
            .setValue(this.plugin.settings.ulStyle)
            .onChange(async (value) => {
              this.plugin.settings.ulStyle = value as 'dash' | 'asterisk' | 'plus' | 'consistent';
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Emphasis style')
        .setDesc('Preferred emphasis marker for *italic*')
        .addDropdown((dropdown) =>
          dropdown
            .addOption('consistent', 'Consistent (detect from file)')
            .addOption('asterisk', 'Asterisk (*text*)')
            .addOption('underscore', 'Underscore (_text_)')
            .setValue(this.plugin.settings.emphasisStyle)
            .onChange(async (value) => {
              this.plugin.settings.emphasisStyle = value as 'asterisk' | 'underscore' | 'consistent';
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Strong style')
        .setDesc('Preferred strong marker for **bold**')
        .addDropdown((dropdown) =>
          dropdown
            .addOption('consistent', 'Consistent (detect from file)')
            .addOption('asterisk', 'Asterisk (**text**)')
            .addOption('underscore', 'Underscore (__text__)')
            .setValue(this.plugin.settings.strongStyle)
            .onChange(async (value) => {
              this.plugin.settings.strongStyle = value as 'asterisk' | 'underscore' | 'consistent';
              await this.plugin.saveSettings();
            })
        );

      // Export button - only show if no config file exists
      new Setting(containerEl)
        .setName('Export to config file')
        .setDesc('Create .rumdl.toml from current settings (one-time migration)')
        .addButton((button) =>
          button.setButtonText('Export to .rumdl.toml').onClick(async () => {
            const success = await this.plugin.exportToConfigFile();
            if (success) {
              this.display(); // Refresh to show config file mode
            }
          })
        );
    }
  }
}
