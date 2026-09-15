import { neutralizeCsvValue } from '../../shared/lib/csvSafety';
import { tryContactDocId } from '../lib/identity';
import { timeZoneRejection } from '../../shared/domain/time';
import { ADDRESS_TYPES, normaliseCountry } from './lawfulBasis';

/**
 * CSV / LIST IMPORT — THE PLANNER (§11, §14, §16, §18).
 *
 * WHAT THIS IS AND WHAT IT DELIBERATELY IS NOT
 * -------------------------------------------
 * This module turns a block of delimited text into a PLAN: the rows that would be created, the
 * rows that would be refused and why, and the columns that were ignored. It reads nothing and
 * writes nothing. The store, the lawful basis and the operator's identity are the service's
 * problem (`server/services/leadImport.service.ts`), which is what makes every rule below
 * testable without a datastore and without a fixture that could quietly disagree with one.
 *
 * A file is UNTRUSTED INPUT (§18). It arrives from a list broker, an export from somebody
 * else's CRM, or a spreadsheet a salesperson has been editing for two years. Three specific
 * things follow from that.
 *
 * 1. THE HEADER CANNOT NAME ITS OWN TARGET FIELD. A column called `consentGiven`, `suppressed`
 *    or `organizationId` maps to nothing, because the target set is the fixed allowlist in
 *    IMPORT_FIELDS and a header is matched against it rather than used as it. This is the same
 *    mass-assignment defence `createContactSchema` applies to a request body, at the second
 *    place bulk data reaches a contact record. An ignored column is REPORTED, never silently
 *    dropped: an operator whose `Email Address` column was not recognised needs to know that
 *    before they commit 900 rows with no addresses.
 *
 * 2. A CELL CANNOT BECOME A FORMULA. Every stored value is neutralised through the same
 *    `shared/lib/csvSafety` the exporter uses. Without this, `=HYPERLINK(...)` in a company
 *    name survives the round trip and executes on the next operator who opens an export — the
 *    import being the step that launders it into the system's own data.
 *
 * 3. UNKNOWN IS NOT PERMISSION, AT ROW LEVEL. A row whose country is missing produces a record
 *    that the basis gate refuses, not a record that inherits a permissive default. The preview
 *    says so per row, before anything is written, because "412 imported" and "412 contactable"
 *    are different numbers and conflating them is the fabricated-success shape this repository
 *    keeps removing.
 *
 * WHY THE BASIS ITSELF IS NOT A COLUMN
 * ------------------------------------
 * `country`, `addressType`, `consentEvidence`, `consentSource` and `article14NoticeSentAt` may
 * all come per row, because they are properties of the person and a real export carries them.
 * `lawfulBasis` may not. It is one deliberate decision the operator makes about the batch in
 * front of them, and a file that could nominate its own lawful basis is a file that could talk
 * its way into being mailable.
 */

/** Two megabytes of text. Bigger refuses; it is never truncated to fit. */
export const MAX_IMPORT_BYTES = 2_000_000;

/**
 * The most rows one import handles.
 *
 * The cap exists because the preview does one existence check per row, and an unbounded file
 * would be an unbounded number of reads held open by a single request. Refusing above it is
 * the same choice `MAX_REPARENT` makes in the merge: a refusal is repairable by splitting the
 * file, a half-finished import has to be found first.
 */
export const MAX_IMPORT_ROWS = 2_000;

/** Per-cell length, matching the short-string bound the create schema already enforces. */
export const MAX_IMPORT_FIELD = 500;

/** Longest single cell for the free-text note column. */
export const MAX_IMPORT_NOTES = 10_000;

/** The most columns a header may declare. A file wider than this is not a contact list. */
export const MAX_IMPORT_COLUMNS = 64;

/**
 * THE ALLOWLIST. A header maps to one of these or to nothing at all.
 *
 * Absent by design: `consentGiven`, `suppressed`, `unsubscribed`, `hardBounced`, `complained`,
 * `lawfulBasis`, `organizationId`, `id`, `type`, `status`, `version`, `aiScore`. The first five
 * are the suppression and consent state that outreach safety depends on; the rest are
 * server-controlled. None of them is something a spreadsheet gets to assert.
 */
export const IMPORT_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'name',
  'title',
  'phone',
  'linkedinUrl',
  'companyName',
  'companyWebsite',
  'industry',
  'country',
  'employeeCount',
  'timeZone',
  'notes',
  'addressType',
  'consentEvidence',
  'consentSource',
  'article14NoticeSentAt',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * Header spellings seen in the wild, normalised to lower case with every non-alphanumeric
 * character removed, so `Email Address`, `email_address` and `E-mail address` are one key.
 *
 * A header that is not here is ignored and reported. Guessing at an unrecognised header is how
 * a column called `Owner` would end up in `notes` on nine hundred records.
 */
const HEADER_ALIASES: Readonly<Record<string, ImportField>> = Object.freeze({
  email: 'email',
  emailaddress: 'email',
  workemail: 'email',
  businessemail: 'email',
  mail: 'email',
  firstname: 'firstName',
  givenname: 'firstName',
  forename: 'firstName',
  lastname: 'lastName',
  surname: 'lastName',
  familyname: 'lastName',
  name: 'name',
  fullname: 'name',
  contactname: 'name',
  title: 'title',
  jobtitle: 'title',
  position: 'title',
  role: 'title',
  phone: 'phone',
  telephone: 'phone',
  phonenumber: 'phone',
  mobile: 'phone',
  linkedin: 'linkedinUrl',
  linkedinurl: 'linkedinUrl',
  linkedinprofile: 'linkedinUrl',
  company: 'companyName',
  companyname: 'companyName',
  organisation: 'companyName',
  organization: 'companyName',
  account: 'companyName',
  website: 'companyWebsite',
  companywebsite: 'companyWebsite',
  domain: 'companyWebsite',
  url: 'companyWebsite',
  industry: 'industry',
  sector: 'industry',
  country: 'country',
  countrycode: 'country',
  employees: 'employeeCount',
  employeecount: 'employeeCount',
  companysize: 'employeeCount',
  headcount: 'employeeCount',
  timezone: 'timeZone',
  tz: 'timeZone',
  notes: 'notes',
  note: 'notes',
  comments: 'notes',
  addresstype: 'addressType',
  consentevidence: 'consentEvidence',
  consentsource: 'consentSource',
  article14noticesentat: 'article14NoticeSentAt',
  noticesentat: 'article14NoticeSentAt',
});

export type ParseRefusalCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_COLUMNS'
  | 'NO_HEADER'
  | 'NO_EMAIL_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'UNTERMINATED_QUOTE';

export type RowRefusalCode =
  | 'NO_EMAIL'
  | 'UNUSABLE_EMAIL'
  | 'DUPLICATE_IN_FILE'
  | 'FIELD_TOO_LONG'
  | 'RAGGED_ROW'
  | 'BAD_COUNTRY'
  | 'BAD_ADDRESS_TYPE'
  | 'BAD_TIME_ZONE'
  | 'BAD_NOTICE_TIMESTAMP';

export interface PlannedRow {
  /** 1-based line number in the source text, so a refusal can be found in the file. */
  readonly line: number;
  readonly email: string;
  /** The derived document id: the same derivation the create transaction will use. */
  readonly contactId: string;
  /** Neutralised, length-checked values for allowlisted fields only. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface RefusedRow {
  readonly line: number;
  readonly code: RowRefusalCode;
  readonly message: string;
  /** The address as written, where there was one. Useful for finding the row. */
  readonly email: string | null;
}

export interface ImportPlan {
  readonly ok: true;
  /** Which delimiter was detected, reported so a mis-detection is visible rather than silent. */
  readonly delimiter: ',' | ';' | '\t';
  readonly header: readonly string[];
  /** Header index to field, for the columns that were recognised. */
  readonly mapped: Readonly<Record<string, ImportField>>;
  /** Headers that matched nothing. Reported, never guessed at. */
  readonly ignored: readonly string[];
  readonly rows: readonly PlannedRow[];
  readonly refused: readonly RefusedRow[];
}

export type ImportPlanOutcome =
  | ImportPlan
  | { readonly ok: false; readonly code: ParseRefusalCode; readonly message: string };

/** `Email Address` and `email_address` are the same header. */
function headerKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Split delimited text into rows of cells.
 *
 * Written out rather than taken from a library because the failure modes matter: an
 * unterminated quote must be a refusal rather than a row that swallows the rest of the file,
 * and a stray CR must not become part of a value. RFC 4180 rules, plus the two concessions
 * every real file needs — a leading byte-order mark, and bare LF as well as CRLF.
 */
export function parseDelimited(
  text: string,
  delimiter: string
): { ok: true; rows: string[][]; lines: number[] } | { ok: false; line: number } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  const lines: number[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let started = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(cells);
    lines.push(rowLine);
    cells = [];
    started = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (!started) {
      rowLine = line;
      started = true;
    }

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\r') {
      // A lone CR ends the row too; CRLF is handled by skipping the LF that follows.
      if (source[i + 1] === '\n') i++;
      endRow();
      line++;
    } else if (ch === '\n') {
      endRow();
      line++;
    } else {
      cell += ch;
    }
  }

  if (quoted) return { ok: false, line: rowLine };
  if (started || cell !== '' || cells.length > 0) endRow();

  return { ok: true, rows, lines };
}

/**
 * Which delimiter this file uses.
 *
 * Decided from the HEADER LINE only, and by counting occurrences outside quotes. Counting over
 * the whole file would let one address containing a semicolon outvote the real delimiter, and
 * a file that is parsed with the wrong delimiter does not fail loudly — it produces one column
 * called `name;email;country` and refuses every row for want of an address.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best: ',' | ';' | '\t' = ',';
  let bestCount = -1;
  for (const candidate of [',', ';', '\t'] as const) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === candidate && !quoted) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function tooLong(field: string, value: string): boolean {
  return value.length > (field === 'notes' ? MAX_IMPORT_NOTES : MAX_IMPORT_FIELD);
}

/**
 * Turn a block of delimited text into a plan.
 *
 * Every refusal carries the line it happened on. An import report that says "37 rows refused"
 * without saying which ones is a report an operator cannot act on, and the row they most need
 * to see is the one whose address is subtly malformed.
 */
export function planImport(
  text: unknown,
  options: { delimiter?: ',' | ';' | '\t'; maxRows?: number } = {}
): ImportPlanOutcome {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, code: 'EMPTY', message: 'The file is empty.' };
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message:
        `The file is ${bytes} bytes, above the ${MAX_IMPORT_BYTES} this import accepts. ` +
        `Split it and import the parts; nothing has been truncated to fit.`,
    };
  }

  const delimiter = options.delimiter ?? detectDelimiter(text);
  const parsed = parseDelimited(text, delimiter);
  if (parsed.ok === false) {
    return {
      ok: false,
      code: 'UNTERMINATED_QUOTE',
      message:
        `A quoted value starting on line ${parsed.line} is never closed, so the rest of the ` +
        `file would be read as part of it. Fix the quote rather than letting one row absorb ` +
        `the others.`,
    };
  }

  if (parsed.rows.length === 0) {
    return { ok: false, code: 'NO_HEADER', message: 'The file has no header row.' };
  }

  const header = parsed.rows[0].map((h) => h.trim());
  if (header.length > MAX_IMPORT_COLUMNS) {
    return {
      ok: false,
      code: 'TOO_MANY_COLUMNS',
      message: `The header declares ${header.length} columns, above the ${MAX_IMPORT_COLUMNS} allowed.`,
    };
  }

  const maxRows = options.maxRows ?? MAX_IMPORT_ROWS;
  const dataRows = parsed.rows.slice(1);
  if (dataRows.length > maxRows) {
    return {
      ok: false,
      code: 'TOO_MANY_ROWS',
      message:
        `The file has ${dataRows.length} data rows, above the ${maxRows} this import accepts. ` +
        `Refusing rather than importing the first ${maxRows}: a silently truncated import ` +
        `looks exactly like a complete one.`,
    };
  }

  // Header to field. The header names a POSITION; the field it writes comes from the
  // allowlist, never from the header text itself.
  const mapped: Record<string, ImportField> = {};
  const columnField: (ImportField | null)[] = [];
  const ignored: string[] = [];
  const claimed = new Set<ImportField>();

  for (const raw of header) {
    const field = HEADER_ALIASES[headerKey(raw)] ?? null;
    if (field === null) {
      columnField.push(null);
      if (raw !== '') ignored.push(raw);
      continue;
    }
    if (claimed.has(field)) {
      return {
        ok: false,
        code: 'DUPLICATE_COLUMN',
        message:
          `Two columns both map to ${field} (the second is ${JSON.stringify(raw)}). Which one ` +
          `wins would be an accident of column order, so this refuses instead.`,
      };
    }
    claimed.add(field);
    columnField.push(field);
    mapped[raw] = field;
  }

  if (!claimed.has('email')) {
    return {
      ok: false,
      code: 'NO_EMAIL_COLUMN',
      message:
        `No column maps to an email address. The address is the identity key — without one ` +
        `there is no way to check suppression before sending — so an import without it would ` +
        `produce records that can never be used. Headers seen: ` +
        `${header.map((h) => JSON.stringify(h)).join(', ')}.`,
    };
  }

  const rows: PlannedRow[] = [];
  const refused: RefusedRow[] = [];
  const seen = new Map<string, number>();

  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r];
    const line = parsed.lines[r + 1];

    // A completely blank line is skipped rather than refused: trailing newlines are normal.
    if (cells.every((c) => c.trim() === '')) continue;

    if (cells.length > header.length) {
      refused.push({
        line,
        code: 'RAGGED_ROW',
        message:
          `The row has ${cells.length} values but the header declares ${header.length} columns. ` +
          `An unquoted comma inside a value is the usual cause, and reading the row anyway ` +
          `would shift every field after it by one.`,
        email: null,
      });
      continue;
    }

    const values: Record<string, string> = {};
    let rowRefusal: RefusedRow | null = null;

    for (let c = 0; c < cells.length; c++) {
      const field = columnField[c];
      if (field === null) continue;
      const raw = cells[c].trim();
      if (raw === '') continue;
      if (tooLong(field, raw)) {
        rowRefusal = {
          line,
          code: 'FIELD_TOO_LONG',
          message:
            `${field} is ${raw.length} characters, above the limit for that field. Refused ` +
            `rather than truncated: half a value stored as if it were whole is worse than none.`,
          email: null,
        };
        break;
      }
      // Neutralised on the way IN. A formula stored verbatim survives to the next export.
      values[field] = field === 'email' ? raw : neutralizeCsvValue(raw);
    }

    if (rowRefusal !== null) {
      refused.push({ ...rowRefusal, email: values.email ?? null });
      continue;
    }

    const email = values.email ?? '';
    if (email === '') {
      refused.push({
        line,
        code: 'NO_EMAIL',
        message: 'The row has no email address, which is the identity key for a contact.',
        email: null,
      });
      continue;
    }

    const contactId = tryContactDocId(email);
    if (contactId === null) {
      refused.push({
        line,
        code: 'UNUSABLE_EMAIL',
        message: `${JSON.stringify(email)} is not a usable email address.`,
        email,
      });
      continue;
    }

    const firstSeen = seen.get(contactId);
    if (firstSeen !== undefined) {
      refused.push({
        line,
        code: 'DUPLICATE_IN_FILE',
        message:
          `The same address already appears on line ${firstSeen}. The first occurrence is the ` +
          `one that would be created; a later row does not overwrite an earlier one.`,
        email,
      });
      continue;
    }

    if (values.country !== undefined && normaliseCountry(values.country) === null) {
      refused.push({
        line,
        code: 'BAD_COUNTRY',
        message:
          `country ${JSON.stringify(values.country)} is not an ISO-3166 alpha-2 code. Storing ` +
          `it would produce a record the outreach gate refuses for a reason nobody can read.`,
        email,
      });
      continue;
    }

    if (
      values.addressType !== undefined &&
      !(ADDRESS_TYPES as readonly string[]).includes(values.addressType.toUpperCase())
    ) {
      refused.push({
        line,
        code: 'BAD_ADDRESS_TYPE',
        message: `addressType must be one of ${ADDRESS_TYPES.join(', ')}; received ${JSON.stringify(values.addressType)}.`,
        email,
      });
      continue;
    }

    if (values.timeZone !== undefined && timeZoneRejection(values.timeZone) !== null) {
      refused.push({
        line,
        code: 'BAD_TIME_ZONE',
        message: `timeZone must be an IANA identifier such as Europe/London; received ${JSON.stringify(values.timeZone)}.`,
        email,
      });
      continue;
    }

    if (values.article14NoticeSentAt !== undefined) {
      const at = Date.parse(values.article14NoticeSentAt);
      if (Number.isNaN(at)) {
        refused.push({
          line,
          code: 'BAD_NOTICE_TIMESTAMP',
          message:
            `article14NoticeSentAt ${JSON.stringify(values.article14NoticeSentAt)} is not a ` +
            `timestamp. This column records that a notice was ALREADY sent, so an unreadable ` +
            `value cannot be read as "sent".`,
          email,
        });
        continue;
      }
      values.article14NoticeSentAt = new Date(at).toISOString();
    }

    if (values.country !== undefined) values.country = normaliseCountry(values.country) as string;
    if (values.addressType !== undefined) values.addressType = values.addressType.toUpperCase();

    seen.set(contactId, line);
    rows.push({ line, email, contactId, fields: Object.freeze({ ...values }) });
  }

  return { ok: true, delimiter, header, mapped, ignored, rows, refused };
}
