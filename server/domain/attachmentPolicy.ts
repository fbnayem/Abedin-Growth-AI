import type { AttachmentRecord } from '../lib/mime';

/**
 * S17 — ATTACHMENTS: WHAT THIS SYSTEM LOOKS AT, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * WHERE THIS STARTED
 * ------------------
 * The MIME walk used to drop attachment parts so completely that nothing downstream could know
 * one had existed. §1t fixed that: `ParsedBody.attachments` now records filename, declared MIME
 * type, size and the provider's attachment id. But recording is not deciding, and the status
 * document's remainder for S17 was "allowlist, content sniffing, storage, retention".
 *
 * THREE OF THOSE FOUR ARE ANSWERED BY NOT DOWNLOADING THE BYTES
 * -------------------------------------------------------------
 * This system never calls Gmail's `messages.attachments.get`, never writes attachment content
 * anywhere, and never hands it to a model. Verified rather than assumed: `attachmentId` has two
 * occurrences in the repository, both in `mime.ts`, and neither is a fetch.
 *
 * So there is nothing to sniff, nothing stored, and no retention period to set — and that is
 * the safest posture available, not a gap. Content sniffing requires downloading the file
 * first, which means this application would hold prospect-supplied binaries; a scanner is then
 * needed to make that safe, and a scanner is a much larger commitment than the risk it removes
 * here. `scripts/check-no-attachment-download.mjs` turns the absence into a control, the same
 * way S35's HTML-sink guardrail did: "nothing broke yet" is not a control, and one line added
 * by someone who wanted attachment preview would change the posture silently.
 *
 * WHAT IS LEFT IS THE ALLOWLIST, AND IT DECIDES ROUTING, NOT DELIVERY
 * -------------------------------------------------------------------
 * From metadata alone — filename and declared type — several things are visible that should
 * stop a message being ANSWERED AUTONOMOUSLY. An executable attached to an inbound sales email
 * is not a document a reply should be composed about; it is a phishing attempt, or a person who
 * needs a human.
 *
 * The verdict routes the draft to human review. It never drops the message: the message is
 * evidence and is stored either way, exactly as a bounce is (§28).
 *
 * A FILENAME IS ATTACKER-CHOSEN TEXT (§18)
 * ----------------------------------------
 * It is not a path, it is not a type, and it is not safe to print. `displayName` strips control
 * characters and bidirectional overrides before the name reaches a log line or an operator's
 * screen — a filename containing U+202E renders right-to-left from that point, so `fdp.exe`
 * displays as `exe.pdf` and reads as a PDF to a person who is looking straight at it.
 */

/** A message whose attachments should not be answered without a person looking. */
export const ATTACHMENT_DISPOSITIONS = ['CLEAR', 'HUMAN_REVIEW'] as const;
export type AttachmentDisposition = (typeof ATTACHMENT_DISPOSITIONS)[number];

export interface AttachmentFinding {
  readonly code:
    | 'EXECUTABLE'
    | 'MACRO_ENABLED'
    | 'TYPE_MISMATCH'
    | 'BIDI_OVERRIDE'
    | 'PATH_IN_NAME'
    | 'CONTROL_CHARACTERS'
    | 'UNEXAMINED';
  readonly detail: string;
}

export interface AttachmentVerdict {
  readonly disposition: AttachmentDisposition;
  readonly findings: readonly AttachmentFinding[];
  /** One line, safe to log and to show an operator. */
  readonly reason: string | null;
}

/**
 * Extensions that execute, or that a mail client will hand to something that does.
 *
 * Not exhaustive and cannot be — which is why this routes to review rather than deciding
 * delivery. A list that has to be complete to be safe is the wrong shape for a control.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'scr', 'com', 'bat', 'cmd', 'pif', 'cpl', 'msi', 'msp', 'msc', 'hta', 'jar',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ws', 'ps1', 'ps1xml', 'psc1', 'psm1',
  'lnk', 'reg', 'scf', 'inf', 'dll', 'sys', 'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm',
  'sh', 'bash', 'csh', 'zsh', 'py', 'rb', 'pl', 'php', 'jsp', 'asp', 'aspx', 'cgi',
  'iso', 'img', 'vhd', 'vhdx',
]);

/** Office formats that carry macros. The macro is the payload; the document is the wrapper. */
export const MACRO_EXTENSIONS = new Set([
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
]);

/**
 * The declared type each common extension should carry.
 *
 * Used only to spot a DISAGREEMENT. A filename saying `.pdf` beside
 * `application/x-msdownload` is one of the two lying, and neither answer is one to act on
 * without a person. An extension absent from this map produces no finding: the map is for
 * catching contradictions, not for deciding what is allowed.
 */
export const EXPECTED_TYPES: Readonly<Record<string, readonly string[]>> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  svg: ['image/svg+xml'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv', 'text/plain'],
  ics: ['text/calendar'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  zip: ['application/zip', 'application/x-zip-compressed'],
};

/**
 * Unicode characters that change the direction text is rendered in.
 *
 * U+202E RIGHT-TO-LEFT OVERRIDE is the one that matters. A name written as
 * `invoice<U+202E>fdp.exe` renders to a person as `invoiceexe.pdf`, so an executable
 * reads as a document to someone looking straight at it. The character is written here
 * as its code point rather than literally, because putting it in this comment would
 * reverse the rest of this sentence in every editor that renders the file.
 * The rest of the range is here because those characters do the same job, and a control
 * that catches only the famous one is a control an attacker reads about.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/** C0 and C1 control characters, and anything that ends a log line. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * A filename rendered safe to print.
 *
 * Control characters and direction overrides become `?`, so a name cannot forge a second log
 * line or read as a different extension than it has. Truncated, because a filename is
 * attacker-chosen and a 4KB one in a log line is a denial of readability.
 */
export function displayName(filename: string | null): string {
  if (filename === null || filename === '') return '(unnamed)';
  const cleaned = filename
    .replace(BIDI_CONTROLS, '?')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '?');
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

/**
 * The effective extension, as the operating system will see it.
 *
 * TRAILING DOTS AND SPACES ARE STRIPPED FIRST. Windows silently removes them when opening a
 * file, so `payload.exe.` and `payload.exe ` both execute while a naive `split('.').pop()`
 * reads the extension as `exe.` and `exe ` — neither of which is in any list.
 *
 * Returns null when there is no extension at all, which is a different fact from an unknown
 * one and is not by itself suspicious.
 */
export function extensionOf(filename: string | null): string | null {
  if (filename === null) return null;
  const trimmed = filename.replace(/[\s.\u0000-\u0020]+$/g, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  return trimmed.slice(dot + 1).toLowerCase();
}

/** Every extension in the name, so `invoice.pdf.exe` is visible as both. */
export function allExtensionsOf(filename: string | null): string[] {
  if (filename === null) return [];
  const trimmed = filename.replace(/[\s.\u0000-\u0020]+$/g, '');
  return trimmed
    .split('.')
    .slice(1)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && part.length <= 12);
}

function findingsFor(record: AttachmentRecord): AttachmentFinding[] {
  const found: AttachmentFinding[] = [];
  const name = record.filename;
  const shown = displayName(name);

  if (name !== null && BIDI_CONTROLS.test(name)) {
    found.push({
      code: 'BIDI_OVERRIDE',
      detail:
        `${shown} contains a Unicode direction override. The name a person sees is not the ` +
        'name the file has, which is the whole purpose of that character in a filename.',
    });
  }

  if (name !== null && CONTROL_CHARACTERS.test(name)) {
    found.push({
      code: 'CONTROL_CHARACTERS',
      detail: `${shown} contains control characters, which no filename legitimately does.`,
    });
  }

  if (name !== null && (name.includes('/') || name.includes('\\') || name.includes('..'))) {
    found.push({
      code: 'PATH_IN_NAME',
      detail:
        `${shown} contains path separators or a parent reference. Nothing here writes ` +
        'attachments to disk, and a name shaped to escape a directory says what was intended.',
    });
  }

  // EVERY extension, not just the last. `invoice.pdf.exe` is the oldest trick there is, and it
  // works because the reader stops at the first one.
  const extensions = allExtensionsOf(name);
  const dangerous = extensions.filter((e) => EXECUTABLE_EXTENSIONS.has(e));
  if (dangerous.length > 0) {
    found.push({
      code: 'EXECUTABLE',
      detail:
        `${shown} carries the executable extension${dangerous.length > 1 ? 's' : ''} ` +
        `${dangerous.join(', ')}${extensions.length > 1 ? ` (full chain: ${extensions.join('.')})` : ''}.`,
    });
  }

  const macro = extensions.filter((e) => MACRO_EXTENSIONS.has(e));
  if (macro.length > 0) {
    found.push({
      code: 'MACRO_ENABLED',
      detail: `${shown} is a macro-enabled office document (${macro.join(', ')}).`,
    });
  }

  const last = extensionOf(name);
  const expected = last === null ? undefined : EXPECTED_TYPES[last];
  if (expected !== undefined) {
    const declared = record.mimeType.toLowerCase().split(';')[0].trim();
    if (declared !== '' && declared !== 'application/octet-stream' && !expected.includes(declared)) {
      found.push({
        code: 'TYPE_MISMATCH',
        detail:
          `${shown} is named .${last} but declares ${declared}. One of the two is wrong, and ` +
          'neither answer is one to act on without a person.',
      });
    }
  }

  return found;
}

/**
 * Whether a message's attachments allow it to be answered autonomously.
 *
 * `recordedCount` is `ParsedBody.attachmentCount` — how many attachments the walk SAW — while
 * `attachments` is how many it kept. The walk caps the array (`limits.maxAttachments`) and
 * keeps counting, so those two numbers can differ, and when they do there are attachments
 * nobody examined.
 *
 * That is `UNEXAMINED`, and it routes to review. §14: an attachment we did not look at is not
 * an attachment we found nothing wrong with.
 */
export function attachmentVerdict(
  attachments: readonly AttachmentRecord[],
  recordedCount: number
): AttachmentVerdict {
  const findings: AttachmentFinding[] = [];

  for (const record of attachments) findings.push(...findingsFor(record));

  if (recordedCount > attachments.length) {
    findings.push({
      code: 'UNEXAMINED',
      detail:
        `${recordedCount} attachments were present and only ${attachments.length} were ` +
        'recorded, so the rest were never examined. Not examined is not the same as clear.',
    });
  }

  if (findings.length === 0) {
    return { disposition: 'CLEAR', findings: [], reason: null };
  }

  return {
    disposition: 'HUMAN_REVIEW',
    findings,
    reason: `Attachment policy: ${findings.map((f) => `${f.code} — ${f.detail}`).join(' ')}`,
  };
}

/**
 * The gate, stated once.
 *
 * An equality against the one permitting disposition, not a list of forbidden ones, so a
 * disposition added later refuses by default. Same shape as `mayReplyTo` and `mayProceed`, and
 * for the same reason: the dispatch gate's original `default: return true`.
 */
export function attachmentsPermitAutonomy(disposition: AttachmentDisposition): boolean {
  return disposition === 'CLEAR';
}
