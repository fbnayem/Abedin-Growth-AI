const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignWizardModal.tsx', 'utf8');

// Import Split
code = code.replace(
  '  Linkedin,\n  Phone,\n} from "lucide-react";',
  '  Linkedin,\n  Phone,\n  Split\n} from "lucide-react";'
);

// Add State
code = code.replace(
  'const [projectedMetrics, setProjectedMetrics] = useState<{ reach: number; engagement: number; conversion: number; } | null>(null);',
  'const [projectedMetrics, setProjectedMetrics] = useState<{ reach: number; engagement: number; conversion: number; } | null>(null);\n  const [isABTestingEnabled, setIsABTestingEnabled] = useState(false);'
);

// Reset State
code = code.replace(
  'setProjectedMetrics(null);\n    }',
  'setProjectedMetrics(null);\n      setIsABTestingEnabled(false);\n    }'
);

// Add to body
code = code.replace(
  '          enrolledCount,\n        }),',
  '          enrolledCount,\n          isABTestingEnabled,\n        }),'
);

fs.writeFileSync('src/pages/CampaignWizardModal.tsx', code);
