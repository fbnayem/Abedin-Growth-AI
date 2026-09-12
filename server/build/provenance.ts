/**
 * S49 — which build is this?
 *
 * WHAT WAS THERE
 * --------------
 * Nothing. `package.json` says `"name": "react-example", "version": "0.0.0"`, there are no git
 * tags, no commit SHA is embedded anywhere, and `/api/health` answered:
 *
 *     { "status": "ok", "service": "Abedin Growth AI Core Engine" }
 *
 * S49's worst case turns on that. An operator watching the agent send something it should not
 * reaches for the kill switch, and nobody can say which build is running or what to roll back
 * to. The service name is not an answer to that question; it is the same string in every build
 * that has ever run.
 *
 * WHAT THIS REPORTS, AND WHAT IT REFUSES TO
 * -----------------------------------------
 * The identity is `UNKNOWN` unless something actually established it. There is deliberately no
 * fallback that produces a plausible-looking value: a SHA that is wrong is worse than one that
 * is missing, because the missing one sends someone to look while the wrong one ends the
 * search. This repository has already shipped a readiness script that CREATED the document it
 * was checking for and then reported it as present — the same move, one level down.
 *
 *   INJECTED           `BUILD_SHA` was set at build or deploy time. This is the only source
 *                      that identifies a released artifact.
 *   GIT_WORKING_TREE   read from `.git` in the working directory. Development only, and
 *                      labelled, because a working tree can carry uncommitted changes: the SHA
 *                      names a commit that is not necessarily what is running.
 *   UNKNOWN            neither. Said plainly.
 *
 * The distinction is the point. A caller that treats all three the same has learned nothing
 * from any of them.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export type ProvenanceSource = 'INJECTED' | 'GIT_WORKING_TREE' | 'UNKNOWN';

export interface Provenance {
  /** The commit this build was made from, or null when nothing established it. */
  readonly sha: string | null;
  /** Where `sha` came from. A caller must not treat these as interchangeable. */
  readonly source: ProvenanceSource;
  /** Injected at build time; null when not set. Never defaulted to a version-looking string. */
  readonly version: string | null;
  /** ISO-8601, injected at build time; null when not set. */
  readonly builtAt: string | null;
  /**
   * The last migration this build expects to be applied — read from the journal that ships with
   * it. Compare against the database to tell "the code is ahead of the schema" from "the schema
   * is ahead of the code", which are different incidents with different rollbacks.
   */
  readonly expectsMigration: string | null;
  /** True only for INJECTED. The one question an incident actually asks. */
  readonly identifiesAReleasedArtifact: boolean;
}

const SHORT = 12;

/**
 * Read HEAD out of a git directory without shelling out.
 *
 * `.git/HEAD` is either a raw SHA (detached) or `ref: refs/heads/<branch>`, in which case the
 * SHA is in `.git/<ref>` or, when the ref has been packed, in `.git/packed-refs`.
 */
function shaFromGit(root: string): string | null {
  try {
    const gitDir = join(root, '.git');
    if (!existsSync(gitDir)) return null;

    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head;

    const match = head.match(/^ref:\s*(.+)$/);
    if (!match) return null;
    const ref = match[1].trim();

    const looseRef = join(gitDir, ref);
    if (existsSync(looseRef)) {
      const sha = readFileSync(looseRef, 'utf8').trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    }

    const packed = join(gitDir, 'packed-refs');
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return sha;
    }
    return null;
  } catch {
    // A git directory that cannot be read is not an error worth failing a health check over.
    // It is one more reason the answer is UNKNOWN, which is what will be reported.
    return null;
  }
}

/** The last entry in the migration journal that ships with this build. */
function expectedMigration(root: string): string | null {
  try {
    const journal = JSON.parse(
      readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] };
    if (!Array.isArray(journal.entries) || journal.entries.length === 0) return null;
    return [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1)?.tag ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve build identity.
 *
 * @param env  the environment to read. A parameter so the resolution can be tested for every
 *             combination, including the ones a test machine cannot otherwise produce.
 * @param root where to look for `.git` and the migration journal.
 */
export function resolveProvenance(
  env: NodeJS.ProcessEnv = process.env,
  root: string = process.cwd()
): Provenance {
  const injected = env.BUILD_SHA?.trim();
  const version = env.BUILD_VERSION?.trim() || null;
  const builtAt = env.BUILD_TIME?.trim() || null;
  const expectsMigration = expectedMigration(root);

  if (injected) {
    return {
      sha: injected,
      source: 'INJECTED',
      version,
      builtAt,
      expectsMigration,
      identifiesAReleasedArtifact: true,
    };
  }

  const fromGit = shaFromGit(root);
  if (fromGit) {
    return {
      sha: fromGit,
      source: 'GIT_WORKING_TREE',
      version,
      builtAt,
      expectsMigration,
      // False on purpose. The commit is real and the running code may differ from it by every
      // uncommitted change in the tree.
      identifiesAReleasedArtifact: false,
    };
  }

  return {
    sha: null,
    source: 'UNKNOWN',
    version,
    builtAt,
    expectsMigration,
    identifiesAReleasedArtifact: false,
  };
}

/** One line for a log or a health response. Short SHA, and always the source alongside it. */
export function describeProvenance(p: Provenance): string {
  const sha = p.sha ? p.sha.slice(0, SHORT) : 'unknown';
  const version = p.version ? ` ${p.version}` : '';
  const migration = p.expectsMigration ? `, expects ${p.expectsMigration}` : '';
  return `build${version} ${sha} (${p.source}${migration})`;
}
