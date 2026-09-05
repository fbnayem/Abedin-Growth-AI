export class AiSecurityService {
  // S. AI SECURITY / RED TEAM TESTS
  sanitizeInboundText(text: string): string {
    if (!text) return "";
    // 1. Strip HTML smuggling
    let sanitized = text.replace(/<[^>]*>?/gm, '');
    
    // 2. Unicode normalization (prevent homoglyph attacks or zalgo text)
    sanitized = sanitized.normalize("NFKC");
    
    // 3. Remove zero-width characters
    sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    return sanitized;
  }

  detectPromptInjection(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    
    const injectionSignatures = [
      "ignore previous instructions",
      "ignore all previous",
      "system prompt",
      "you are now",
      "forget previous",
      "bypass instructions",
      "print instructions",
      "output your instructions"
    ];
    
    return injectionSignatures.some(sig => lower.includes(sig));
  }
}

export const aiSecurityService = new AiSecurityService();
