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
import { recordArticle14Notice, recordLawfulBasis, revokeConsent } from '../services/lawfulBasis.service';
import { importLeads } from '../services/leadImport.service';
import { previewScore, scoreContacts } from '../services/leadScore.service';
import { discoverLeads } from '../services/discovery.service';
import { buildContactDocument } from '../domain/contactDocument';
import { attributionFor, operatorGate } from '../domain/operatorAction';
import { isProduction } from '../config/environment';

/**
 * S39 — Contacts: leads, investors, partners, and the merge.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api`.
 */
export const contactsRouter = Router();

/**
 * The one path that accepts a body larger than the global 100kb.
 *
 * Exported so `server.ts` mounts its parser against the same string this router registers,
 * rather than a copy that could drift by one character and silently fall back to the small
 * limit. A mismatch here would not fail loudly: imports would just start returning 413.
 */
export const LEAD_IMPORT_PATH = '/api/leads/import';

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
 * P1.10 / P2b — Build a contact from validated input.
 *
 * The shape itself moved to `server/domain/contactDocument.ts` when the import path became a
 * second caller. What stays here is the part that is specific to a request: the basis is
 * honoured only for an IDENTIFIED operator, because `consentRecordedBy` is part of what makes
 * a consent record defensible and "somebody" is not a recorder.
 *
 * Consent is still not an input. What a caller may state is the BASIS and its evidence; the
 * `consentGiven` flag is derived from the basis, so the two can never disagree (§14).
 */
function contactDocumentFor(
  input: import("../lib/validation").CreateContactInput,
  id: string,
  organizationId: string,
  type: 'LEAD' | 'INVESTOR' | 'PARTNER',
  status: string,
  recordedBy: string | null
) {
  return buildContactDocument(input, {
    id,
    organizationId,
    type,
    status,
    now: new Date(),
    provenance: {
      source: 'MANUAL',
      sourceEvidence:
        input.sourceEvidence ??
        (recordedBy === null ? 'Entered through the API.' : `Entered by ${recordedBy}.`),
      sourceCollectedAt: new Date().toISOString(),
    },
    basis:
      input.lawfulBasis !== undefined && recordedBy !== null
        ? {
            basis: input.lawfulBasis,
            addressType: input.addressType,
            consentEvidence: input.consentEvidence,
            consentSource: input.consentSource,
            liaId: input.liaId,
            article14NoticeSentAt: input.article14NoticeSentAt,
            recordedBy,
          }
        : undefined,
  });
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
  type: 'LEAD' | 'INVESTOR' | 'PARTNER',
  status: string
) {
  const input = parseOrRespond(createContactSchema, req, res);
  if (input === null) return;

  const attribution = attributionFor(req.user);
  const recordedBy = attribution.kind === 'IDENTIFIED' ? attribution.actor : null;

  // A basis claimed by a caller nobody can name is refused rather than dropped. Dropping it
  // would create the contact and report success while the thing the operator asked for — that
  // this person may be emailed — silently did not happen.
  if (input.lawfulBasis !== undefined && recordedBy === null) {
    return sendError(
      req,
      res,
      'ATTRIBUTION_REQUIRED',
      'Recording a lawful basis needs an identified operator: a consent whose recorder cannot ' +
        'be named is one that cannot be defended. Create the contact without a basis and record ' +
        'it separately, or authenticate.'
    );
  }

  const orgId = orgScope(req);
  const outcome = await createContactIfAbsent(orgId, input.email, (id) =>
    contactDocumentFor(input, id, orgId, type, status, recordedBy)
  );

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
    await createContact(req, res, 'LEAD', 'NEW');
  } catch(e: any) { sendCaught(req, res, e); }
});

/**
 * CSV / list import — preview, then commit.
 *
 * ONE ENDPOINT, TWO MODES, AND THE MODE IS NOT A DETAIL. A preview reads and reports; a commit
 * writes. They share this handler so the plan the operator approved and the plan that is
 * executed are produced by the same code — two endpoints would be two planners, and the one
 * that drifted would be the one nobody previewed with.
 *
 * `operatorGate` rather than `attributionFor`: the importer's name is written into every
 * record's consent trail, and an import by "somebody" produces records whose basis cannot be
 * defended. The service refuses an unattributed caller as well; the gate here is what turns
 * that into a 403 rather than a 200 carrying a refusal.
 */
contactsRouter.post('/leads/import', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/leads/import');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    if (body.mode === 'COMMIT' && body.expectedPlanHash === undefined) {
      return sendError(
        req,
        res,
        'VALIDATION_ERROR',
        'A commit must name the plan it is committing (expectedPlanHash, from the preview). ' +
          'Committing without one would be approving a preview nobody ran.'
      );
    }

    const outcome = await importLeads(
      orgScope(req),
      body.text,
      {
        basis: body.basis,
        liaId: body.liaId,
        consentEvidence: body.consentEvidence,
        consentSource: body.consentSource,
        country: body.country,
        addressType: body.addressType,
        sourceEvidence: body.sourceEvidence,
        type: body.type,
      },
      gate.attribution,
      { mode: body.mode, expectedPlanHash: body.expectedPlanHash }
    );

    if (outcome.ok === false) {
      const status =
        outcome.code === 'ATTRIBUTION_REQUIRED' ? 'ATTRIBUTION_REQUIRED'
        : outcome.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE'
        : 'VALIDATION_ERROR';
      return sendError(req, res, status, outcome.message, {
        details: { importRefusal: outcome.code },
      });
    }

    res.json(outcome);
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * Record that the Article 14 notice has been sent, for up to 500 contacts.
 *
 * Without this, legitimate interest is unreachable in practice: the gate requires the notice,
 * the importer refuses to assert it on the operator's behalf, and recording it one contact at
 * a time through the basis endpoint is not a workflow anyone would complete for a 900-row list.
 *
 * The timestamp is the moment of the call, never a parameter — see the service.
 */
contactsRouter.post('/leads/notice-sent', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/leads/notice-sent');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await recordArticle14Notice(
      orgScope(req),
      body.contactIds,
      body.evidence,
      gate.attribution
    );
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);

    res.json({
      recorded: outcome.outcomes.filter((o) => o.recorded).length,
      unchanged: outcome.outcomes.filter((o) => !o.recorded).length,
      mailable: outcome.outcomes.filter((o) => o.mailable).length,
      outcomes: outcome.outcomes,
    });
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * Score contacts against the declared ideal customer profile.
 *
 * The rubric is in `server/domain/leadScore.ts`, and the property that matters is what it
 * REFUSES to do: a component with no input is not scored, so the response carries a confidence
 * alongside the score. The generator this replaces produced a number between 79 and 89 for
 * every lead, from the loop index, with three paragraphs of reasons.
 */
contactsRouter.post('/leads/score', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/leads/score');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await scoreContacts(orgScope(req), body.contactIds ?? [], gate.attribution, {
      limit: body.limit,
    });
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);
    res.json(outcome);
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * What this contact would score right now, without storing anything.
 *
 * Separate from the write above because a stored score goes stale: the rubric moves, the
 * company brain is edited, the contact is enriched. An operator looking at one lead should be
 * able to see the current answer without deciding to overwrite the recorded one.
 */
/**
 * Paid lead discovery, preview or commit.
 *
 * This is what the dead "Discover with AI" button used to call. That endpoint answered 501
 * because the implementation behind it fabricated records; this one calls a registered provider
 * or refuses, and the refusals are the interesting part — the flag is off by default, no
 * adapter ships with this repository, and the tenant's spend cap is checked before the network.
 */
contactsRouter.post('/leads/discover', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/leads/discover');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await discoverLeads(
      orgScope(req),
      {
        country: body.country,
        industry: body.industry,
        titles: body.titles,
        companySizeMin: body.companySizeMin,
        companySizeMax: body.companySizeMax,
        limit: body.limit,
      },
      {
        basis: body.basis,
        liaId: body.liaId,
        addressType: body.addressType,
        sourceEvidence: body.sourceEvidence,
        type: body.type,
      },
      gate.attribution,
      { mode: body.mode }
    );

    if (outcome.ok === false) {
      const code =
        outcome.code === 'ATTRIBUTION_REQUIRED' ? 'ATTRIBUTION_REQUIRED'
        : outcome.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE'
        : outcome.code === 'DISCOVERY_DISABLED' || outcome.code === 'NO_PROVIDER' ? 'NOT_IMPLEMENTED'
        : outcome.code === 'SPEND_CAPPED' ? 'POLICY_BLOCKED'
        : 'VALIDATION_ERROR';
      return sendError(req, res, code, outcome.message, {
        details: { discoveryRefusal: outcome.code, sideEffect: outcome.sideEffect ?? null },
      });
    }

    res.json(outcome);
  } catch (e: any) { sendCaught(req, res, e); }
});

contactsRouter.get('/leads/:id/score', async (req: Request, res: Response) => {
  try {
    const outcome = await previewScore(orgScope(req), req.params.id);
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);
    res.json({ contactId: outcome.contactId, ...outcome.result });
  } catch (e: any) { sendCaught(req, res, e); }
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
    await createContact(req, res, 'INVESTOR', 'DISCOVERED');
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
    await createContact(req, res, 'PARTNER', 'DISCOVERED');
  } catch(e: any) { sendCaught(req, res, e); }
});
