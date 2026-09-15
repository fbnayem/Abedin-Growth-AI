import { Router, type Request, type Response } from 'express';
import { collection, getDocs, getDoc, doc, query, where, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { createContactSchema, parseOrRespond } from '../lib/validation';
import { normalizeEmailKey } from '../lib/emailKey';
import { createContactIfAbsent, ensureAccount, mergeContacts } from '../lib/identityStore';
import { accountDomain, plusAddressTag, suggestedBaseAddress } from '../lib/identity';
import { sendCaught, sendError } from '../lib/errors';
import { parsedBodyOr400 } from '../lib/parsedBody';
import { expectedVersionFrom, mutateWithVersion, sendMutationOutcome, sendVersionRequired, versionOf } from '../lib/concurrency';
import { createQuote, quotesForEmail } from '../services/quote.service';
import { recordLawfulBasis, revokeConsent } from '../services/lawfulBasis.service';
import { attributionFor, operatorGate } from '../domain/operatorAction';
import { isProduction } from '../config/environment';

/**
 * S39 — Contacts: leads, investors, partners, and the merge.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api`.
 */
export const contactsRouter = Router();

contactsRouter.get('/leads', async (req: Request, res: Response) => {
  try {
    const snap = await getDocs(collection(store, orgPath(orgScope(req), 'contacts')));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    // filter for leads
    res.json(items.filter(i => i.type === 'LEAD' || !i.type));
  } catch(e: any) { sendCaught(req, res, e); }
});

/**
 * P1.10 — Build a contact from validated input.
 *
 * The three contact endpoints (leads, investors, partners) each did
 * `{ ...req.body, id, type, status }`, so any field a caller sent was persisted. The one
 * that matters is `consentGiven`: the action gateway reads it to decide whether a contact
 * may be emailed, so spreading the body let a caller create a contact that was already
 * consented to receive mail. `suppressed`, `organizationId` and `aiScore` were equally
 * writable.
 *
 * Consent is not an input. It records something that happened in the world, and a request
 * that creates a contact cannot also be evidence that the contact agreed to be contacted
 * (§14). New contacts are created with consent explicitly ABSENT, which the gateway reads as
 * "no consent record" and refuses to send to.
 */
function buildContactDocument(
  input: import("../lib/validation").CreateContactInput,
  idPrefix: string,
  type: 'LEAD' | 'INVESTOR' | 'PARTNER',
  status: string
) {
  const emailKey = normalizeEmailKey(input.email);
  return {
    id: `${idPrefix}_${Date.now()}`,
    type,
    status,
    // Server-controlled. Never taken from the request.
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Caller-supplied, but only these fields, and only after parsing.
    name: input.name ?? [input.firstName, input.lastName].filter(Boolean).join(' ') ?? '',
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    email: input.email,
    emailKey,
    title: input.title ?? null,
    phone: input.phone ?? null,
    linkedinUrl: input.linkedinUrl ?? null,
    companyName: input.companyName ?? null,
    companyWebsite: input.companyWebsite ?? null,
    industry: input.industry ?? null,
    country: input.country ?? null,
    employeeCount: input.employeeCount ?? null,
    notes: input.notes ?? null,
    timeZone: input.timeZone ?? null,
  };
}

/**
 * P1.5 — Creating a contact, once, for all three types.
 *
 * Each of these was its own `addDoc`, which asks Firestore for a fresh RANDOM id. Posting
 * the same person twice produced two documents and nothing noticed. That is not untidiness:
 * ActionGateway decides whether someone may be emailed by loading ONE contact document and
 * reading its suppression flags, so an unsubscribe recorded on document A left the person
 * mailable through document B.
 *
 * The id is now derived from the normalised address, so the same person is the same
 * document, and the create is a transaction that REFUSES when the document exists. Refusing
 * rather than overwriting is the point — an overwrite would reset `suppressed` and
 * `consentGiven`, turning the create endpoint into a way to clear an unsubscribe.
 */
async function createContact(
  req: Request,
  res: Response,
  idPrefix: string,
  type: 'LEAD' | 'INVESTOR' | 'PARTNER',
  status: string
) {
  const input = parseOrRespond(createContactSchema, req, res);
  if (input === null) return;

  const orgId = orgScope(req);
  const outcome = await createContactIfAbsent(orgId, input.email, (id) => ({
    ...buildContactDocument(input, idPrefix, type, status),
    id,
    organizationId: orgId,
  }));

  if (outcome.ok === false) {
    if (outcome.code === 'ALREADY_EXISTS') {
      return sendError(
        req,
        res,
        'CONTACT_EXISTS',
        'A contact with this email address already exists in this organisation.',
        {
          details: {
            contactId: outcome.id,
            // Returned so a caller can decide between updating the existing record and
            // merging. Not acted on automatically: a re-post is not evidence of anything.
            existingStatus: outcome.existing.status ?? null,
            existingType: outcome.existing.type ?? null,
          },
        }
      );
    }
    if (outcome.code === 'UNUSABLE_EMAIL') {
      return sendError(req, res, 'VALIDATION_ERROR', outcome.message);
    }
    return sendError(req, res, 'STORE_UNAVAILABLE', outcome.message);
  }

  // The account record for the contact's company domain. `accounts` was declared in the
  // schema and written by nothing, so every contact's accountId has always been null and the
  // resolver's DOMAIN_MATCH branch has always returned an undefined account.
  //
  // Failure here does not fail the request: the contact exists and is correct, and an
  // account is a grouping convenience. It is logged rather than swallowed.
  try {
    const account = await ensureAccount(orgId, input.email, {
      name: input.companyName ?? accountDomain(input.email),
      website: input.companyWebsite ?? null,
      industry: input.industry ?? null,
    });
    if (account.ok && account.created) {
      console.log(`[contacts] Created account ${account.id} for ${accountDomain(input.email)}`);
    }
  } catch (e: any) {
    console.error('[contacts] Account creation failed (contact was still created):', e?.message);
  }

  // A plus-tag is reported, never merged on. See lib/identity: a missed merge leaves a
  // visible duplicate, a wrong merge writes one person's history onto another's.
  const tag = plusAddressTag(input.email);
  const body: Record<string, unknown> = { ...outcome.data };
  if (tag !== null) {
    body.possibleDuplicateOf = suggestedBaseAddress(input.email);
    body.possibleDuplicateReason = `Address carries the tag "${tag}"; a human should confirm.`;
  }

  res.status(201).json(body);
}

contactsRouter.post('/leads', async (req: Request, res: Response) => {
  try {
    await createContact(req, res, 'lead', 'LEAD', 'NEW');
  } catch(e: any) { sendCaught(req, res, e); }
});

/**
 * P1.5 — Merge one contact into another (§15, §14).
 *
 * Deterministic ids stop NEW duplicates. They do nothing about the ones seven addDoc call
 * sites have been creating for the life of the app, so the merge is the other half.
 *
 * Two things about this endpoint are deliberate. It names the survivor and the duplicate
 * explicitly rather than guessing which record to keep — that is a judgement about whose
 * history is authoritative, and it belongs to a person. And it is idempotent by resume
 * rather than by pretending: re-running reparents rows created since the last attempt,
 * because a Firestore transaction cannot enumerate them itself.
 */
contactsRouter.post('/contacts/:survivorId/merge', async (req: Request, res: Response) => {
  try {
    const survivorId = req.params.survivorId;
    const duplicateId = typeof req.body?.duplicateId === 'string' ? req.body.duplicateId : null;

    if (!duplicateId) {
      return sendError(
        req,
        res,
        'VALIDATION_ERROR',
        'A merge names both records: pass duplicateId in the body.'
      );
    }

    const outcome = await mergeContacts(orgScope(req), survivorId, duplicateId, {
      mergedBy: req.tenant?.uid,
      resume: req.body?.resume === true,
    });

    if (outcome.ok === false) {
      if (outcome.code === 'NOT_FOUND') {
        return sendError(req, res, 'NOT_FOUND', outcome.message);
      }
      if (outcome.code === 'STORE_UNAVAILABLE') {
        return sendError(req, res, 'STORE_UNAVAILABLE', outcome.message);
      }
      if (outcome.code === 'TOO_MANY_REFERENCES') {
        return sendError(req, res, 'TOO_MANY_REFERENCES', outcome.message, {
          details: { found: outcome.found },
        });
      }
      return sendError(req, res, 'MERGE_REFUSED', outcome.message, {
        details: { refusal: outcome.code },
      });
    }

    // The caller is told what the merge did to the permission state, because that is the
    // part with consequences: a survivor that has just inherited an unsubscribe is no longer
    // mailable, and an operator who merged two records to "tidy up" needs to know that.
    res.json({
      survivorId: outcome.survivorId,
      duplicateId: outcome.duplicateId,
      reparented: outcome.reparented,
      inheritedSuppression: outcome.inheritedSuppression,
      consentRevoked: outcome.consentRevoked,
    });
  } catch(e: any) { sendCaught(req, res, e); }
});

contactsRouter.post('/leads/batch-generate', async (req: Request, res: Response) => {
  // P1.13 / P1.5 — This handler fabricated contacts and wrote them to the live
  // collection: "Generated Lead 1" at lead0@example.com, with a random
  // aiScore between 70 and 89 so the result looked like research had happened. The UI
  // presents it as "Discover leads", so an operator had no way to tell the rows apart
  // from real ones.
  //
  // It is refused rather than left in place for two reasons. Fabricated records in the
  // CRM are a correctness problem on their own — they are indistinguishable from
  // researched contacts once written. And they entered through `addDoc`, which bypasses
  // the derived id P1.5 relies on, so every call reintroduced exactly the un-keyed
  // duplicates that work exists to make unrepresentable.
  //
  // 501 is the honest answer: the feature is not implemented. A stub that returns
  // plausible data does not tell anyone that.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    'Discovery is not implemented. This endpoint previously returned fabricated ' +
      'leads written into the live contact list; it no longer writes anything. ' +
      'Add contacts through POST /api/leads, or connect a real discovery provider.'
  );
});

contactsRouter.post('/investors/batch-generate', async (req: Request, res: Response) => {
  // P1.13 / P1.5 — This handler fabricated contacts and wrote them to the live
  // collection: "Generated Investor 1" at investor0@example.com, with a random
  // aiScore between 70 and 89 so the result looked like research had happened. The UI
  // presents it as "Discover investors", so an operator had no way to tell the rows apart
  // from real ones.
  //
  // It is refused rather than left in place for two reasons. Fabricated records in the
  // CRM are a correctness problem on their own — they are indistinguishable from
  // researched contacts once written. And they entered through `addDoc`, which bypasses
  // the derived id P1.5 relies on, so every call reintroduced exactly the un-keyed
  // duplicates that work exists to make unrepresentable.
  //
  // 501 is the honest answer: the feature is not implemented. A stub that returns
  // plausible data does not tell anyone that.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    'Discovery is not implemented. This endpoint previously returned fabricated ' +
      'investors written into the live contact list; it no longer writes anything. ' +
      'Add contacts through POST /api/investors, or connect a real discovery provider.'
  );
});

contactsRouter.post('/partners/batch-generate', async (req: Request, res: Response) => {
  // P1.13 / P1.5 — This handler fabricated contacts and wrote them to the live
  // collection: "Generated Partner 1" at partner0@example.com, with a random
  // aiScore between 70 and 89 so the result looked like research had happened. The UI
  // presents it as "Discover partners", so an operator had no way to tell the rows apart
  // from real ones.
  //
  // It is refused rather than left in place for two reasons. Fabricated records in the
  // CRM are a correctness problem on their own — they are indistinguishable from
  // researched contacts once written. And they entered through `addDoc`, which bypasses
  // the derived id P1.5 relies on, so every call reintroduced exactly the un-keyed
  // duplicates that work exists to make unrepresentable.
  //
  // 501 is the honest answer: the feature is not implemented. A stub that returns
  // plausible data does not tell anyone that.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    'Discovery is not implemented. This endpoint previously returned fabricated ' +
      'partners written into the live contact list; it no longer writes anything. ' +
      'Add contacts through POST /api/partners, or connect a real discovery provider.'
  );
});

contactsRouter.post('/leads/research', (req: Request, res: Response) => {
  // S39 — Was `res.json({ notes: "Research complete: High intent detected." })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'Lead research is not implemented. This endpoint returned a fixed "high intent" note for every lead: a fabricated finding, not research.');
});

contactsRouter.post('/leads/batch-followup', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true, count: 10 })`.
  //
  // This reported ten follow-ups sent. It sent none. A batch send must go through the
  // Production Action Gateway per recipient.
  //
  // A false success on an external action is the worst shape this defect takes: the
  // operator believes a customer received something, so nobody looks again.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "This reported ten follow-ups sent. It sent none. A batch send must go through the Production Action Gateway per recipient."
  );
});

contactsRouter.post('/leads/:id/simulate-reply', (req: Request, res: Response) => {
  // S39 — Was `res.json({ reply: "Simulated reply from lead." })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'Reply simulation is not implemented. This endpoint returned a fixed string as though a lead had answered.');
});

contactsRouter.post('/leads/:id/email', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true })`.
  //
  // Emailing a lead is an external send and must go through the Production Action
  // Gateway. This endpoint sent nothing and said it had.
  //
  // A false success on an external action is the worst shape this defect takes: the
  // operator believes a customer received something, so nobody looks again.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "Emailing a lead is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
  );
});

/**
 * S26 — state a contact's time zone. The QUIET_HOURS guard cannot run without one and refuses
 * the send, which is the correct answer for a person whose 3am we cannot tell; this is how an
 * operator supplies the fact. Version-fenced like every other write to a record.
 */
contactsRouter.post('/contacts/:id/time-zone', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/contacts/:id/time-zone');
    if (body === null) return;
    const ref = doc(store, orgPath(orgScope(req), 'contacts'), req.params.id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return sendError(req, res, 'NOT_FOUND', 'No such contact.');
    const currentVersion = versionOf(snap.data(), true);
    const expected = expectedVersionFrom(req);
    if (expected.ok === false) return sendVersionRequired(req, res, expected, currentVersion);
    const outcome = await mutateWithVersion(ref, expected.value, (existing: any) => ({
      ...existing,
      timeZone: body.timeZone,
      timeZoneStatedAt: new Date().toISOString(),
    }));
    return sendMutationOutcome(req, res, outcome);
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * S25 — a quote for this contact, priced from the book. DRAFT until submitted and approved;
 * nothing is stated to a customer from a draft. The email the quote is found by is the
 * contact's, never the body's.
 */
contactsRouter.post('/contacts/:id/quotes', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/contacts/:id/quotes');
    if (body === null) return;
    const snap = await getDoc(doc(store, orgPath(orgScope(req), 'contacts'), req.params.id));
    if (!snap.exists()) return sendError(req, res, 'NOT_FOUND', 'No such contact.');
    const contact = snap.data() as Record<string, unknown>;
    if (typeof contact.email !== 'string') return sendError(req, res, 'VALIDATION_ERROR', 'This contact has no email address to quote to.', { status: 422 });
    const outcome = await createQuote(
      orgScope(req),
      { email: contact.email, contactId: req.params.id, conversationId: body.conversationId ?? null, lineItems: body.lineItems, validUntil: body.validUntil },
      attributionFor(req.user)
    );
    if (outcome.ok === false) {
      return sendError(req, res, outcome.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : 'VALIDATION_ERROR', outcome.message);
    }
    res.status(201).json(outcome.quote);
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * Record the lawful basis on which this contact may be emailed.
 *
 * This is the endpoint whose absence made every lead in the system permanently unmailable: the
 * gateway refused without a basis, and nothing could write one. See `server/domain/lawfulBasis.ts`
 * for the decision and `server/services/lawfulBasis.service.ts` for the four rules the write
 * enforces.
 *
 * `operatorGate` rather than `attributionFor`, because a consent record whose recorder cannot be
 * named is not a consent record. That is the same rule quote approval uses.
 *
 * The response carries the evaluated verdict, so an operator who records a basis and still
 * cannot send is told why immediately. Answering "saved" to a record that remains unmailable is
 * the fabricated-success shape this repository keeps removing.
 */
contactsRouter.post('/contacts/:id/lawful-basis', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/contacts/:id/lawful-basis');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);
    const outcome = await recordLawfulBasis(orgScope(req), req.params.id, body, gate.attribution);
    if (outcome.ok === false) {
      const code =
        outcome.code === 'NOT_FOUND' ? 'NOT_FOUND'
        : outcome.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE'
        : outcome.code === 'ATTRIBUTION_REQUIRED' ? 'ATTRIBUTION_REQUIRED'
        : 'VALIDATION_ERROR';
      return sendError(req, res, code, outcome.message);
    }
    res.json({
      contactId: outcome.contactId,
      basis: outcome.basis,
      mailable: outcome.verdict.ok,
      // Why, in both directions. A refusal names the condition that is still unmet.
      reason: outcome.verdict.ok ? outcome.verdict.why : outcome.verdict.message,
      refusalCode: outcome.verdict.ok ? null : outcome.verdict.code,
    });
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * Revoke consent for this contact.
 *
 * Deliberately NOT behind `operatorGate`: this moves in the safe direction, and a control that
 * refuses to stop something because it cannot name who asked is the wrong failure. The actor is
 * recorded as `unattributed` rather than the action being refused.
 */
contactsRouter.post('/contacts/:id/revoke-consent', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/contacts/:id/revoke-consent');
    if (body === null) return;
    const outcome = await revokeConsent(
      orgScope(req),
      req.params.id,
      attributionFor(req.user),
      body.reason ?? null
    );
    if (outcome.ok === false) {
      return sendError(
        req,
        res,
        outcome.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'STORE_UNAVAILABLE',
        outcome.message
      );
    }
    res.json({
      contactId: outcome.contactId,
      mailable: outcome.verdict.ok,
      reason: outcome.verdict.ok ? outcome.verdict.why : outcome.verdict.message,
    });
  } catch (e: any) { sendCaught(req, res, e); }
});

contactsRouter.get('/contacts/:id/quotes', async (req: Request, res: Response) => {
  try {
    const snap = await getDoc(doc(store, orgPath(orgScope(req), 'contacts'), req.params.id));
    if (!snap.exists()) return sendError(req, res, 'NOT_FOUND', 'No such contact.');
    const contact = snap.data() as Record<string, unknown>;
    const quotes = typeof contact.email === 'string' ? await quotesForEmail(orgScope(req), contact.email) : [];
    res.json({ contactId: req.params.id, count: quotes.length, quotes });
  } catch (e: any) { sendCaught(req, res, e); }
});

contactsRouter.get('/investors', async (req: Request, res: Response) => {
  try {
    const snap = await getDocs(query(collection(store, orgPath(orgScope(req), 'contacts')), where('type', '==', 'INVESTOR')));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    res.json(items);
  } catch(e: any) { sendCaught(req, res, e); }
});

contactsRouter.post('/investors', async (req: Request, res: Response) => {
  try {
    await createContact(req, res, 'inv', 'INVESTOR', 'DISCOVERED');
  } catch(e: any) { sendCaught(req, res, e); }
});

contactsRouter.get('/partners', async (req: Request, res: Response) => {
  try {
    const snap = await getDocs(query(collection(store, orgPath(orgScope(req), 'contacts')), where('type', '==', 'PARTNER')));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    res.json(items);
  } catch(e: any) { sendCaught(req, res, e); }
});

contactsRouter.post('/partners', async (req: Request, res: Response) => {
  try {
    await createContact(req, res, 'part', 'PARTNER', 'DISCOVERED');
  } catch(e: any) { sendCaught(req, res, e); }
});
