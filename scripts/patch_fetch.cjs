const fs = require('fs');

let mainTsx = fs.readFileSync('src/main.tsx', 'utf8');
if (!mainTsx.includes('window.fetch = async')) {
    const patch = `
import { getFirebaseIdToken } from './lib/firebase';
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  let [resource, config] = args;
  if (typeof resource === 'string' && resource.startsWith('/api')) {
    const token = await getFirebaseIdToken();
    if (token) {
      config = config || {};
      config.headers = {
        ...config.headers,
        'Authorization': \`Bearer \${token}\`
      };
    }
  }
  return originalFetch(resource, config);
};
`;
    mainTsx = mainTsx.replace("import App from './App.tsx';", patch + "\nimport App from './App.tsx';");
    fs.writeFileSync('src/main.tsx', mainTsx);
    console.log("Patched window.fetch in main.tsx");
} else {
    console.log("Already patched");
}
