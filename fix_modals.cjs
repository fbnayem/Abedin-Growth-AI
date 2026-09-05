const fs = require('fs');
const path = require('path');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes('if (!isOpen) return null;')) return;
  if (content.includes('React.useEffect(() => {') && content.includes('if (isOpen) {') && !filePath.includes('CampaignWizardModal.tsx')) {
      // already processed
      return;
  }
  if (filePath.includes('CampaignWizardModal.tsx')) return; // already manually fixed

  console.log('Processing', filePath);

  // Find all useState declarations
  const stateRegex = /const \[([a-zA-Z0-9_]+),\s*set([a-zA-Z0-9_]+)\]\s*=\s*useState(?:<[^>]+>)?\((.*?)\);/g;
  let match;
  let resetStatements = [];

  while ((match = stateRegex.exec(content)) !== null) {
    const setter = 'set' + match[2];
    let initialValue = match[3];
    // if initialValue is empty (e.g. useState<User | null>()), default to undefined/null
    if (!initialValue || initialValue.trim() === '') {
       if (content.includes(`useState<`) && match[0].includes(`| null>`)) {
           initialValue = 'null';
       } else {
           initialValue = 'undefined';
       }
    }
    resetStatements.push(`      ${setter}(${initialValue});`);
  }

  if (resetStatements.length > 0) {
    const resetLogic = `
  React.useEffect(() => {
    if (isOpen) {
${resetStatements.join('\n')}
    }
  }, [isOpen]);

  if (!isOpen) return null;`;
    
    content = content.replace('  if (!isOpen) return null;', resetLogic);
    fs.writeFileSync(filePath, content);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath);
    } else if (fullPath.endsWith('.tsx')) {
      processFile(fullPath);
    }
  }
}

walkDir('src/components');
walkDir('src/pages');
console.log('Done!');
