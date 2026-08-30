const fs = require('fs');

let file = fs.readFileSync('src/pages/IntegrationsView.tsx', 'utf8');

// 1. Update Tabs type
const tabDefRegex = /useState<"ALL" \| "EMAIL" \| "LINKEDIN" \| "CALENDAR" \| "VOICE">/;
file = file.replace(tabDefRegex, 'useState<"ALL" | "EMAIL" | "LINKEDIN" | "CALENDAR" | "VOICE" | "DATABASE" | "QUEUE" | "PAYMENTS">');

// 2. Update Tabs map
const tabsMapRegex = /\{ id: "CALENDAR", label: "Calendar & Voice" \},/g;
file = file.replace(tabsMapRegex, '{ id: "CALENDAR", label: "Calendar & Voice" },\n            { id: "DATABASE", label: "Database" },\n            { id: "QUEUE", label: "Background Queue" },\n            { id: "PAYMENTS", label: "Payments" },');

// 3. Define the new state inputs right after testSendSuccess
const stateDefRegex = /const \[testSendSuccess, setTestSendSuccess\] = useState\(false\);/;
const newState = `const [testSendSuccess, setTestSendSuccess] = useState(false);
  const [dbConfig, setDbConfig] = useState({ url: "" });
  const [redisConfig, setRedisConfig] = useState({ url: "" });
  const [stripeConfig, setStripeConfig] = useState({ secretKey: "", webhookSecret: "" });
  const [gmailOauth, setGmailOauth] = useState({ clientId: "", clientSecret: "", redirectUri: "" });
  const [calendarConfig, setCalendarConfig] = useState({ enabled: false });`;
file = file.replace(stateDefRegex, newState);

fs.writeFileSync('src/pages/IntegrationsView.tsx', file);
