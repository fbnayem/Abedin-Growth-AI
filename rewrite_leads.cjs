const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');

const leadsRouteReplacement = `
  // 3. Leads & Research (REWRITTEN TO NATIVE POSTGRESQL)
  app.get("/api/leads", async (_req: Request, res: Response) => {
    try {
      const dbLeads = await db.select().from(schema.contacts);
      // Map DB schema back to the frontend Lead format
      const mappedLeads = dbLeads.map(c => ({
        id: c.id,
        workspaceId: c.organizationId,
        type: "CUSTOMER",
        name: c.name || "",
        title: c.title || "",
        email: c.primaryEmail || "",
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }));
      // Merge with any legacy globalStore leads that haven't migrated yet
      const legacyIds = new Set(mappedLeads.map(l => l.id));
      const legacyLeads = globalStore.leads.filter(l => !legacyIds.has(l.id));
      
      res.json([...mappedLeads, ...legacyLeads]);
    } catch (e) {
      console.error(e);
      res.json(globalStore.leads); // fallback
    }
  });

  app.post("/api/leads", async (req: Request, res: Response) => {
    const leadData = req.body;
    const newId = \`lead_\${Date.now()}\`;
    
    try {
      await db.insert(schema.contacts).values({
        id: newId,
        organizationId: "default",
        name: leadData.name || "Prospect",
        primaryEmail: leadData.email || "",
        title: leadData.title || "Director",
        phone: leadData.phone,
        linkedinUrl: leadData.linkedinUrl,
        status: leadData.status || "NEW"
      });
    } catch(e) {
      console.error("DB Insert Failed", e);
    }

    // Keep legacy sync for background agents
    const newLead: Lead = {
      id: newId,
      workspaceId: "default",
      type: "CUSTOMER",
      name: leadData.name || "Prospect",
      title: leadData.title || "Director",
      email: leadData.email || "",
      phone: leadData.phone,
      linkedinUrl: leadData.linkedinUrl,
      companyName: leadData.companyName || "Target Org",
      companyWebsite: leadData.companyWebsite || "",
      industry: leadData.industry || "Healthcare & Clinics",
      country: leadData.country || "United Kingdom",
      employeeCount: leadData.employeeCount || "10-50",
      status: (leadData.status as any) || "NEW",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    globalStore.leads.unshift(newLead);
    globalStore.saveToDisk();

    res.json(newLead);
  });
`;

// Regex replace the exact block in server.ts
server = server.replace(
  /\/\/ 3\. Leads & Research[\s\S]*?app\.post\("\/api\/leads", async \(req: Request, res: Response\) => \{[\s\S]*?res\.json\(newLead\);\n  \}\);/,
  leadsRouteReplacement
);

if (!server.includes('db.select().from(schema.contacts)')) {
  console.log("Failed to replace!");
} else {
  // Ensure db and schema are imported
  if (!server.includes('import { db }')) {
    server = 'import { db } from "./server/db/index";\nimport * as schema from "./server/db/schema";\n' + server;
  }
  fs.writeFileSync('server.ts', server);
  console.log("Successfully rewrote /api/leads to PostgreSQL!");
}

