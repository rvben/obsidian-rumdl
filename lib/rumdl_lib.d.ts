/* tslint:disable */
/* eslint-disable */
/**
 * Get list of available rules as JSON
 *
 * Returns a JSON array of rule info objects, each with:
 * - `name`: Rule name (e.g., "MD001")
 * - `description`: Rule description
 */
export function get_available_rules(): string;
/**
 * Initialize the WASM module with better panic messages
 */
export function init(): void;
/**
 * Get the rumdl version
 */
export function get_version(): string;
/**
 * A markdown linter with configuration
 *
 * Create a new `Linter` with a configuration object, then use
 * `check()` to lint content and `fix()` to auto-fix issues.
 */
export class Linter {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the current configuration as JSON
   */
  get_config(): string;
  /**
   * Apply all auto-fixes to the content and return the fixed content
   *
   * Uses the same fix coordinator as the CLI for consistent behavior.
   */
  fix(content: string): string;
  /**
   * Create a new Linter with the given configuration
   *
   * # Arguments
   *
   * * `options` - Configuration object (see LinterConfig)
   *
   * # Example
   *
   * ```javascript
   * const linter = new Linter({
   *   disable: ["MD041"],
   *   "line-length": 120
   * });
   * ```
   */
  constructor(options: any);
  /**
   * Lint markdown content and return warnings as JSON
   *
   * Returns a JSON array of warnings, each with:
   * - `rule_name`: Rule name (e.g., "MD001")
   * - `message`: Warning message
   * - `line`: 1-indexed line number
   * - `column`: 1-indexed column number
   * - `fix`: Optional fix object with `range.start`, `range.end`, `replacement`
   */
  check(content: string): string;
  /**
   * Create a Linter from a TOML configuration string
   *
   * Parses a `.rumdl.toml` file content and creates a Linter with those settings.
   * This allows sharing configuration between CLI and WASM usage.
   *
   * # Example
   *
   * ```javascript
   * const toml = `
   * [global]
   * disable = ["MD041", "MD013"]
   * line-length = 120
   * flavor = "mkdocs"
   * `;
   * const linter = Linter.from_toml(toml);
   * ```
   */
  static from_toml(toml_content: string): Linter;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_linter_free: (a: number, b: number) => void;
  readonly get_available_rules: (a: number) => void;
  readonly get_version: (a: number) => void;
  readonly init: () => void;
  readonly linter_check: (a: number, b: number, c: number, d: number) => void;
  readonly linter_fix: (a: number, b: number, c: number, d: number) => void;
  readonly linter_from_toml: (a: number, b: number, c: number) => void;
  readonly linter_get_config: (a: number, b: number) => void;
  readonly linter_new: (a: number, b: number) => void;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export3: (a: number) => void;
  readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
