const fs = require('fs');
let ds = fs.readFileSync('server/dataStore.ts', 'utf8');

const ensureOrgs = `
      // Ensure required organizations exist to satisfy foreign key constraints
      await db.insert(organizations).values([
        { id: "org_1", name: "Default Org", slug: "default-org-1" },
        { id: "default", name: "Default Workspace", slug: "default-workspace" }
      ]).onConflictDoNothing();

      const orgId = "org_1";`;

ds = ds.replace('const orgId = "org_1";', ensureOrgs);

fs.writeFileSync('server/dataStore.ts', ds);
console.log("Foreign key constraint fix applied to dataStore.ts");
