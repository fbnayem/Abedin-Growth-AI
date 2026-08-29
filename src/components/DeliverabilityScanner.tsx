import React, { useState } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Flame,
  FileCheck,
  Send,
  Loader2,
  Sparkles,
  Smartphone,
  Eye
} from "lucide-react";

interface DeliverabilityScannerProps {
  subject: string;
  body: string;
  onApplyOptimization?: (optimizedBody: string) => void;
}

const SPAM_TRIGGER_WORDS = [
  "guaranteed",
  "100% free",
  "risk-free",
  "act now",
  "buy direct",
  "winner",
  "cash bonus",
  "no cost",
  "urgent",
  "make money",
  "cheap",
  "click here",
  "double your",
];

export const DeliverabilityScanner: React.FC<DeliverabilityScannerProps> = ({
  subject,
  body,
  onApplyOptimization,
}) => {
  const combinedText = `${subject} ${body}`.toLowerCase();

  // Find spam triggers
  const detectedSpamWords = SPAM_TRIGGER_WORDS.filter((word) =>
    combinedText.includes(word.toLowerCase())
  );

  // Character & Word metrics
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
  const charCount = body.length;
  const isTooLong = wordCount > 140; // Cold outbound ideal is 50-125 words
  const isTooShort = wordCount < 20;

  // Grade level estimate (Flesch-Kincaid proxy)
  const sentences = body.split(/[.!?]+/).filter(Boolean).length || 1;
  const avgWordsPerSentence = wordCount / sentences;
  const readabilityGrade = avgWordsPerSentence < 12 ? "Grade 5 (Optimal Cold Outbound)" : "Grade 9+ (Consider simplifying)";

  // Mobile preview check
  const hasGreeting = /^(hi|hey|hello|dear)/i.test(body.trim());
  const hasClearCTA = /[?]/g.test(body);

  // Overall Health Score calculation
  let deliverabilityScore = 100;
  if (detectedSpamWords.length > 0) deliverabilityScore -= detectedSpamWords.length * 15;
  if (isTooLong) deliverabilityScore -= 20;
  if (!hasClearCTA) deliverabilityScore -= 15;
  if (subject.length > 60) deliverabilityScore -= 10;
  deliverabilityScore = Math.max(deliverabilityScore, 20);

  const getScoreColor = () => {
    if (deliverabilityScore >= 85) return "text-emerald-600 bg-emerald-50 border-emerald-200";
    if (deliverabilityScore >= 65) return "text-amber-600 bg-amber-50 border-amber-200";
    return "text-rose-600 bg-rose-50 border-rose-200";
  };

  const handleCleanEmail = () => {
    let clean = body;
    detectedSpamWords.forEach((word) => {
      const regex = new RegExp(word, "gi");
      clean = clean.replace(regex, "verified");
    });
    if (onApplyOptimization) {
      onApplyOptimization(clean);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 shadow-2xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-lg border font-bold text-xs flex items-center gap-1.5 ${getScoreColor()}`}>
            {deliverabilityScore >= 80 ? (
              <ShieldCheck className="w-4 h-4" />
            ) : (
              <ShieldAlert className="w-4 h-4" />
            )}
            <span>Deliverability & Inbox Health: {deliverabilityScore}/100</span>
          </div>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-slate-500 font-medium">
          <span>{wordCount} words (ideal 60-120)</span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Smartphone className="w-3 h-3 text-slate-400" />
            {charCount < 450 ? "Mobile Optimized" : "May Clip on Mobile"}
          </span>
        </div>
      </div>

      {/* Issues list or clean badge */}
      {detectedSpamWords.length > 0 ? (
        <div className="p-3 bg-rose-50/80 rounded-lg border border-rose-200 text-xs text-rose-950 space-y-1.5">
          <div className="font-bold flex items-center justify-between">
            <span className="flex items-center gap-1 text-rose-900">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
              Spam Trigger Words Detected ({detectedSpamWords.length}):
            </span>
            <button
              onClick={handleCleanEmail}
              className="text-[10px] font-bold text-rose-700 hover:text-rose-900 underline"
            >
              Auto-Replace
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {detectedSpamWords.map((word, idx) => (
              <span
                key={idx}
                className="px-2 py-0.5 rounded-md bg-rose-200/80 text-rose-900 font-mono text-[10px] font-bold"
              >
                &quot;{word}&quot;
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-2.5 bg-emerald-50/80 rounded-lg border border-emerald-200 text-[11px] text-emerald-900 flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            Zero spam keywords detected. Optimal inbox primary delivery expected.
          </span>
          <span className="text-[10px] font-bold text-emerald-800">{readabilityGrade}</span>
        </div>
      )}
    </div>
  );
};
