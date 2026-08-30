const fs = require('fs');

// 1. types.ts
let types = fs.readFileSync('src/types.ts', 'utf8');
types = types.replace(/export type NavTab =([^;]+);/, (match, p1) => {
  if (!p1.includes('"outbox"')) {
    return 'export type NavTab =' + p1 + ' | "outbox";';
  }
  return match;
});
fs.writeFileSync('src/types.ts', types);

// 2. Sidebar.tsx
let sidebar = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
if (!sidebar.includes('{ id: "outbox"')) {
  sidebar = sidebar.replace(/\{ id: "inbox".+\},/, '$&\n    { id: "outbox", label: "Outbox Queue", icon: ShieldCheck },');
  sidebar = sidebar.replace(/import {/, 'import { ShieldCheck, ');
  fs.writeFileSync('src/components/Sidebar.tsx', sidebar);
}

// 3. App.tsx
let app = fs.readFileSync('src/App.tsx', 'utf8');
if (!app.includes('<OutboxView />')) {
  app = app.replace(/import \{ InboxView \} from "\.\/pages\/InboxView\.tsx";/, 'import { InboxView } from "./pages/InboxView.tsx";\nimport { OutboxView } from "./pages/OutboxView.tsx";');
  app = app.replace(/\{currentTab === "inbox" && \(\n\s*<InboxView[\s\S]*?\/>\n\s*\)\}/, '$&\n          {currentTab === "outbox" && <OutboxView />}');
  fs.writeFileSync('src/App.tsx', app);
}
console.log("OutboxView successfully wired!");
