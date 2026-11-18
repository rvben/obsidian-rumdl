import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const advisory = 'GHSA-fc5q-39xc-vjpf';
const audit = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
process.stderr.write(audit.stderr ?? '');

if (audit.status === 0) {
  process.stdout.write(audit.stdout);
} else {
  let withdrawnDevAdvisory = false;
  try {
    const report = JSON.parse(audit.stdout);
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const findings = Object.values(report.vulnerabilities);
    const causes = findings.flatMap(({ via }) => via.filter((cause) => typeof cause !== 'string'));

    // npm can continue reporting this withdrawn advisory and its dependent
    // findings. Only accept it for development tools, while it stays withdrawn.
    if (audit.status === 1 && !audit.error && !report.error && report.auditReportVersion === 2 &&
        causes.length > 0 && causes.every(({ name, url }) =>
          name === 'picomatch' && url === `https://github.com/advisories/${advisory}`) &&
        findings.every(({ nodes, via }) => nodes.length > 0 &&
          nodes.every((node) => lock.packages[node]?.dev === true) &&
          via.length > 0 && via.every((cause) =>
            typeof cause !== 'string' || Object.hasOwn(report.vulnerabilities, cause)))) {
      const response = await fetch(`https://api.github.com/advisories/${advisory}`, {
        headers: { 'User-Agent': 'dependency-audit', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const record = await response.json();
        withdrawnDevAdvisory = record.ghsa_id === advisory && Boolean(record.withdrawn_at);
      }
    }
  } catch (error) {
    console.error(`Could not verify the withdrawn npm advisory: ${error.message}`);
  }

  if (withdrawnDevAdvisory) {
    console.warn(`npm audit reported only withdrawn advisory ${advisory} in development dependencies.`);
  } else {
    process.stdout.write(audit.stdout ?? '');
    if (audit.error) console.error(audit.error.message);
    process.exitCode = 1;
  }
}
