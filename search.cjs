const fs = require('fs');
try {
  const content = fs.readFileSync('/skills/system_skills/firebase-skill/SKILL.md', 'utf8');
  const lines = content.split('\n');
  lines.forEach((l, i) => {
    if (l.includes('initializeApp') || l.includes('admin.app')) {
      console.log((i+1) + ': ' + l);
    }
  });
} catch(e) {
  console.log("Error:", e.message);
}
