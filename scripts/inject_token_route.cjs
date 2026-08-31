const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');

const route = `
  app.post("/api/integrations/gmail/token", async (req: Request, res: Response) => {
    const { accessToken, expiresIn, accountEmail } = req.body;
    const orgId = req.user?.organizationId || "default";
    
    try {
      const existing = await db.select().from(schema.oauthConnections)
        .where(eq(schema.oauthConnections.organizationId, orgId));
      
      const gmailConn = existing.find(e => e.provider === 'GMAIL');
      
      const expiresAt = new Date(Date.now() + (expiresIn || 3600) * 1000);
      
      if (gmailConn) {
        await db.update(schema.oauthConnections).set({
          accessToken,
          accountEmail,
          expiresAt,
          updatedAt: new Date()
        }).where(eq(schema.oauthConnections.id, gmailConn.id));
      } else {
        await db.insert(schema.oauthConnections).values({
          id: \`oauth_gmail_\${Date.now()}\`,
          organizationId: orgId,
          provider: 'GMAIL',
          accessToken,
          accountEmail,
          expiresAt
        });
      }
      res.json({ success: true });
    } catch(e) {
      console.error("Token sync error:", e);
      res.status(500).json({ error: e.message });
    }
  });
`;

if (!server.includes('/api/integrations/gmail/token')) {
    server = server.replace('app.get("/api/inbox",', route + '\n  app.get("/api/inbox",');
    fs.writeFileSync('server.ts', server);
    console.log("Injected /api/integrations/gmail/token route");
}
