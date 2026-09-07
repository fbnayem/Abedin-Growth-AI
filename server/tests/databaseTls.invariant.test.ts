import { describe, it, expect } from 'vitest';
import type { PeerCertificate } from 'tls';
import {
  resolveTlsPlan,
  spkiFingerprint,
  describePlan,
  tlsOptionsForExternalTool,
  verifyCertificate,
  DatabaseTlsError,
} from '../db/tls';

/**
 * A CONNECTION NOBODY VERIFIED IS NOT A CONNECTION THAT FAILED.
 *
 * `ssl: { rejectUnauthorized: false }` sat on seven Postgres call sites, including the pool that
 * carries customers' plaintext Gmail access and refresh tokens. Nothing objected. It compiles,
 * it connects, queries return rows — the only thing missing is the part that establishes who
 * answered. While `DATABASE_URL` was unset it cost nothing, because nothing connected. There is
 * now a live instance on a public IP on the other end of it.
 *
 * Measured against that instance rather than assumed: the certificate is signed by a per-instance
 * "Cloud SQL Server CA" that chains to no public root and is NOT sent in the handshake, so the
 * presented chain is one certificate deep. `rejectUnauthorized: true` therefore fails every
 * connection, and putting the leaf in `ca` fails too — four configurations were tried against the
 * live server and all four were refused with `unable to verify the first certificate`, because
 * OpenSSL wants a chain ending at a self-signed root and node does not expose the partial-chain
 * flag.
 *
 * So the module verifies by hand, and these tests are about the part that decides. They do not
 * touch the network: what a test can hold still is which mode is chosen, what is refused, and
 * whether anything at all is allowed through unverified. The live proof that a wrong pin and a
 * wrong CN are actually rejected by a real handshake is recorded in the commit, because it needs
 * a server to be a proof rather than an assertion.
 */

// Two self-signed fixtures generated for this file. Different keys, so a fingerprint that is
// really a constant cannot pass.
const CERT_ONE_DER =
    'MIIDDTCCAfWgAwIBAgIUOt8mNsK53e+C+PIm1fbilIJDMMowDQYJKoZIhvcNAQELBQAwFjEUMBIG' +
    'A1UEAwwLZml4dHVyZS1vbmUwHhcNMjYwOTA3MTgwMzI4WhcNMzYwOTA0MTgwMzI4WjAWMRQwEgYD' +
    'VQQDDAtmaXh0dXJlLW9uZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKXQRQ2AfxT+' +
    '9xjMk/hHHOOSbKTpsT8IE3bkL5Ltc4G0I9+ga2BqzrIdLD4kQUkR8hYiWaiN6izYX4AHXJUj4Zvu' +
    '4SzlMS/i96a0kaFCnVCZCJyTY/96OyjMJb/DQWxpfPb9mhzc/leW6fDwaBrWpVprG5hQQmmeefXN' +
    'lW6Ksp9k66+UQ2oWDuJi4VIG/6qrEmOXkyfhfWt94ppSQTUnLQgLDNxXwTS9CCEkadYWHgkiTEVr' +
    'RggWTWsHYdaXN1ugZnsYyNUSkxm2dCgwNXURXSohkJPMxf7XABekRkOk35xbnkztZPFjGJh7qE+k' +
    '3a6rgLxMzTY/pvvn7VjNT1sfjUkCAwEAAaNTMFEwHQYDVR0OBBYEFNmbnCj+0yOzH6/cKX1bEO7z' +
    'BPm8MB8GA1UdIwQYMBaAFNmbnCj+0yOzH6/cKX1bEO7zBPm8MA8GA1UdEwEB/wQFMAMBAf8wDQYJ' +
    'KoZIhvcNAQELBQADggEBAGBqd3PUVbXF9PZLxkm1jNCnL0pctW8/jphgvL+dPIxAXwQ+zrwBlSjh' +
    'sXbtFFOgO6W2y+9xoc8Hvg7roeVojUQXFnD0IJx2IlXoYYvXHIiP3UFtrUd4g0KRIOr5LkyDm5ag' +
    'GSS+m/iBV0n4s1Kqv1AVAAFK299QpeNvYJhbimkcCmHqPWgZUDMyntsaMA1mNmvadSqic+f9hHfX' +
    'E84N0+pITBk9L27dmhuqEjJllMvhEJTIRiSxWpwt3gxxjp/6TjX7WmnYBmgeTZUQXO7OXRd1FWPj' +
    'aljnr7YsB0fVXOYTXFGRmVU9gB746LT3tPPZHl7ZdATci2LMbLB1bHrFBAE=';
const CERT_TWO_DER =
    'MIIDDTCCAfWgAwIBAgIUfMP64Zg5Kr6D7w30YRJ/A6JMxbkwDQYJKoZIhvcNAQELBQAwFjEUMBIG' +
    'A1UEAwwLZml4dHVyZS10d28wHhcNMjYwOTA3MTgwMzM2WhcNMzYwOTA0MTgwMzM2WjAWMRQwEgYD' +
    'VQQDDAtmaXh0dXJlLXR3bzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMt8eY25Gg9Q' +
    'oVPY+oW+DF/qJqZaSAQfpa0S9nZ36kaRySfOGLTulQpCuuzxLLL9V33EOK1att759YpBbdD6i5E+' +
    'wbX+Tw4WUeEy8QmLWzMehKSNFYG1PnJZU+rJsXpjHLPobU/XmOuoLDFPzf1scITy/DrsD44b63Nx' +
    'xdnAq8UoDyKG7MurPoZ5AxrR4DCX8UjI7OK0bybHmjOJsn4w77hx967RwaoiKixTfuE+10Ea0BIL' +
    'YXQI/ygX0qel2zqCAA1Cg29/InLe5khYxzTnPx0chOKnxDbltOVG3PC72p73oapvmCJLUh2qIv/u' +
    'xfdwFGVtRSTZUs4A8kyq7bQjOOECAwEAAaNTMFEwHQYDVR0OBBYEFEX/3whM6TRjgodFiyCnasUh' +
    'deQvMB8GA1UdIwQYMBaAFEX/3whM6TRjgodFiyCnasUhdeQvMA8GA1UdEwEB/wQFMAMBAf8wDQYJ' +
    'KoZIhvcNAQELBQADggEBACSZXb2NOO6HJ8rb0Ti2XqEjqWpNY3O0b8eBNLBLY4jLPyEfFshw6BN6' +
    'eL2WxCCGkcfQzzSxl/RXVCblz0D3dkEyoiIG9vSYHwvTeb0osoEfDyQjAveSMjCwKQ2A0fHknVUD' +
    'ad+qeqIkulDFW0IVWWIgDhHLTY9kQnBQ6YP917ZATl0hfJKEwILtovgxcns5eA5SpMJwTGYNZ3MM' +
    'p1iWp+9TB445XdrDdTboHykmMqEmQX/epJSufQAyovP2ojDQhJZ51lD33JuzJsqdoQPFx6fNlvNf' +
    'V933uI9U6H3LnJg+geKAc/AvfY7TIeSmyDChJ+PdLNMkZZcxVGtHwz4syVg=';

const CERT_ONE_SPKI = 'o2CIxFVwpAa1TRd2+6sI94ylg/+V27vf4LhNiyt3TxY=';
const CERT_TWO_SPKI = 'qSoeyRwtOoyHREDVfUoVVEGgPieYNXjlp5Q40ECtKoE=';

const certOf = (der: string, cn: string): PeerCertificate =>
  ({ raw: Buffer.from(der, 'base64'), subject: { CN: cn } }) as unknown as PeerCertificate;

const CN = 'linen-office-320801:growth-ai-abedin-747';

// A real CA, in the shape the loader expects. Its contents are never verified against anything
// here — only that a configured CA selects CA_VERIFIED over pinning.
const SOME_CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

// ===========================================================================
describe('1. an unverifiable server is not a server this connects to', () => {
  /**
   * The invariant the whole module exists for. `rejectUnauthorized: false` was the system
   * answering "cannot verify" with "carry on" — the same shape as every other defect the
   * addendum is about, and the one §14 names directly: an unknown state must not resolve to
   * permission.
   */
  it('refuses when neither a CA nor a pin is configured', () => {
    expect(() => resolveTlsPlan({ DATABASE_TLS_EXPECTED_CN: CN } as NodeJS.ProcessEnv)).toThrow(
      DatabaseTlsError
    );
  });

  it('says what to supply, because the caller has to fix it', () => {
    expect(() => resolveTlsPlan({ DATABASE_TLS_EXPECTED_CN: CN } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_CA_CERT_FILE|DATABASE_TLS_SPKI_SHA256/
    );
  });

  /**
   * An empty or whitespace pin is a configuration that looks present and verifies nothing. It
   * must be treated as absent rather than as an empty allow-list that happens to reject —
   * because the next reader would see a value set and believe the connection was verified.
   */
  it('an empty pin is absent, not permissive', () => {
    for (const value of ['', '   ', ',', ' , , ']) {
      expect(() =>
        resolveTlsPlan({
          DATABASE_TLS_EXPECTED_CN: CN,
          DATABASE_TLS_SPKI_SHA256: value,
        } as NodeJS.ProcessEnv)
      ).toThrow(DatabaseTlsError);
    }
  });

  /**
   * A certificate can be genuine and belong to a different database. Without an expected CN the
   * only thing checked is that someone holds a valid key — and on Cloud SQL every instance in
   * the project is a someone.
   */
  it('refuses without an expected CN even when a pin is configured', () => {
    expect(() =>
      resolveTlsPlan({ DATABASE_TLS_SPKI_SHA256: CERT_ONE_SPKI } as NodeJS.ProcessEnv)
    ).toThrow(/DATABASE_TLS_EXPECTED_CN/);
  });

  it('refuses a CA that is not a certificate', () => {
    expect(() =>
      resolveTlsPlan({
        DATABASE_TLS_EXPECTED_CN: CN,
        DATABASE_CA_CERT: 'not a certificate',
      } as NodeJS.ProcessEnv)
    ).toThrow(/PEM certificate/);
  });
});

// ===========================================================================
describe('2. the mode chosen is the strongest one configured', () => {
  it('a CA wins over a pin, because it is the stronger claim', () => {
    const plan = resolveTlsPlan({
      DATABASE_TLS_EXPECTED_CN: CN,
      DATABASE_CA_CERT: SOME_CA,
      DATABASE_TLS_SPKI_SHA256: CERT_ONE_SPKI,
    } as NodeJS.ProcessEnv);
    expect(plan.mode).toBe('CA_VERIFIED');
  });

  it('a pin alone is PINNED', () => {
    const plan = resolveTlsPlan({
      DATABASE_TLS_EXPECTED_CN: CN,
      DATABASE_TLS_SPKI_SHA256: CERT_ONE_SPKI,
    } as NodeJS.ProcessEnv);
    expect(plan.mode).toBe('PINNED');
    expect(plan.mode === 'PINNED' && plan.spkiSha256).toEqual([CERT_ONE_SPKI]);
  });

  it('several pins are kept, so a key rotation does not need a deploy to survive', () => {
    const plan = resolveTlsPlan({
      DATABASE_TLS_EXPECTED_CN: CN,
      DATABASE_TLS_SPKI_SHA256: ` ${CERT_ONE_SPKI} , ${CERT_TWO_SPKI} `,
    } as NodeJS.ProcessEnv);
    expect(plan.mode === 'PINNED' && plan.spkiSha256).toEqual([CERT_ONE_SPKI, CERT_TWO_SPKI]);
  });

  /**
   * Pinning is trust-on-first-use and CA verification is not. Reporting them with the same words
   * would make the weaker one read as the stronger, which is the kind of claim this repository's
   * signed documents were found making about controls that did not exist.
   */
  it('says which of the two it is, in words that differ', () => {
    const pinned = describePlan(
      resolveTlsPlan({
        DATABASE_TLS_EXPECTED_CN: CN,
        DATABASE_TLS_SPKI_SHA256: CERT_ONE_SPKI,
      } as NodeJS.ProcessEnv)
    );
    const ca = describePlan(
      resolveTlsPlan({
        DATABASE_TLS_EXPECTED_CN: CN,
        DATABASE_CA_CERT: SOME_CA,
      } as NodeJS.ProcessEnv)
    );
    expect(pinned).toMatch(/trust-on-first-use/);
    expect(ca).not.toMatch(/trust-on-first-use/);
    expect(pinned).not.toBe(ca);
  });
});

// ===========================================================================
describe('3. the fingerprint distinguishes keys', () => {
  /**
   * The failure worth guarding is a fingerprint that is really a constant — hashing a field that
   * is undefined on this node version, say, which would produce the same value for every server
   * and a pin that matches all of them. Two different keys must not agree.
   */
  it('two different certificates have different fingerprints', () => {
    expect(spkiFingerprint(certOf(CERT_ONE_DER, 'a'))).not.toBe(
      spkiFingerprint(certOf(CERT_TWO_DER, 'b'))
    );
  });

  it('the fingerprint is the SHA-256 of the public key, and it is stable', () => {
    expect(spkiFingerprint(certOf(CERT_ONE_DER, 'a'))).toBe(CERT_ONE_SPKI);
    expect(spkiFingerprint(certOf(CERT_TWO_DER, 'b'))).toBe(CERT_TWO_SPKI);
  });

  /** It is the key, not the certificate — so reissuing with the same key keeps the pin valid. */
  it('is 32 bytes of base64, not a certificate digest', () => {
    const fp = spkiFingerprint(certOf(CERT_ONE_DER, 'a'));
    expect(Buffer.from(fp, 'base64')).toHaveLength(32);
    expect(fp).not.toContain(':');
  });
});

// ===========================================================================
/**
 * THE CHECK THAT DECIDES WHETHER AN IMPOSTOR IS ACCEPTED.
 *
 * These tests exist because of a mutation run: replacing the pin comparison with one that
 * accepts every key left tsc, fourteen guardrails and 1,120 tests entirely green. The checks
 * were only reachable through `connectVerified`, which needs a server, so the most important
 * decision in the module was the one nothing could exercise — and its failure mode is silence.
 */
describe('5. the certificate checks refuse what they are supposed to refuse', () => {
  const pinnedTo = (...pins: string[]) =>
    ({ mode: 'PINNED', spkiSha256: pins, expectedCn: CN }) as const;

  it('accepts the certificate it was pinned to', () => {
    expect(() =>
      verifyCertificate(certOf(CERT_ONE_DER, CN), pinnedTo(CERT_ONE_SPKI))
    ).not.toThrow();
  });

  /** The whole point. A different key is a different server, whatever it says its name is. */
  it('refuses a certificate whose key is not pinned', () => {
    expect(() => verifyCertificate(certOf(CERT_TWO_DER, CN), pinnedTo(CERT_ONE_SPKI))).toThrow(
      /not one of the 1 pinned key/
    );
  });

  it('accepts a key that is any one of several pins, for a rotation', () => {
    expect(() =>
      verifyCertificate(certOf(CERT_TWO_DER, CN), pinnedTo(CERT_ONE_SPKI, CERT_TWO_SPKI))
    ).not.toThrow();
  });

  /**
   * An empty pin list must refuse everything rather than have nothing to disagree with. The
   * loop shape that reads "no pin said no" is the one that accepts every server.
   */
  it('an empty pin list accepts nothing', () => {
    expect(() => verifyCertificate(certOf(CERT_ONE_DER, CN), pinnedTo())).toThrow(
      /not one of the 0 pinned key/
    );
  });

  /**
   * A certificate can be pinned, valid, and belong to another database — on Cloud SQL every
   * instance in the project is a plausible impostor with a genuine certificate.
   */
  it('refuses the right key under the wrong instance name', () => {
    expect(() => verifyCertificate(certOf(CERT_ONE_DER, 'someone-else:their-db'), pinnedTo(CERT_ONE_SPKI))).toThrow(
      /CN is/
    );
  });

  it('checks the CN in CA mode too, where OpenSSL cannot because the host is an IP', () => {
    const plan = { mode: 'CA_VERIFIED', ca: SOME_CA, expectedCn: CN } as const;
    expect(() => verifyCertificate(certOf(CERT_ONE_DER, CN), plan)).not.toThrow();
    expect(() => verifyCertificate(certOf(CERT_ONE_DER, 'other:db'), plan)).toThrow(/CN is/);
  });

  /**
   * `getPeerCertificate` returns `{}` rather than throwing when there is nothing to return.
   * An empty object has no CN, so a check reading `cert.subject?.CN` against an expected value
   * would refuse it anyway — but only by accident, and only while an expected CN is required.
   */
  it('refuses when no certificate was presented at all', () => {
    expect(() =>
      verifyCertificate({} as unknown as PeerCertificate, pinnedTo(CERT_ONE_SPKI))
    ).toThrow(/presented no certificate/);
  });

  it('every refusal is a DatabaseTlsError, so a caller can tell it from a network fault', () => {
    for (const attempt of [
      () => verifyCertificate(certOf(CERT_TWO_DER, CN), pinnedTo(CERT_ONE_SPKI)),
      () => verifyCertificate(certOf(CERT_ONE_DER, 'x'), pinnedTo(CERT_ONE_SPKI)),
      () => verifyCertificate({} as unknown as PeerCertificate, pinnedTo(CERT_ONE_SPKI)),
    ]) {
      expect(attempt).toThrow(DatabaseTlsError);
    }
  });
});

// ===========================================================================
describe('4. a tool that cannot be given a verified socket gets no shortcut', () => {
  /**
   * `drizzle-kit` takes only an `ssl` option, so it cannot use the verified stream. In pinned
   * mode there is nothing OpenSSL can check, and the honest result is a connection that fails —
   * not one that succeeds unverified. `generate` and `check` never connect and are unaffected;
   * migrations are applied by `scripts/db-apply.ts`, which can verify.
   */
  it('never returns rejectUnauthorized false', () => {
    for (const env of [
      { DATABASE_TLS_EXPECTED_CN: CN, DATABASE_TLS_SPKI_SHA256: CERT_ONE_SPKI },
      { DATABASE_TLS_EXPECTED_CN: CN, DATABASE_CA_CERT: SOME_CA },
    ]) {
      expect(tlsOptionsForExternalTool(env as NodeJS.ProcessEnv).rejectUnauthorized).toBe(true);
    }
  });

  it('passes no CA in pinned mode, so the connection fails rather than succeeds unchecked', () => {
    const opts = tlsOptionsForExternalTool({
      DATABASE_TLS_EXPECTED_CN: CN,
      DATABASE_TLS_SPKI_SHA256: CERT_ONE_SPKI,
    } as NodeJS.ProcessEnv);
    expect(opts.ca).toBeUndefined();
  });

  it('checks the CN when it does have a CA', () => {
    const opts = tlsOptionsForExternalTool({
      DATABASE_TLS_EXPECTED_CN: CN,
      DATABASE_CA_CERT: SOME_CA,
    } as NodeJS.ProcessEnv);
    // Trimmed on the way in, so a CA pasted into an env file with trailing whitespace still
    // parses. Compared trimmed rather than loosened to a substring match.
    expect(opts.ca).toBe(SOME_CA.trim());
    expect(opts.checkServerIdentity?.('ignored', certOf(CERT_ONE_DER, CN))).toBeUndefined();
    expect(opts.checkServerIdentity?.('ignored', certOf(CERT_ONE_DER, 'other:db'))).toBeInstanceOf(
      Error
    );
  });

  it('refuses to hand out options at all when nothing is configured', () => {
    expect(() => tlsOptionsForExternalTool({} as NodeJS.ProcessEnv)).toThrow(DatabaseTlsError);
  });
});
