const fs = require('fs');
const file = 'server/services/outbox.service.ts';
let code = `import { firestore } from '../firebase';
import { v4 as uuidv4 } from 'uuid';
import { collection, doc, setDoc, getDocs, query, where, limit, updateDoc } from 'firebase/firestore';

export interface OutboxPayload {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export class OutboxService {
  async queueMessage(conversationId: string, payload: OutboxPayload, idempotencyKey: string) {
    if (!firestore) return null;
    try {
      const orgId = "org_1";
      const outboxRef = collection(firestore, \`organizations/\${orgId}/outbox\`);
      
      // Idempotency check
      const q = query(outboxRef, where('idempotencyKey', '==', idempotencyKey));
      const existing = await getDocs(q);
      if (!existing.empty) {
        console.log(\`Idempotency key \${idempotencyKey} already exists. Skipping.\`);
        return null;
      }

      const id = uuidv4();
      await setDoc(doc(firestore, \`organizations/\${orgId}/outbox\`, id), {
        id,
        conversationId,
        idempotencyKey,
        payload,
        status: 'PENDING',
        createdAt: Date.now(),
      });
      
      return { id };
    } catch (error: any) {
      console.error("Queue message error:", error);
      throw error;
    }
  }

  async fetchPendingJobs(limitCount = 10) {
    if (!firestore) return [];
    try {
      const orgId = "org_1";
      const outboxRef = collection(firestore, \`organizations/\${orgId}/outbox\`);
      const q = query(outboxRef, where('status', '==', 'PENDING'), limit(limitCount));
      const snap = await getDocs(q);
        
      const jobs: any[] = [];
      snap.forEach(d => jobs.push(d.data()));
      return jobs;
    } catch (error) {
      console.error("Failed to fetch pending outbox jobs", error);
      return [];
    }
  }

  async markProcessed(id: string, providerMessageId: string) {
    if (!firestore) return;
    const orgId = "org_1";
    await updateDoc(doc(firestore, \`organizations/\${orgId}/outbox\`, id), { status: 'PROCESSED', processedAt: Date.now() });
  }

  async markFailed(id: string, error: string) {
    if (!firestore) return;
    const orgId = "org_1";
    await updateDoc(doc(firestore, \`organizations/\${orgId}/outbox\`, id), { status: 'FAILED', error });
  }
}

export const outboxService = new OutboxService();
`;
fs.writeFileSync(file, code);
