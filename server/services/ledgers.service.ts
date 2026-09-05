import { firestore } from '../firebase';
import { v4 as uuidv4 } from 'uuid';

export class LedgerService {
  private getOrgRef(orgId: string) {
    return firestore.collection(`organizations/${orgId}`);
  }

  // F. FACT FRESHNESS
  async upsertFact(orgId: string, contactId: string, factData: any) {
    if (!firestore) return;
    const factId = factData.id || uuidv4();
    await this.getOrgRef(orgId).collection(`contacts/${contactId}/facts`).doc(factId).set({
      ...factData,
      id: factId,
      observedAt: factData.observedAt || Date.now(),
      lastVerifiedAt: Date.now(),
      validFrom: factData.validFrom || Date.now(),
      validUntil: factData.validUntil || null,
      supersededBy: null
    }, { merge: true });
    return factId;
  }

  // G. CUSTOMER COMMITMENT LEDGER
  async addCommitment(orgId: string, commitment: any) {
    if (!firestore) return;
    const id = uuidv4();
    await this.getOrgRef(orgId).collection('commitments').doc(id).set({
      id,
      accountId: commitment.accountId,
      contactId: commitment.contactId,
      conversationId: commitment.conversationId,
      commitment: commitment.commitment,
      sourceMessageId: commitment.sourceMessageId,
      madeBy: commitment.madeBy,
      dueDate: commitment.dueDate,
      status: commitment.status || 'OPEN',
      riskLevel: commitment.riskLevel || 'LOW',
      createdAt: Date.now()
    });
    return id;
  }

  // H. QUESTION LEDGER
  async trackQuestion(orgId: string, question: any) {
    if (!firestore) return;
    const id = uuidv4();
    await this.getOrgRef(orgId).collection('questions').doc(id).set({
      id,
      contactId: question.contactId,
      conversationId: question.conversationId,
      statement: question.statement,
      status: question.status || 'OPEN', // OPEN, PARTIALLY_ANSWERED, ANSWERED, DEFERRED, HUMAN_REQUIRED
      sourceMessageId: question.sourceMessageId,
      createdAt: Date.now()
    });
    return id;
  }

  // I. OBJECTION LEDGER
  async trackObjection(orgId: string, objection: any) {
    if (!firestore) return;
    const id = uuidv4();
    await this.getOrgRef(orgId).collection('objections').doc(id).set({
      id,
      contactId: objection.contactId,
      type: objection.type,
      statement: objection.statement,
      sourceMessageId: objection.sourceMessageId,
      severity: objection.severity || 'MEDIUM',
      status: objection.status || 'OPEN',
      resolution: null,
      resolvedAt: null,
      createdAt: Date.now()
    });
    return id;
  }

  // J. STAKEHOLDER MAP
  async upsertStakeholder(orgId: string, accountId: string, stakeholder: any) {
    if (!firestore) return;
    const id = stakeholder.id || uuidv4();
    await this.getOrgRef(orgId).collection(`accounts/${accountId}/stakeholders`).doc(id).set({
      ...stakeholder,
      id,
      role: stakeholder.role || 'UNKNOWN', // CHAMPION, DECISION_MAKER, TECHNICAL_EVALUATOR, FINANCE, PROCUREMENT, USER, BLOCKER, UNKNOWN
      updatedAt: Date.now()
    }, { merge: true });
    return id;
  }

  // K. QUOTE SNAPSHOT
  async saveQuoteSnapshot(orgId: string, quote: any) {
    if (!firestore) return;
    const id = uuidv4();
    await this.getOrgRef(orgId).collection('quotes').doc(id).set({
      id,
      contactId: quote.contactId,
      pricingVersion: quote.pricingVersion,
      amount: quote.amount,
      quotedAt: Date.now(),
      expiresAt: quote.expiresAt,
      status: 'ACTIVE'
    });
    return id;
  }
}

export const ledgerService = new LedgerService();
