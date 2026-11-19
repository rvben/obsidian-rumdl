// Starts the built plugin on the main thread of a real Chromium and fails
// unless it comes up working. Obsidian is Chromium, and Chromium enforces
// rules on its main thread that Node does not (such as the size limit on
// synchronous WebAssembly compilation), so only a browser can show that the
// bundle loads where it actually runs.
//
// Uses the Chrome that is already installed: set CHROME_BIN to choose one.
// Expects main.js to be built (`npm run build`).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startupProblems } from '../test-support/plugin-host.mjs';

const DEADLINE_MS = 60_000;
const root = fileURLToPath(new URL('../', import.meta.url));

function fail(message) {
  console.error(`browser smoke test failed: ${message}`);
  process.exit(1);
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];
  return candidates.find(candidate =>
    candidate.includes('/') ? existsSync(candidate) : spawnSync(candidate, ['--version']).status === 0,
  );
}

const PAGE = `<!DOCTYPE html>
<meta charset="utf-8">
<title>rumdl startup</title>
<script type="module">
  import { startPlugin } from '/plugin-host.mjs';
  let body;
  try {
    const code = await (await fetch('/main.js')).text();
    body = await startPlugin(code);
  } catch (error) {
    body = { pageError: String(error && error.stack || error) };
  }
  await fetch('/report', { method: 'POST', body: JSON.stringify(body) });
</script>`;

const mainJsPath = join(root, 'main.js');
if (!existsSync(mainJsPath)) fail('main.js is missing, run `npm run build` first');
const chrome = findChrome();
if (!chrome) fail('no Chrome or Chromium found, set CHROME_BIN');

const files = {
  '/': ['text/html', PAGE],
  '/main.js': ['text/javascript', readFileSync(mainJsPath)],
  '/plugin-host.mjs': ['text/javascript', readFileSync(join(root, 'test-support/plugin-host.mjs'))],
};

// The page reports its own result, so the outcome never depends on guessing
// when asynchronous startup has finished.
let deliver;
const reported = new Promise(resolve => { deliver = resolve; });
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/report') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { response.end(); deliver(body); });
    return;
  }
  const file = files[request.url];
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': file[0] }).end(file[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'rumdl-browser-smoke-'));
const browser = spawn(chrome, [
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  `--user-data-dir=${profile}`,
  // CI runners do not allow the unprivileged namespaces Chrome's sandbox
  // needs. The only page loaded is the local one served above.
  ...(process.env.CI ? ['--no-sandbox'] : []),
  url,
], { stdio: 'ignore' });

const exited = new Promise(resolve => {
  browser.on('error', error => resolve(`could not start ${chrome}: ${error.message}`));
  browser.on('exit', code => resolve(`${chrome} exited with code ${code} before reporting`));
});
let timer;
const deadline = new Promise(resolve => {
  timer = setTimeout(() => resolve(`no report from the page within ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
});

const outcome = await Promise.race([
  reported.then(body => ({ body })),
  exited.then(error => ({ error })),
  deadline.then(error => ({ error })),
]);

clearTimeout(timer);
browser.removeAllListeners();
// Killed outright: the profile is discarded, and a browser that stopped
// responding must not be able to keep this script waiting.
browser.kill('SIGKILL');
server.close();
server.closeAllConnections();
await new Promise(resolve => {
  if (browser.exitCode !== null || browser.signalCode !== null) resolve();
  else browser.on('exit', resolve);
});
rmSync(profile, { recursive: true, force: true, maxRetries: 5 });

if (outcome.error) fail(outcome.error);
const report = JSON.parse(outcome.body);
if (report.pageError) fail(`the page could not run the plugin: ${report.pageError}`);
const problems = startupProblems(report);
if (problems.length > 0) fail(`the plugin did not start in ${chrome}:\n  - ${problems.join('\n  - ')}`);
console.log(`browser smoke test passed: the plugin started and linted in ${chrome}`);
