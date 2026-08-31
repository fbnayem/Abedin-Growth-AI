const fs = require('fs');
let code = fs.readFileSync('src/lib/firebase.ts', 'utf8');

// We need to add an export for `getFirebaseIdToken`
if (!code.includes('getFirebaseIdToken')) {
    code += `\nexport const getFirebaseIdToken = async (): Promise<string | null> => {
  const user = auth.currentUser;
  if (user) {
    return await user.getIdToken();
  }
  return null;
};\n`;
    fs.writeFileSync('src/lib/firebase.ts', code);
    console.log("Added getFirebaseIdToken to firebase.ts");
}
