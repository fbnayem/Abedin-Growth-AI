const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const routeReplace = `
  app.post("/api/campaigns/generate-strategy", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount } = req.body;
      
      // Calculate projected metrics for the modal response
      const projectedReach = enrolledCount;
      const projectedEngagement = Math.floor(projectedReach * 0.68); // 68% open rate
      const projectedConversion = Math.floor(projectedReach * 0.12); // 12% conversion
      
      const newCampaign = {
        id: "camp_" + Date.now(),
        name: name || "Untitled Campaign",
        engineType: engineType || "CUSTOMER",
        status: "ACTIVE",
        targetAudience: targetAudience || "",
        targetLocations: targetLocations || [],
        enrolledCount: enrolledCount || 0,
        sentCount: 0,
        openedCount: 0,
        repliedCount: 0,
        convertedCount: 0,
        projectedMetrics: { reach: projectedReach, engagement: projectedEngagement, conversion: projectedConversion },
        aiStrategySummary: \`Generated custom 4-step \${engineType} sequence for \${targetAudience}. Leveraging local market context for \${(targetLocations || []).join(', ')}.\`,
        steps: [
          { 
             stepNumber: 1, 
             title: "The Vision Hook", 
             delayDays: 0, 
             subjectTemplate: "Quick question regarding {{companyName}}", 
             bodyTemplate: "Hi {{firstName}},\\n\\nI noticed you're a leader in the \${(targetIndustries || []).join(', ')} space in \${(targetLocations || [])[0] || 'your area'}. How are you currently managing growth?\\n\\nBest,\\nNayem"
          },
          {
             stepNumber: 2,
             title: "The Value Add",
             delayDays: 3,
             subjectTemplate: "Thoughts on {{companyName}}?",
             bodyTemplate: "Hi {{firstName}},\\n\\nJust following up on my previous note. We recently helped a similar company scale their operations by 40% using AI workflows.\\n\\nLet me know if you'd like to see a quick demo.\\n\\nBest,\\nNayem"
          },
          {
             stepNumber: 3,
             title: "Multi-channel Bump",
             delayDays: 5,
             stepType: "LINKEDIN_TASK",
             subjectTemplate: "LinkedIn Connection",
             bodyTemplate: "Hi {{firstName}}, I'm Nayem from Abedin Growth. Would love to connect and share insights on AI-driven growth for \${(targetIndustries || [])[0] || 'your industry'}."
          }
        ],
        createdAt: new Date().toISOString()
      };
      
      await addDoc(collection(firestore, 'organizations/org_1/campaigns'), newCampaign);
      res.json(newCampaign);
`;

code = code.replace(
  /app\.post\("\/api\/campaigns\/generate-strategy", async \(req: Request, res: Response\) => \{[\s\S]*?            subjectTemplate: "Quick question regarding \{\{companyName\}\}",[\s\S]*?Best,\\nNayem"\n          \},\n          \{/m,
  routeReplace + '\n          {'
);

fs.writeFileSync('server.ts', code);
