# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.89](https://github.com/rvben/obsidian-rumdl/compare/v0.0.2...v0.0.89) - 2026-04-23

### Added

- enable Obsidian flavor by default ([0f6e67a](https://github.com/rvben/obsidian-rumdl/commit/0f6e67a399dc7a707d922d74206d0381236621c2))
- **config**: improve config validation and error handling ([ffa4d29](https://github.com/rvben/obsidian-rumdl/commit/ffa4d29c9646bd28354edf4b675f0e5220ed4961))
- **build**: embed WASM in main.js for universal compatibility ([f9b1e3a](https://github.com/rvben/obsidian-rumdl/commit/f9b1e3a84767cebd09b0c36196758fc161f30b06))
- **dev**: add lint-staged, strict TypeScript, and CI workflow ([d54d0bf](https://github.com/rvben/obsidian-rumdl/commit/d54d0bf40fe5d209cac97f60510e6318c5dd482c))
- **ui**: add documentation links for rules ([f9c6cc8](https://github.com/rvben/obsidian-rumdl/commit/f9c6cc8547da5bd7621fe72b9d1338799937b3d8))
- **settings**: replace text input with collapsible rule toggles ([fcf9b5d](https://github.com/rvben/obsidian-rumdl/commit/fcf9b5d4815013ca5ad09ab07fd01183a7e16772))
- **settings**: add style preference dropdowns ([53d2260](https://github.com/rvben/obsidian-rumdl/commit/53d2260240dc298ca4e7bcdfc990bf865139204a))
- **plugin**: add export settings to config file ([ee0ede1](https://github.com/rvben/obsidian-rumdl/commit/ee0ede145c8aa31bb67cff296cf4292f5f4d88fa))
- **plugin**: add config file support with Linter class API ([8d6055e](https://github.com/rvben/obsidian-rumdl/commit/8d6055eed34e177b248fa0b8836b71e9346f32fe))
- **plugin**: add format on save feature ([d21c35c](https://github.com/rvben/obsidian-rumdl/commit/d21c35cc744ba148a9f9e705b07b250653c1d69f))
- update to use Linter class API with configuration support ([c65c7d0](https://github.com/rvben/obsidian-rumdl/commit/c65c7d0c429841bfb7e10ab49e70fc2eae617aa3))
- **ui**: add CodeMirror linter with Fix buttons in hover tooltips ([a85f2ac](https://github.com/rvben/obsidian-rumdl/commit/a85f2aca60e716acc0e8554c351f16f04991802a))

### Fixed

- honor .rumdl.toml exclude patterns for active file (#16) ([74fe795](https://github.com/rvben/obsidian-rumdl/commit/74fe795f9f2568d012c7b4a0099066265a1f0bcc))
- skip linting for isolated editor contexts (table cells, embeds) ([f05c3d9](https://github.com/rvben/obsidian-rumdl/commit/f05c3d9fd4a4de68b5bac6a14a140624b56ed01e))
- **config**: flatten global section when loading .rumdl.toml ([80cc6dd](https://github.com/rvben/obsidian-rumdl/commit/80cc6ddacda892bb47073878e3afd4b9639b353c))
- **settings**: register settings tab before WASM loading ([694fb33](https://github.com/rvben/obsidian-rumdl/commit/694fb33f65c8c2f7a22df3fbc67b2ca411a61e0c))
- **settings**: change 'Fallback settings' to 'Fallback options' ([0c7b724](https://github.com/rvben/obsidian-rumdl/commit/0c7b7247b2dad0234274feffd5677b25b91f16fd))
- **obsidian**: address ObsidianReviewBot feedback for v0.0.4 ([8a00802](https://github.com/rvben/obsidian-rumdl/commit/8a008029d2a1784e939529b16836cd9b4d194903))
- rename plugin id from obsidian-rumdl to rumdl ([2e96510](https://github.com/rvben/obsidian-rumdl/commit/2e965102ad8df3f9f846742c1e2cb15e0670a964))
