# Obsidian rumdl Plugin

Markdown linting for Obsidian using [rumdl](https://github.com/rvben/rumdl) - a fast markdown linter.

## Features

- **Lint current file**: Check the current markdown file for issues
- **Fix all issues**: Automatically fix all auto-fixable issues
- **Show available rules**: View all 60+ linting rules
- **Status bar**: See issue count at a glance

## Commands

| Command | Description |
|---------|-------------|
| `rumdl: Lint current file` | Check the current file for markdown issues |
| `rumdl: Fix all issues in current file` | Auto-fix all fixable issues |
| `rumdl: Show available rules` | Display all available lint rules |

## Settings

- **Lint on save**: Automatically lint files when saved
- **Show status bar**: Display issue count in status bar

## Installation

### From Community Plugins (Coming Soon)

1. Open Settings → Community plugins
2. Search for "rumdl"
3. Install and enable

### Manual Installation

1. Download the latest release from [Releases](https://github.com/rvben/obsidian-rumdl/releases)
2. Extract to your vault's `.obsidian/plugins/obsidian-rumdl/` folder
3. Enable the plugin in Obsidian settings

## Development

```bash
npm install
npm run dev
```

## Building

```bash
npm run build
```

## License

MIT
