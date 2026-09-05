const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const correctRoute = `
  app.post("/api/campaigns/generate-strategy", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount } = req.body;
      
      const projectedReach = enrolledCount || 0;
      const projectedEngagement = Math.floor(projectedReach * 0.68);
      const projectedConversion = Math.floor(projectedReach * 0.12);
      
      const newCampaign = {
        id: "camp_" + Date.now(),
        name: name || "Untitled Campaign",
        engineType: engineType || "CUSTOMER",
        status: "ACTIVE",
        targetAudience: targetAudience || "",
        targetLocations: targetLocations || [],
        targetIndustries: targetIndustries || [],
        enrolledCount: projectedReach,
        sentCount: 0,
        openedCount: 0,
        repliedCount: 0,
        convertedCount: 0,
        projectedMetrics: { reach: projectedReach, engagement: projectedEngagement, conversion: projectedConversion },
        aiStrategySummary: \`Generated custom sequence for \${targetAudience}. Leveraging local market context for \${(targetLocations || []).join(', ')}.\`,
        steps: [
          {
             stepNumber: 1,
             title: "The Vision Hook",
             delayDays: 0,
             subjectTemplate: "Quick question regarding {{companyName}}",
             bodyTemplate: "Hi {{firstName}},\\n\\nI noticed you're a leader in the \${(targetIndustries || [])[0] || 'space'} in \${(targetLocations || [])[0] || 'your area'}. How are you currently managing growth?\\n\\nBest,\\nNayem"
          },
          {
             stepNumber: 2,
             title: "The Value Add",
             delayDays: 3,
             subjectTemplate: "Thoughts on {{companyName}}?",
             bodyTemplate: "Hi {{firstName}},\\n\\nJust following up on my previous note. We recently helped a similar company scale their operations by 40%.\\n\\nLet me know if you'd like to see a quick demo.\\n\\nBest,\\nNayem"
          },
          {
             stepNumber: 3,
             title: "Multi-channel Bump",
             delayDays: 5,
             stepType: "LINKEDIN_TASK",
             subjectTemplate: "LinkedIn Connection",
             bodyTemplate: "Hi {{firstName}}, I'm Nayem. Would love to connect and share insights."
          }
        ],
        createdAt: new Date().toISOString()
      };
      
      await addDoc(collection(firestore, 'organizations/org_1/campaigns'), newCampaign);
      res.json(newCampaign);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(/app\.post\("\/api\/campaigns\/generate-strategy"[\s\S]*?res\.status\(500\)\.json\(\{ error: e\.message \}\);\n    \}\n  \}\);/m, correctRoute);
fs.writeFileSync('server.ts', code);
