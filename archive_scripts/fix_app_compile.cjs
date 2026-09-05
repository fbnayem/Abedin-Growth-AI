const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Remove setGlobalAutopilotConfig
content = content.replace(
  /if \(s\.autopilot\) setGlobalAutopilotConfig\(s\.autopilot\);/g,
  ""
);

// 2. Add OutboxView import 
if (!content.includes('import { OutboxView } from "./pages/OutboxView"')) {
    content = content.replace(
      /import \{ InboxView \} from "\.\/pages\/InboxView";/,
      'import { InboxView } from "./pages/InboxView";\nimport { OutboxView } from "./pages/OutboxView";'
    );
}
// Maybe I used .tsx in previous replacement? Let's try general replace
if (!content.includes('import { OutboxView } from')) {
    content = content.replace(
      /import \{ InboxView \} from "\.\/pages\/InboxView(\.tsx)?";/,
      'import { InboxView } from "./pages/InboxView$1";\nimport { OutboxView } from "./pages/OutboxView$1";'
    );
}

fs.writeFileSync('src/App.tsx', content);
