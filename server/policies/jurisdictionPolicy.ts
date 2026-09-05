export interface JurisdictionPolicy {
  allowColdOutreach: boolean;
  requiresDoubleOptIn: boolean;
  maxTouchpointsPerMonth: number;
}

export function getPolicyForCountry(countryCode: string): JurisdictionPolicy {
  switch (countryCode.toUpperCase()) {
    case 'DE':
    case 'FR':
    case 'EU': // General GDPR strict
      return {
        allowColdOutreach: false,
        requiresDoubleOptIn: true,
        maxTouchpointsPerMonth: 2
      };
    case 'US': // CAN-SPAM (more relaxed)
      return {
        allowColdOutreach: true,
        requiresDoubleOptIn: false,
        maxTouchpointsPerMonth: 8
      };
    case 'UK': // UK GDPR & PECR
    case 'GB':
      return {
        allowColdOutreach: false, // B2C is false, B2B is generally true but for safety we mock
        requiresDoubleOptIn: false,
        maxTouchpointsPerMonth: 4
      };
    default:
      return {
        allowColdOutreach: false,
        requiresDoubleOptIn: true,
        maxTouchpointsPerMonth: 1
      };
  }
}
