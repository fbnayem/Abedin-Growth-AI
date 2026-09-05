const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// 1. Remove all require('firebase/firestore')
code = code.replace(/const\s+\{\s*[^}]+\s*\}\s*=\s*require\('firebase\/firestore'\);\s*/g, '');

// 2. Replace dynamic requires with nothing, we will add top level imports
code = code.replace(/const\s+\{\s*processGrowthCommand\s*\}\s*=\s*require\('\.\/server\/agents\/growthCommandAgent'\);\s*/g, '');
code = code.replace(/const\s+\{\s*simulatePitchBattle\s*\}\s*=\s*require\('\.\/server\/agents\/pitchBattleAgent'\);\s*/g, '');
code = code.replace(/const\s+\{\s*generateCompanyBrain\s*\}\s*=\s*require\('\.\/server\/agents\/companyBrainAgent'\);\s*/g, '');
code = code.replace(/const\s+\{\s*gmailHistorySyncService\s*\}\s*=\s*require\('\.\/server\/services\/gmailHistorySync\.service'\);\s*/g, '');

// 3. Fix the circuitBreaker ones (around line 579-583)
// enabled: require('./server/agents/salesDecisionEngine.ts').circuitBreaker.globalAutonomousSendEnabled,
// reason: require('./server/agents/salesDecisionEngine.ts').circuitBreaker.pausedReason
code = code.replace(/require\('\.\/server\/agents\/salesDecisionEngine\.ts'\)\.circuitBreaker/g, 'circuitBreaker');

// Add missing top level imports
const importsToAdd = `
import { processGrowthCommand } from './server/agents/growthCommandAgent';
import { simulatePitchBattle } from './server/agents/pitchBattleAgent';
import { generateCompanyBrain } from './server/agents/companyBrainAgent';
import { gmailHistorySyncService } from './server/services/gmailHistorySync.service';
`;

// Just insert them after the first group of imports
code = code.replace('import express, { Request, Response } from "express";', importsToAdd + 'import express, { Request, Response } from "express";');

fs.writeFileSync('server.ts', code);
