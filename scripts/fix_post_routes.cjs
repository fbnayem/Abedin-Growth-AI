const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf8');

// Replace /api/investors
const invRegex = /app\.post\("\/api\/investors", async \(_?req: Request, res: Response\) => \{[\s\S]*?res\.json\(newInv\);\n  \}\);/m;
const newInvRoute = `app.post("/api/investors", async (req: Request, res: Response) => {
    const invData = req.body;
    const newId = \`inv_\${Date.now()}\`;
    try {
      await db.insert(schema.contacts).values({
        id: newId,
        organizationId: "default",
        name: invData.name || "Investor Partner",
        title: invData.role || "Partner",
        primaryEmail: invData.email || "",
        status: invData.status || "DISCOVERED"
      });
      res.json({ id: newId, ...invData });
    } catch(e) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });`;
server = server.replace(invRegex, newInvRoute);

// Replace /api/partners
const partRegex = /app\.post\("\/api\/partners", async \(_?req: Request, res: Response\) => \{[\s\S]*?res\.json\(newPart\);\n  \}\);/m;
const newPartRoute = `app.post("/api/partners", async (req: Request, res: Response) => {
    const partData = req.body;
    const newId = \`part_\${Date.now()}\`;
    try {
      await db.insert(schema.contacts).values({
        id: newId,
        organizationId: "default",
        name: partData.name || "Partner Name",
        title: partData.role || "Director of Partnerships",
        primaryEmail: partData.email || "",
        status: partData.status || "DISCOVERED"
      });
      res.json({ id: newId, ...partData });
    } catch(e) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });`;
server = server.replace(partRegex, newPartRoute);

// Replace /api/campaigns
const campRegex = /app\.post\("\/api\/campaigns", \(_?req: Request, res: Response\) => \{[\s\S]*?res\.json\(newCampaign\);\n  \}\);/m;
const newCampRoute = `app.post("/api/campaigns", async (req: Request, res: Response) => {
    const campData = req.body;
    const newId = \`camp_\${Date.now()}\`;
    try {
      await db.insert(schema.campaigns).values({
        id: newId,
        name: campData.name || "New Campaign",
        status: campData.status || "DRAFT",
        targetAudience: campData.targetAudience,
        type: campData.type
      });
      res.json({ id: newId, ...campData });
    } catch(e) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });`;
server = server.replace(campRegex, newCampRoute);

// Replace /api/opportunities
const oppRegex = /app\.post\("\/api\/pipeline", \(_?req: Request, res: Response\) => \{[\s\S]*?res\.json\(newOpp\);\n  \}\);/m;
const newOppRoute = `app.post("/api/pipeline", async (req: Request, res: Response) => {
    const oppData = req.body;
    const newId = \`opp_\${Date.now()}\`;
    try {
      await db.insert(schema.opportunities).values({
        id: newId,
        contactId: oppData.contactId || 'unknown',
        value: oppData.value || 0,
        stage: oppData.stage || "DISCOVERY"
      });
      res.json({ id: newId, ...oppData });
    } catch(e) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });`;
server = server.replace(oppRegex, newOppRoute);

// Replace /api/meetings
const meetRegex = /app\.post\("\/api\/meetings", \(_?req: Request, res: Response\) => \{[\s\S]*?res\.json\(newMeeting\);\n  \}\);/m;
const newMeetRoute = `app.post("/api/meetings", async (req: Request, res: Response) => {
    const meetData = req.body;
    const newId = \`meet_\${Date.now()}\`;
    try {
      await db.insert(schema.meetings).values({
        id: newId,
        contactId: meetData.contactId || 'unknown',
        title: meetData.title || "Meeting",
        status: meetData.status || "PROPOSED",
        scheduledTime: meetData.scheduledAt ? new Date(meetData.scheduledAt) : new Date(),
        meetUrl: meetData.meetLink
      });
      res.json({ id: newId, ...meetData });
    } catch(e) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });`;
server = server.replace(meetRegex, newMeetRoute);

fs.writeFileSync('server.ts', server);
console.log("Fixed POST routes for DB inserts");
