const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignWizardModal.tsx', 'utf8');

code = code.replace(
  'const [name, setName] = useState("UK Dental Practice Reception Recovery");',
  'const [name, setName] = useState("");'
);

code = code.replace(
  'const [targetAudience, setTargetAudience] = useState("Dental Practice Managers & Owners");',
  'const [targetAudience, setTargetAudience] = useState("");'
);

code = code.replace(
  'const [industries, setIndustries] = useState("Dental & Healthcare Clinics");',
  'const [industries, setIndustries] = useState("");'
);

code = code.replace(
  'const [locations, setLocations] = useState("United Kingdom");',
  'const [locations, setLocations] = useState("");'
);

code = code.replace(
  'setName("UK Dental Practice Reception Recovery");',
  'setName("");'
);

code = code.replace(
  'setTargetAudience("Dental Practice Managers & Owners");',
  'setTargetAudience("");'
);

code = code.replace(
  'setIndustries("Dental & Healthcare Clinics");',
  'setIndustries("");'
);

code = code.replace(
  'setLocations("United Kingdom");',
  'setLocations("");'
);

fs.writeFileSync('src/pages/CampaignWizardModal.tsx', code);
