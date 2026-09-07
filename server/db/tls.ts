/**
 * The one place that decides whether a Postgres connection is trusted.
 *
 * WHAT WAS THERE BEFORE
 * ---------------------
 * `ssl: { rejectUnauthorized: false }`, at seven call sites. That accepts any certificate from
 * anyone who can answer on the address, on every connection, forever. It mattered less while
 * `DATABASE_URL` was unset and nothing connected. There is now a real server on the other end,
 * reached over a public IP, and the connection carries the database password and — through
 * `oauth_connections` — customers' plaintext Gmail access and refresh tokens.
 *
 * WHY THIS IS NOT SIMPLY `rejectUnauthorized: true`
 * -------------------------------------------------
 * Measured against the live instance rather than assumed:
 *
 *   leaf CN     : linen-office-320801:growth-ai-abedin-747
 *   leaf SAN    : DNS:1-abf0d1e5-...-.us-central1.sql.goog
 *   issuer      : CN=Cloud SQL Server CA, dnQualifier=ff16e207-...
 *   system trust: UNABLE_TO_VERIFY_LEAF_SIGNATURE
 *
 * Cloud SQL signs the server certificate with a per-instance CA that is not chained to any
 * public root, and the server does not send that CA in the handshake — the presented chain is
 * one certificate deep. So there is nothing to verify against unless the CA is supplied out of
 * band, and `rejectUnauthorized: true` alone fails every connection.
 *
 * Putting the leaf itself in `ca` does not work either. Four configurations were tried against
 * the live server and all four were refused with `unable to verify the first certificate`:
 * OpenSSL requires a chain ending at a self-signed root and node does not expose the partial
 * chain flag. That is a measurement, not a supposition.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * Two verified modes and no third option:
 *
 *   CA_VERIFIED  a CA is configured. Ordinary TLS verification, plus an identity check on the
 *                certificate's CN, because the host is an IP address and the certificate's only
 *                SAN is a DNS name — the default identity check cannot succeed here.
 *
 *   PINNED       no CA is configured, but the public key hash of the expected certificate is.
 *                OpenSSL cannot verify, so this module verifies: it compares the SHA-256 of the
 *                server's SubjectPublicKeyInfo against the pin and destroys the socket on a
 *                mismatch. This is trust-on-first-use — the pin was taken by connecting once
 *                and recording what answered. It cannot detect an interception that was already
 *                in place at that moment. It does detect any later one, which
 *                `rejectUnauthorized: false` never did. It is a smaller claim than CA
 *                verification and is labelled as one wherever it appears.
 *
 * If neither is configured this THROWS. There is deliberately no mode that connects without
 * verifying: an unknown trust state must not resolve to permission (§14), and the failure this
 * replaces was exactly a system treating "cannot verify" as "carry on".
 *
 * WHY THE SOCKET IS BUILT HERE RATHER THAN HANDED TO `pg`
 * ------------------------------------------------------
 * A pin checked after `pool.connect()` resolves is checked too late: `pg` writes the startup
 * message, which carries the password, as soon as it has upgraded the socket, and node buffers
 * that write until the handshake completes and then flushes it. `checkServerIdentity` cannot
 * help — node skips it whenever OpenSSL verification has already failed, which in PINNED mode
 * it always has.
 *
 * So this module performs the TCP connect, the Postgres SSLRequest, the TLS upgrade and the pin
 * check itself, and only then hands `pg` a stream that is already verified, with `ssl` turned
 * off so `pg` does not try to negotiate again. Nothing of ours is written to the socket until
 * the certificate has been checked. This is the same shape `@google-cloud/cloud-sql-connector`
 * uses, for the same reason.
 */
import { Duplex } from 'stream';
import { connect as netConnect, type Socket } from 'net';
import { connect as tlsConnect, type TLSSocket, type PeerCertificate } from 'tls';
import { createHash, X509Certificate } from 'crypto';
import { readFileSync } from 'fs';

/**
 * Postgres does not begin in TLS. The client sends this eight-byte SSLRequest and the server
 * replies with one byte: 'S' to proceed, 'N' to refuse. The body is the fixed protocol number
 * 80877103, which is why it is a constant and not a computation.
 */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const SSL_YES = 'S'.charCodeAt(0);

export type TlsPlan =
  | {
      readonly mode: 'CA_VERIFIED';
      readonly ca: string;
      readonly expectedCn: string;
    }
  | {
      readonly mode: 'PINNED';
      readonly spkiSha256: readonly string[];
      readonly expectedCn: string;
    };

export class DatabaseTlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseTlsError';
  }
}

/**
 * The SHA-256 of a certificate's SubjectPublicKeyInfo, base64.
 *
 * The public key rather than the whole certificate, so that the pin survives Cloud SQL
 * reissuing the certificate with the same key — a rotation should not take the application
 * down, and a new key is the thing worth noticing.
 */
export function spkiFingerprint(cert: PeerCertificate): string {
  // Through X509Certificate rather than `cert.pubkey`, which is only populated on some node
  // versions and is silently undefined on the others — a pin computed over `undefined` would
  // be a constant, and every server would match it.
  const spki = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

/**
 * Read the plan from the environment. Called once per connection attempt rather than cached, so
 * that a deployment which adds a CA does not need a restart to stop being pinned.
 *
 * @throws DatabaseTlsError when neither a CA nor a pin is configured. The alternative is a third
 *         mode that connects to anything, which is the defect being fixed.
 */
export function resolveTlsPlan(env: NodeJS.ProcessEnv = process.env): TlsPlan {
  const expectedCn = env.DATABASE_TLS_EXPECTED_CN?.trim();
  if (!expectedCn) {
    throw new DatabaseTlsError(
      'DATABASE_TLS_EXPECTED_CN is not set. It is the CN the server certificate must carry — ' +
        'for Cloud SQL, "<project>:<instance>". Without it the certificate can be verified as ' +
        'genuine while belonging to a different database.'
    );
  }

  const caInline = env.DATABASE_CA_CERT?.trim();
  const caFile = env.DATABASE_CA_CERT_FILE?.trim();
  if (caInline || caFile) {
    const ca = caInline ? caInline : readFileSync(caFile as string, 'utf8');
    if (!ca.includes('BEGIN CERTIFICATE')) {
      throw new DatabaseTlsError(
        `the configured CA does not contain a PEM certificate (${caInline ? 'DATABASE_CA_CERT' : caFile})`
      );
    }
    return { mode: 'CA_VERIFIED', ca, expectedCn };
  }

  const pins = (env.DATABASE_TLS_SPKI_SHA256 ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (pins.length > 0) return { mode: 'PINNED', spkiSha256: pins, expectedCn };

  throw new DatabaseTlsError(
    'no way to verify the database server. Set DATABASE_CA_CERT_FILE to the Cloud SQL server ' +
      'CA (Cloud SQL console -> Connections -> Security), or DATABASE_TLS_SPKI_SHA256 to the ' +
      "server key's SHA-256 pin. This connection is NOT made unverified: the password and the " +
      'stored OAuth tokens travel over it.'
  );
}

/** What the plan permits, in one line, for a log that someone has to be able to act on. */
export function describePlan(plan: TlsPlan): string {
  return plan.mode === 'CA_VERIFIED'
    ? `TLS verified against a configured CA, CN must be ${plan.expectedCn}`
    : `TLS pinned to ${plan.spkiSha256.length} key hash(es), CN must be ${plan.expectedCn} ` +
        '(trust-on-first-use: supply DATABASE_CA_CERT_FILE to verify properly)';
}

function checkCn(cert: PeerCertificate, expectedCn: string): void {
  const cn = cert.subject?.CN;
  if (cn !== expectedCn) {
    throw new DatabaseTlsError(
      `server certificate CN is ${JSON.stringify(cn)}, expected ${JSON.stringify(expectedCn)}`
    );
  }
}

function checkPin(cert: PeerCertificate, plan: Extract<TlsPlan, { mode: 'PINNED' }>): void {
  const got = spkiFingerprint(cert);
  if (!plan.spkiSha256.includes(got)) {
    throw new DatabaseTlsError(
      `server public key ${got} is not one of the ${plan.spkiSha256.length} pinned key(s). ` +
        'Either the certificate was rotated with a new key — in which case update ' +
        'DATABASE_TLS_SPKI_SHA256 — or this is not the server it claims to be.'
    );
  }
}

/**
 * Everything the plan requires of a certificate, in one place a test can call.
 *
 * Exported because it was not, and that mattered: mutating the pin comparison to accept every
 * key left the whole gate green. The checks were only reachable through `connectVerified`,
 * which needs a server, so the most important decision in this module was the one nothing
 * exercised — a control whose failure mode is silently accepting an impostor, with no test able
 * to tell whether it worked.
 *
 * @throws DatabaseTlsError naming which check failed and what to do about it.
 */
export function verifyCertificate(cert: PeerCertificate, plan: TlsPlan): void {
  if (!cert || Object.keys(cert).length === 0) {
    throw new DatabaseTlsError('the server presented no certificate');
  }
  checkCn(cert, plan.expectedCn);
  if (plan.mode === 'PINNED') checkPin(cert, plan);
}

/**
 * TCP connect, SSLRequest, TLS upgrade, verify. Resolves only with a socket that has passed
 * every check the plan requires; on any failure the socket is destroyed before it resolves.
 */
export function connectVerified(
  host: string,
  port: number,
  plan: TlsPlan,
  timeoutMs = 20000
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    /**
     * On failure, destroy exactly one socket.
     *
     * Destroying both the TLSSocket and the raw socket it wraps segfaults node — measured, on
     * 24.18, while proving that a wrong pin is refused: the first rejection took the process
     * down with SIGSEGV instead of throwing. A verification failure that crashes the process is
     * worse than one that returns an error, and it would have happened on exactly the path this
     * module exists to make safe. The TLSSocket owns the raw socket once it wraps it, so
     * destroying the outer one is enough and destroying the inner one as well is a double free.
     */
    let secure: TLSSocket | null = null;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err === null) {
        resolve(secure as TLSSocket);
        return;
      }
      // Whichever socket is outermost, and only that one.
      if (secure !== null) secure.destroy();
      else raw.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => finish(new DatabaseTlsError(`TLS handshake with ${host}:${port} timed out`)),
      timeoutMs
    );

    const raw: Socket = netConnect(port, host, () => raw.write(SSL_REQUEST));
    raw.on('error', (e) => finish(e));

    raw.once('data', (answer: Buffer) => {
      if (answer[0] !== SSL_YES) {
        finish(
          new DatabaseTlsError(
            `${host}:${port} refused TLS (answered ${JSON.stringify(String.fromCharCode(answer[0]))}). ` +
              'An unencrypted connection is not made as a fallback.'
          )
        );
        return;
      }

      secure = tlsConnect(
        {
          socket: raw,
          // In CA_VERIFIED mode OpenSSL does the verifying. In PINNED mode it cannot — there is
          // no CA to give it — so the check below does, before anything is written.
          ...(plan.mode === 'CA_VERIFIED'
            ? {
                ca: plan.ca,
                rejectUnauthorized: true,
                // The host is an IP and the certificate's only SAN is a DNS name, so the
                // default identity check cannot pass. The CN is checked instead, and it names
                // the instance rather than the address.
                checkServerIdentity: (_h: string, cert: PeerCertificate) => {
                  try {
                    checkCn(cert, plan.expectedCn);
                    return undefined;
                  } catch (e) {
                    return e as Error;
                  }
                },
              }
            : { rejectUnauthorized: false }),
        },
        function onSecure(this: TLSSocket) {
          try {
            verifyCertificate(this.getPeerCertificate(false), plan);
            finish(null);
          } catch (e) {
            finish(e as Error);
          }
        }
      );
      secure.on('error', (e) => finish(e));
    });
  });
}

/**
 * Open TLS, read the certificate, send nothing, hang up.
 *
 * This is how a pin is taken in the first place, and it necessarily looks at a certificate that
 * by definition nothing can yet verify — so it is the second and last place in this repository
 * where OpenSSL verification is off. It lives here, beside the code that refuses, rather than in
 * the script that prints the pin, so that every such line is in one file a reviewer reads whole.
 *
 * It speaks no Postgres beyond the SSLRequest byte. No startup message, no user name, no
 * password. The socket is destroyed as soon as the certificate has been read.
 */
export function inspectServerCertificate(
  host: string,
  port: number,
  timeoutMs = 20000
): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let secure: TLSSocket | null = null;
    const finish = (err: Error | null, cert?: PeerCertificate) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (secure !== null) secure.destroy();
      else raw.destroy();
      if (err) reject(err);
      else resolve(cert as PeerCertificate);
    };

    const timer = setTimeout(
      () => finish(new DatabaseTlsError(`no answer from ${host}:${port}`)),
      timeoutMs
    );

    const raw: Socket = netConnect(port, host, () => raw.write(SSL_REQUEST));
    raw.on('error', (e) => finish(e));
    raw.once('data', (answer: Buffer) => {
      if (answer[0] !== SSL_YES) {
        finish(new DatabaseTlsError(`${host}:${port} will not do TLS`));
        return;
      }
      secure = tlsConnect({ socket: raw, rejectUnauthorized: false }, function (this: TLSSocket) {
        finish(null, this.getPeerCertificate(false));
      });
      secure.on('error', (e) => finish(e));
    });
  });
}

/**
 * A stream `pg` can drive, whose bytes only ever reach a verified socket.
 *
 * `pg` builds its own `net.Socket` and calls `.connect(port, host)` on it, so it cannot be
 * handed one that is already open. This stands in for that socket: `connect` runs the verified
 * handshake above and emits `connect` only once it has passed, and every write is buffered by
 * the Duplex until then. Pair it with `ssl: false` so `pg` does not try to negotiate TLS a
 * second time over a connection that already has it.
 */
class VerifiedPgSocket extends Duplex {
  private inner: TLSSocket | null = null;
  private noDelay = false;
  private keepAlive: { enable: boolean; delay: number } | null = null;

  constructor(
    private readonly plan: TlsPlan,
    private readonly timeoutMs: number
  ) {
    super();
  }

  // `pg` calls these before connect, when there is nothing to call them on yet.
  setNoDelay(enable = true): this {
    this.noDelay = enable;
    this.inner?.setNoDelay(enable);
    return this;
  }

  setKeepAlive(enable = false, delay = 0): this {
    this.keepAlive = { enable, delay };
    this.inner?.setKeepAlive(enable, delay);
    return this;
  }

  ref(): this {
    this.inner?.ref();
    return this;
  }

  unref(): this {
    this.inner?.unref();
    return this;
  }

  connect(port: number, host: string): this {
    connectVerified(host, port, this.plan, this.timeoutMs)
      .then((sock) => {
        this.inner = sock;
        sock.setNoDelay(this.noDelay);
        if (this.keepAlive) sock.setKeepAlive(this.keepAlive.enable, this.keepAlive.delay);
        sock.on('data', (chunk: Buffer) => {
          if (!this.push(chunk)) sock.pause();
        });
        sock.on('end', () => this.push(null));
        sock.on('error', (e) => this.destroy(e));
        sock.on('close', () => this.emit('close'));
        this.emit('connect');
      })
      .catch((e: Error) => {
        // Emitted rather than thrown: `pg` is listening for 'error' on this stream, and a
        // rejection here would otherwise surface as an unhandled rejection with no connection
        // to the pool that asked for it.
        this.destroy(e);
      });
    return this;
  }

  _read(): void {
    this.inner?.resume();
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (e?: Error | null) => void): void {
    if (!this.inner) {
      callback(new DatabaseTlsError('write before the verified connection was established'));
      return;
    }
    this.inner.write(chunk, callback);
  }

  _final(callback: (e?: Error | null) => void): void {
    this.inner?.end();
    callback();
  }

  _destroy(err: Error | null, callback: (e?: Error | null) => void): void {
    this.inner?.destroy();
    callback(err);
  }
}

/**
 * Connection options for `pg` — `Pool`, `Client`, and anything built on them.
 *
 * `ssl` is false on purpose: the stream this returns is already TLS, and already verified.
 *
 * @throws DatabaseTlsError if nothing is configured to verify against. Callers do not get an
 *         unverified connection by ignoring an error.
 */
export function verifiedPgOptions(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 20000
): { connectionString: string; ssl: false; stream: () => Duplex } {
  const plan = resolveTlsPlan(env);
  return {
    connectionString,
    ssl: false,
    stream: () => new VerifiedPgSocket(plan, timeoutMs),
  };
}

/**
 * TLS options for a caller that builds its own client and cannot take a stream — `drizzle-kit`,
 * whose config accepts only `ssl`.
 *
 * In PINNED mode there is nothing OpenSSL can check, so this returns plain
 * `rejectUnauthorized: true` and the connection fails. That is the intended outcome: a tool that
 * cannot be given a verified socket does not get an unverified one. `drizzle-kit generate` and
 * `check` do not connect at all and are unaffected; `push` and `studio` will refuse until a CA
 * is configured, and neither is how this project applies migrations.
 */
export function tlsOptionsForExternalTool(env: NodeJS.ProcessEnv = process.env): {
  rejectUnauthorized: true;
  ca?: string;
  checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined;
} {
  const plan = resolveTlsPlan(env);
  if (plan.mode === 'PINNED') return { rejectUnauthorized: true };
  return {
    rejectUnauthorized: true,
    ca: plan.ca,
    checkServerIdentity: (_h, cert) => {
      try {
        checkCn(cert, plan.expectedCn);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    },
  };
}
