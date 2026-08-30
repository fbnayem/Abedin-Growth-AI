const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');

const reps = [
  {
    regex: /app\.get\("\/api\/investors", \(_req: Request, res: Response\) => \{\n    res\.json\(globalStore\.investors\);\n  \}\);/g,
    replace: `app.get("/api/investors", async (_req: Request, res: Response) => {
    try {
      const dbLeads = await db.select().from(schema.contacts);
      const mapped = dbLeads.map(c => ({
        id: c.id,
        workspaceId: c.organizationId,
        type: "INVESTOR",
        name: c.name || "",
        title: c.title || "",
        email: c.primaryEmail || "",
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }));
      res.json([...mapped, ...globalStore.investors]);
    } catch(e) { res.json(globalStore.investors); }
  });`
  },
  {
    regex: /app\.get\("\/api\/partners", \(_req: Request, res: Response\) => \{\n    res\.json\(globalStore\.partners\);\n  \}\);/g,
    replace: `app.get("/api/partners", async (_req: Request, res: Response) => {
    try {
      const dbLeads = await db.select().from(schema.contacts);
      const mapped = dbLeads.map(c => ({
        id: c.id,
        workspaceId: c.organizationId,
        type: "PARTNER",
        name: c.name || "",
        title: c.title || "",
        email: c.primaryEmail || "",
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }));
      res.json([...mapped, ...globalStore.partners]);
    } catch(e) { res.json(globalStore.partners); }
  });`
  },
  {
    regex: /app\.get\("\/api\/meetings", \(_req: Request, res: Response\) => \{\n    res\.json\(globalStore\.meetings\);\n  \}\);/g,
    replace: `app.get("/api/meetings", async (_req: Request, res: Response) => {
    try {
      const dbMeetings = await db.select().from(schema.meetings);
      const mapped = dbMeetings.map(m => ({
        id: m.id,
        contactId: m.contactId,
        prospectName: "Unknown",
        prospectEmail: "unknown@example.com",
        companyName: "Unknown",
        status: m.status,
        scheduledAt: m.scheduledTime ? m.scheduledTime.toISOString() : undefined,
        meetLink: m.meetUrl,
      }));
      res.json([...mapped, ...globalStore.meetings]);
    } catch(e) { res.json(globalStore.meetings); }
  });`
  },
  {
    regex: /app\.get\("\/api\/campaigns", \(_req: Request, res: Response\) => \{\n    res\.json\(globalStore\.campaigns\);\n  \}\);/g,
    replace: `app.get("/api/campaigns", async (_req: Request, res: Response) => {
    try {
      const dbCamps = await db.select().from(schema.campaigns);
      const mapped = dbCamps.map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        targetAudience: c.targetAudience,
        type: c.type
      }));
      res.json([...mapped, ...globalStore.campaigns]);
    } catch(e) { res.json(globalStore.campaigns); }
  });`
  },
  {
    regex: /app\.get\("\/api\/pipeline", \(_req: Request, res: Response\) => \{\n    res\.json\(globalStore\.opportunities\);\n  \}\);/g,
    replace: `app.get("/api/pipeline", async (_req: Request, res: Response) => {
    try {
      const dbOpps = await db.select().from(schema.opportunities);
      const mapped = dbOpps.map(o => ({
        id: o.id,
        contactId: o.contactId,
        stage: o.stage,
        value: o.value
      }));
      res.json([...mapped, ...globalStore.opportunities]);
    } catch(e) { res.json(globalStore.opportunities); }
  });`
  }
];

reps.forEach(r => {
  server = server.replace(r.regex, r.replace);
});

fs.writeFileSync('server.ts', server);
console.log("Bulk replacement executed.");
