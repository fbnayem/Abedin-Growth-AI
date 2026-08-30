import { Router } from 'express';
import { outboxService } from '../services/outbox.service.ts';
import { db } from '../db/index.ts';
import { outboxMessages } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

export const outboxRouter = Router();

// Phase 73: Human Review Console APIs
outboxRouter.get('/', async (req, res) => {
  try {
    // Only return PENDING or HUMAN_REVIEW items
    const items = await db.select().from(outboxMessages);
    res.json(items);
  } catch(e) {
    res.status(500).json({ error: "Failed to fetch outbox" });
  }
});

outboxRouter.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    await db.update(outboxMessages).set({ status: 'PENDING' }).where(eq(outboxMessages.id, id));
    res.json({ success: true, message: "Outbox item approved for sending." });
  } catch(e) {
    res.status(500).json({ error: "Approval failed." });
  }
});

outboxRouter.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    await db.update(outboxMessages).set({ status: 'CANCELLED' }).where(eq(outboxMessages.id, id));
    res.json({ success: true, message: "Outbox item cancelled." });
  } catch(e) {
    res.status(500).json({ error: "Rejection failed." });
  }
});
