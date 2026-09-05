const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  "import { collection, getDocs, addDoc, doc, setDoc, updateDoc, query, where } from 'firebase/firestore';",
  "import { collection, getDocs, getDoc, addDoc, doc, setDoc, updateDoc, query, where, orderBy, limit } from 'firebase/firestore';"
);

fs.writeFileSync('server.ts', code);
