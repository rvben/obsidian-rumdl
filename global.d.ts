// The rumdl WASM binary, deflated and base64-encoded, inlined by esbuild at
// build time (see esbuild.config.mjs).
declare const RUMDL_WASM_DEFLATED_BASE64: string;

// The slice of Node's builtins the plugin uses on desktop to read `extends`
// targets outside the vault. Declared here rather than pulled in through
// @types/node so that the plugin's types do not depend on a Node runtime,
// which mobile does not have; the modules are loaded lazily at runtime behind
// a desktop check (see loadDesktopNode in main.ts).
declare module 'fs' {
  export const promises: {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
  };
}

declare module 'path' {
  export function resolve(...segments: string[]): string;
}

declare module 'os' {
  export function homedir(): string;
}

declare module 'process' {
  const process: {
    env: Record<string, string | undefined>;
  };
  export default process;
}
