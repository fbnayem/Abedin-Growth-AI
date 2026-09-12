import { Router, type Request, type Response } from 'express';
import { collection, getDocs, addDoc, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { createKnowledgeItemSchema, parseOrRespond } from '../lib/validation';
import { sendCaught } from '../lib/errors';

/**
 * S39 — The knowledge base.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/knowledge`.
 */
export const knowledgeRouter = Router();

knowledgeRouter.post('/', async (req: Request, res: Response) => {
  try {
    const input = parseOrRespond(createKnowledgeItemSchema, req, res);
    if (input === null) return;

    // P1.4 — Knowledge is stringified into outbound prompts, so it enters the approval
    // lifecycle as DRAFT rather than as immediately usable text. Nothing may compose from it
    // until it is APPROVED (see KNOWLEDGE_ITEM in server/domain/stateMachines.ts).
    const payload = {
      id: `kno_${Date.now()}`,
      version: 0,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: input.title,
      content: input.content,
      category: input.category ?? null,
      tags: input.tags ?? [],
    };
    await addDoc(collection(store, orgPath(orgScope(req), 'knowledge')), payload);
    res.json(payload);
  } catch(e: any) { sendCaught(req, res, e); }
});

knowledgeRouter.get('/', async (req: Request, res: Response) => {
  try {
    const snap = await getDocs(collection(store, orgPath(orgScope(req), 'knowledge')));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    res.json(items);
  } catch(e: any) { sendCaught(req, res, e); }
});
