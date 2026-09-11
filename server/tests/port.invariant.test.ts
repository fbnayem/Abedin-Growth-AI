import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_PORT, portFrom, resolvePort } from '../config/port';

/**
 * INVARIANTS FOR THE LISTEN PORT.
 *
 * `server.ts` bound the literal 3000 while `.env.example` documented `PORT=3000` as if it were
 * read. Found during the 2026-09-10 audit by starting the server with `PORT=8791` and watching it
 * bind 3000 anyway. Container platforms route traffic and health checks to the port they put in
 * `PORT`, so on Cloud Run this is a service that deploys, never receives a request, and is
 * restarted as unhealthy.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('1. PORT decides, and absence is the documented default', () => {
  it('an absent PORT is the local default', () => {
    expect(portFrom({})).toEqual({ ok: true, port: DEFAULT_PORT, source: 'DEFAULT' });
    expect(DEFAULT_PORT).toBe(3000);
  });

  it('a blank PORT is absent — what a copied .env.example line with no value produces', () => {
    for (const blank of ['', '   ']) {
      expect(portFrom({ PORT: blank }), JSON.stringify(blank)).toEqual({
        ok: true,
        port: DEFAULT_PORT,
        source: 'DEFAULT',
      });
    }
  });

  it('a platform-assigned port is the port', () => {
    expect(portFrom({ PORT: '8080' })).toEqual({ ok: true, port: 8080, source: 'ENV' });
    expect(portFrom({ PORT: ' 8791 ' })).toEqual({ ok: true, port: 8791, source: 'ENV' });
    // The regression itself: a PORT that differs from the old literal must win over it.
    expect(resolvePort({ PORT: '8791' })).toBe(8791);
  });

  it('the boundaries are the TCP range', () => {
    expect(portFrom({ PORT: '1' }).ok).toBe(true);
    expect(portFrom({ PORT: '65535' }).ok).toBe(true);
    expect(portFrom({ PORT: '0' }).ok).toBe(false);
    expect(portFrom({ PORT: '65536' }).ok).toBe(false);
  });
});

describe('2. a PORT that cannot be followed refuses rather than binding somewhere else', () => {
  it('every malformed value is refused', () => {
    // `parseInt('8080abc')` is 8080 and `Number('0x50')` is 80. Either binds a port the platform
    // is not routing to, and the deploy looks healthy from inside the container.
    for (const bad of ['8080abc', '0x50', '8080.0', '-1', '+80', '8 080', 'abc', '99999999', '1e3', 'NaN']) {
      expect(portFrom({ PORT: bad }).ok, bad).toBe(false);
    }
  });

  it('the refusal names the variable and what it received', () => {
    const result = portFrom({ PORT: '80a' });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('PORT');
      expect(result.reason).toContain('"80a"');
    }
  });

  it('resolvePort throws, so startup stops before anything binds', () => {
    expect(() => resolvePort({ PORT: '80a' })).toThrow(/PORT/);
    expect(resolvePort({ PORT: '4000' })).toBe(4000);
  });
});

describe('3. server.ts listens on the resolved port, and a failed start exits', () => {
  const code = stripComments(readFileSync('server.ts', 'utf8'));

  it('no literal port is assigned, and the resolved one is used', () => {
    expect(code).not.toMatch(/const\s+PORT\s*=\s*\d+/);
    expect(code).toMatch(/const\s+PORT\s*=\s*resolvePort\(\)/);
    expect(code).toMatch(/app\.listen\(\s*PORT\b/);
  });

  it('that check would catch the literal coming back', () => {
    const regressed = stripComments('async function s() {\n  const PORT = 3000; // was\n}');
    expect(regressed).toMatch(/const\s+PORT\s*=\s*\d+/);
  });

  /**
   * `startServer().catch(...)` logged and returned. The process then either lingered with nothing
   * bound, if anything else held the event loop open, or exited 0 — reporting success. Neither is
   * restarted as a crash, and a refused PORT is exactly the startup failure that would reach it.
   */
  it('a failed startup exits non-zero', () => {
    expect(code).toMatch(/startServer\(\)\.catch\([\s\S]{0,300}?process\.exit\(1\)/);
  });
});
