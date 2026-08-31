const fs = require('fs');
const file = 'server/dataStore.ts';
let code = fs.readFileSync(file, 'utf8');

// We are going to replace globalStore.saveToDisk() logic with a sync to Firestore.
const saveAnchor = `  saveToDisk() {
    if (this.isSimulating) return; // Don't persist simulated test matrix runs
    try {
      const data = {
        leads: this.leads,
        conversations: this.conversations,
        campaigns: this.campaigns,
        meetings: this.meetings,
        opportunities: this.opportunities,
        investors: this.investors,
        partners: this.partners,
        companyBrain: this.companyBrain,
        dailyBrief: this.dailyBrief,
        attentionItems: this.attentionItems,
        knowledgeItems: this.knowledgeItems,
        linkedInConfig: this.linkedInConfig,
        autopilotSettings: this.autopilotSettings,
        outboxLogs: this.outboxLogs,
        senderIdentity: this.senderIdentity,
        suppressionList: this.suppressionList,
        aiRunLogs: this.aiRunLogs,
      };
      fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.error("Failed to save data to disk:", e);
    }
  }`;

const saveReplace = `  async saveToDisk() {
    if (this.isSimulating) return;
    try {
      // Keep local disk sync for instant local speed during dev
      const data = {
        leads: this.leads,
        conversations: this.conversations,
        campaigns: this.campaigns,
        meetings: this.meetings,
        opportunities: this.opportunities,
        investors: this.investors,
        partners: this.partners,
        companyBrain: this.companyBrain,
        dailyBrief: this.dailyBrief,
        attentionItems: this.attentionItems,
        knowledgeItems: this.knowledgeItems,
        linkedInConfig: this.linkedInConfig,
        autopilotSettings: this.autopilotSettings,
        outboxLogs: this.outboxLogs,
        senderIdentity: this.senderIdentity,
        suppressionList: this.suppressionList,
        aiRunLogs: this.aiRunLogs,
      };
      fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(data, null, 2), "utf8");

      // Background Sync to Firestore
      try {
        const { firestore } = require('./firebase');
        if (firestore) {
           const orgId = "org_1";
           const orgRef = firestore.collection('organizations').doc(orgId);
           
           // We batch write the core entities that overlap with the dashboard
           const batch = firestore.batch();
           
           // Set Contacts
           this.leads.forEach(lead => {
              batch.set(orgRef.collection('contacts').doc(lead.id), { ...lead, status: lead.status || 'NEW' }, { merge: true });
           });

           // Set Conversations
           this.conversations.forEach(conv => {
              batch.set(orgRef.collection('conversations').doc(conv.id), { ...conv }, { merge: true });
           });
           
           // Set Meetings
           this.meetings.forEach(m => {
              batch.set(orgRef.collection('meetings').doc(m.id), { ...m }, { merge: true });
           });

           await batch.commit();
        }
      } catch (fbErr) {
        // Silent fail firestore sync so it doesn't crash the agent loops
        console.error("Firestore sync error:", fbErr);
      }
    } catch (e) {
      console.error("Failed to save data to disk:", e);
    }
  }`;

code = code.replace(saveAnchor, saveReplace);
fs.writeFileSync(file, code);
console.log("Patched dataStore with Firestore sync adapter");
