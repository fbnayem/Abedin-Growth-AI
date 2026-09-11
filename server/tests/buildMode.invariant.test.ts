import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * INVARIANTS FOR THE CLIENT BUILD'S MODE.
 *
 * `.env` carries `NODE_ENV=development` — `.env.example` ships that line — and Vite reads NODE_ENV
 * from `.env` unless it is already set in the environment. So `vite build` produced a DEVELOPMENT
 * client bundle on any machine with a `.env`. Measured on one commit: 1,996,561 bytes with
 * `import.meta.env.DEV === true`, against 1,302,215 with NODE_ENV=production.
 *
 * CI has no `.env`, so CI's artifact was correct and nothing in the pipeline could have noticed.
 * A developer's build and CI's build differing at all is the defect.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const CHECKER = join('scripts', 'check-client-bundle-mode.mjs');

/** Run the checker against a directory. Returns the exit code and what it printed. */
function runChecker(dir: string): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (e: any) {
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function bundleDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-mode-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  // Padded past the size floor: a file too small to be this application is reported as a broken
  // scan rather than a clean bundle.
  writeFileSync(join(assets, 'index-abc123.js'), contents + ';'.repeat(60_000));
  return assets;
}

describe('1. the build forces production, and says so where it cannot be skipped', () => {
  it('the build script runs the wrapper, not `vite build`', () => {
    expect(pkg.scripts.build).toContain('node scripts/build-client.mjs');
    expect(pkg.scripts.build).not.toMatch(/(^|&&\s*)vite build/);
  });

  it('and checks the artifact afterwards', () => {
    expect(pkg.scripts.build).toContain('check-client-bundle-mode.mjs');
    const built = pkg.scripts.build.indexOf('build-client.mjs');
    const checked = pkg.scripts.build.indexOf('check-client-bundle-mode.mjs');
    expect(checked).toBeGreaterThan(built);
  });

  it('NODE_ENV is set BEFORE vite is imported, which is the whole mechanism', () => {
    // Vite treats an already-set NODE_ENV as authoritative; set it after the import and `.env`
    // wins again. Order is the fix, so order is what this asserts.
    const source = readFileSync('scripts/build-client.mjs', 'utf8');
    const set = source.indexOf("process.env.NODE_ENV = 'production'");
    const imported = source.indexOf("await import('vite')");
    expect(set).toBeGreaterThan(-1);
    expect(imported).toBeGreaterThan(-1);
    expect(set).toBeLessThan(imported);
  });
});

describe('2. the checker reads the artifact, and refuses what it cannot read', () => {
  it('a development bundle fails, and the message names the marker', () => {
    const result = runChecker(bundleDir('const a = jsxDEV("div", {}, void 0, false);'));
    expect(result.code).toBe(1);
    expect(result.output).toContain('jsxDEV');
    expect(result.output).toContain('DEVELOPMENT build');
  });

  it('the other development marker fails too', () => {
    const result = runChecker(bundleDir('import "./react.development.js";'));
    expect(result.code).toBe(1);
  });

  it('a production bundle passes', () => {
    // The other half: a checker that failed on everything would satisfy the assertions above.
    const result = runChecker(bundleDir('const a = jsx("div", {}); const DEV = false;'));
    expect(result.code).toBe(0);
    expect(result.output).toContain('ok');
  });

  it('a missing directory is a failure, not a clean bundle', () => {
    const result = runChecker(join(tmpdir(), 'bundle-mode-does-not-exist-4a91'));
    expect(result.code).toBe(1);
    expect(result.output).toContain('does not exist');
  });

  it('an empty directory is a failure, not a clean bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-mode-empty-'));
    mkdirSync(join(dir, 'assets'));
    const result = runChecker(join(dir, 'assets'));
    expect(result.code).toBe(1);
    expect(result.output).toContain('no .js files');
  });

  it('a bundle too small to be this application is a failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-mode-small-'));
    const assets = join(dir, 'assets');
    mkdirSync(assets);
    writeFileSync(join(assets, 'index-abc123.js'), 'const a = jsx("div", {});');
    const result = runChecker(assets);
    expect(result.code).toBe(1);
    expect(result.output).toContain('floor');
  });
});
