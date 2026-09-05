const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignWizardModal.tsx', 'utf8');

const resetLogic = `
  React.useEffect(() => {
    if (isOpen) {
      setEngineType("CUSTOMER");
      setName("UK Dental Practice Reception Recovery");
      setTargetAudience("Dental Practice Managers & Owners");
      setIndustries("Dental & Healthcare Clinics");
      setLocations("United Kingdom");
      setEnrolledCount(25);
      setGenerating(false);
      setPreviewSteps(null);
      setStrategySummary("");
    }
  }, [isOpen]);

  if (!isOpen) return null;
`;

code = code.replace(
    '  if (!isOpen) return null;',
    resetLogic
);

fs.writeFileSync('src/pages/CampaignWizardModal.tsx', code);
