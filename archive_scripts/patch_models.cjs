const fs = require('fs');
let code = fs.readFileSync('shared/domain/models.ts', 'utf8');

// The file has both `export enum BuyingStage` and `export type BuyingStage`
// Let's replace the `export type BuyingStage` block.
// Wait, I will just rewrite `shared/domain/models.ts` properly or remove the `export type BuyingStage` block.
const blockStart = code.indexOf("export type BuyingStage =");
if (blockStart !== -1) {
    const nextExport = code.indexOf("export", blockStart + 10);
    if (nextExport !== -1) {
        code = code.substring(0, blockStart) + code.substring(nextExport);
    }
}
fs.writeFileSync('shared/domain/models.ts', code);
