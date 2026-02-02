# Obsidian rumdl Plugin

Fast markdown linting for Obsidian using [rumdl](https://github.com/rvben/rumdl) - a Rust-based markdown linter compiled to WebAssembly.

## Features

- **Real-time linting** - See issues as you type with inline diagnostics
- **One-click fixes** - Fix issues directly from the hover tooltip
- **Format on save** - Automatically fix all issues when saving
- **Status bar** - See issue count at a glance, click to view details
- **50+ lint rules** - Comprehensive markdown style checking
- **Config file support** - Use `.rumdl.toml` for project-wide settings
- **Rule documentation** - Quick links to rule docs from settings and tooltips

## Screenshots

<!-- TODO: Add screenshots -->
<!-- ![Status Bar](screenshots/status-bar.png) -->
<!-- ![Inline Diagnostics](screenshots/diagnostics.png) -->
<!-- ![Settings](screenshots/settings.png) -->

## Installation

### Via BRAT (Recommended - while awaiting community plugin approval)

The easiest way to install and get automatic updates while the [community plugin PR](https://github.com/obsidianmd/obsidian-releases/pull/8822) is pending:

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Community Plugins
2. Open Obsidian Settings → BRAT
3. Click **Add Beta plugin**
4. Enter: `rvben/obsidian-rumdl`
5. Enable the plugin in Settings → Community Plugins

BRAT will automatically update the plugin when new releases are published.

### Manual Installation

1. Download the latest release from [Releases](https://github.com/rvben/obsidian-rumdl/releases)
2. Extract to your vault's `.obsidian/plugins/obsidian-rumdl/` folder
3. Enable the plugin in Settings → Community plugins

### From Community Plugins

Pending approval ([PR #8822](https://github.com/obsidianmd/obsidian-releases/pull/8822)). Use BRAT in the meantime for easy installation and updates.

## Usage

Once enabled, the plugin automatically lints markdown files as you edit them:

- **Status bar** shows the issue count (click to see details)
- **Hover over underlined text** to see the issue and available fixes
- **Click "Fix"** in the tooltip to apply the fix
- **Click "Docs"** to view the rule documentation

## Settings

| Setting | Description |
|---------|-------------|
| **Format on save** | Automatically fix all issues when saving |
| **Show status bar** | Display issue count in the status bar |
| **Use config file** | Load settings from `.rumdl.toml` if present |
| **Line length** | Maximum line length (0 = unlimited) |
| **Style preferences** | Heading, emphasis, strong, and list styles |
| **Rules** | Enable/disable individual lint rules |

## Configuration File

Create a `.rumdl.toml` in your vault root for project-wide settings:

```toml
[global]
disable = ["MD041", "MD013"]
line-length = 120
# flavor = "standard"  # Uncomment to disable Obsidian-specific syntax support

[MD013]
line-length = 100

[MD007]
indent = 4
```

You can also export your current settings to a config file from the plugin settings.

## Obsidian-Specific Syntax Support

This plugin automatically enables **Obsidian flavor** which recognizes Obsidian-specific markdown syntax:

| Syntax | Example | How it's handled |
|--------|---------|------------------|
| **Tags** | `#my-tag` | Not flagged as missing heading space (MD018) |
| **Callouts** | `> [!NOTE]` | Recognized as valid blockquotes |
| **Highlights** | `==highlighted==` | Not flagged as spacing issue |
| **Comments** | `%%comment%%` | Content inside is skipped |
| **Extended checkboxes** | `- [/]`, `- [-]`, `- [>]` | Recognized as valid task items |
| **Dataview fields** | `field:: value` | Not flagged as consecutive spaces |
| **Templater** | `<% code %>` | Recognized as template syntax |
| **Wikilinks** | `[[link]]` | Properly handled |
| **Block references** | `^block-id` | Not flagged |

If you need standard markdown linting without Obsidian flavor, add `flavor = "standard"` to your `.rumdl.toml`.

## Default Settings for Obsidian

The plugin comes with sensible defaults for Obsidian:

- **MD041 (first-line-heading)** - Disabled by default (notes often have frontmatter)
- **Line length** - Set to unlimited (prose writing has long lines)
- **Obsidian flavor** - Enabled by default for Obsidian-specific syntax support

## Supported Rules

rumdl supports 50+ lint rules. Click the docs icon next to each rule in settings to learn more.

Common rules include:

- **MD001** - Heading levels should increment by one
- **MD003** - Heading style consistency
- **MD009** - No trailing spaces
- **MD012** - No multiple consecutive blank lines
- **MD022** - Headings should be surrounded by blank lines
- **MD032** - Lists should be surrounded by blank lines

## Development

```bash
# Install dependencies
npm install

# Development build with hot reload
npm run dev

# Production build
npm run build
```

## About rumdl

[rumdl](https://github.com/rvben/rumdl) is a fast markdown linter written in Rust. This plugin uses the WebAssembly build for browser compatibility.

## License

MIT
