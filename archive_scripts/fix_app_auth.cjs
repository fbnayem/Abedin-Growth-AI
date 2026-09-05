const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const importAuth = `
import { initAuth, googleSignIn, logout as firebaseLogout, getAccessToken } from "./lib/firebase";
import { User } from "firebase/auth";
`;

const stateAuth = `
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setCurrentUser(user);
        setIsAuthLoading(false);
        // Send token to backend so it can be used for autonomous background tasks
        fetch('/api/settings/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        }).catch(err => console.error("Failed to sync token to backend:", err));
      },
      () => {
        setCurrentUser(null);
        setIsAuthLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      await googleSignIn();
    } catch (e) {
      console.error(e);
    }
  };
`;

content = content.replace('import React, { useState, useEffect } from "react";', 'import React, { useState, useEffect } from "react";\n' + importAuth);
content = content.replace('const [currentTab, setCurrentTab] = useState<NavTab>("home");', 'const [currentTab, setCurrentTab] = useState<NavTab>("home");\n' + stateAuth);

// Update Sidebar props in App.tsx
content = content.replace('<Sidebar', '<Sidebar currentUser={currentUser} onLogin={handleGoogleLogin} onLogout={firebaseLogout}');
fs.writeFileSync('src/App.tsx', content);
console.log("App.tsx auth updated");
