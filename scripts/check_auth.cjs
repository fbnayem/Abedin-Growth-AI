const fs = require('fs');

const findAuth = () => {
    // Check if firebase is imported
    const appTsx = fs.readFileSync('src/App.tsx', 'utf8');
    if (appTsx.includes('firebase')) console.log("Firebase is used in App.tsx");
}

findAuth();
