/**
 * Print the TLS pin for the configured database, and say plainly what taking it does and does
 * not establish.
 *
 *   npx tsx scripts/db-tls-pin.ts
 *
 * READ-ONLY, and it speaks no Postgres: `inspectServerCertificate` opens the connection, asks
 * for TLS, reads the certificate and hangs up before any authentication. No password is sent.
 *
 * WHY THIS IS NOT AUTOMATIC
 * -------------------------
 * It would be easy to have the application take its own pin on first connect and store it. That
 * would make a first-connection interception permanent and invisible, and it would mean the pin
 * was never a decision anyone made. Printing it and requiring someone to paste it into the
 * environment keeps the trust-on-first-use to a moment a person chose.
 *
 * The right fix is not to pin at all: put the Cloud SQL server CA in `DATABASE_CA_CERT_FILE`
 * (console -> instance -> Connections -> Security) and the certificate is verified rather than
 * recognised. Compare the fingerprint below against the one the console shows before trusting
 * it, and the trust-on-first-use gap closes too.
 */
import { inspectServerCertificate, spkiFingerprint } from '../server/db/tls';
import 'dotenv/config';

const raw = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!raw) {
  console.error('REFUSING: neither MIGRATION_DATABASE_URL nor DATABASE_URL is set.');
  process.exit(2);
}

const url = new URL(raw);
const host = url.hostname;
const port = Number(url.port || 5432);

inspectServerCertificate(host, port)
  .then((cert) => {
    console.log(`server        : ${host}:${port}`);
    console.log(`subject CN    : ${cert.subject?.CN}`);
    console.log(`issuer        : ${cert.issuer?.CN ?? '(none)'}`);
    console.log(`valid         : ${cert.valid_from} -> ${cert.valid_to}`);
    console.log(`cert SHA-256  : ${cert.fingerprint256}`);
    console.log('');
    console.log('Put these in .env, having first checked the fingerprint above against the one');
    console.log('the Cloud SQL console shows for this instance:');
    console.log('');
    console.log(`DATABASE_TLS_EXPECTED_CN=${cert.subject?.CN}`);
    console.log(`DATABASE_TLS_SPKI_SHA256=${spkiFingerprint(cert)}`);
    console.log('');
    console.log('Pinning detects an interception that begins after this moment. It cannot');
    console.log('detect one already in place right now. DATABASE_CA_CERT_FILE can.');
  })
  .catch((e: Error) => {
    console.error('FAILED: ' + e.message);
    process.exit(1);
  });
