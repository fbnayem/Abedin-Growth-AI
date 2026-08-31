const fs = require('fs');
let schema = fs.readFileSync('server/db/schema.ts', 'utf8');

if (!schema.includes('oauthConnections')) {
    const tableDef = `
export const oauthConnections = pgTable('oauth_connections', {
  id: varchar('id', { length: 255 }).primaryKey(),
  organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  accountEmail: varchar('account_email', { length: 255 }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at'),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
`;
    schema = schema.replace("export const aiRunLogs", tableDef + "\nexport const aiRunLogs");
    fs.writeFileSync('server/db/schema.ts', schema);
    console.log("Added oauthConnections schema");
}
