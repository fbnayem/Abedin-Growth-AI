import React, { useState } from "react";
import { X, BookOpen, Sparkles, FileText, CheckCircle2, ShieldAlert, Plus, Loader2 } from "lucide-react";
import { KnowledgeItem, KnowledgeCategory } from "../types";

interface AddKnowledgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onKnowledgeCreated: (item: KnowledgeItem) => void;
}

export const AddKnowledgeModal: React.FC<AddKnowledgeModalProps> = ({
  isOpen,
  onClose,
  onKnowledgeCreated,
}) => {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<KnowledgeCategory>("PRODUCT");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("Manual Documentation");
  const [approvedForAI, setApprovedForAI] = useState(true);
  const [isSensitive, setIsSensitive] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          category,
          content,
          source: source || "Knowledge Base",
          approvedForAI,
          isSensitive,
        }),
      });

      if (!res.ok) throw new Error("Failed to add knowledge document");
      const newItem = await res.json();
      onKnowledgeCreated(newItem);
      onClose();
      // Reset form
      setTitle("");
      setContent("");
      setSource("Manual Documentation");
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Add Knowledge Document</h3>
              <p className="text-xs text-slate-400">Ground Gemini AI agents with official facts & guidelines</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Document Title <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Healthcare Voice AI SLA & HIPAA Compliance"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Knowledge Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as KnowledgeCategory)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-blue-500 outline-hidden"
              >
                <option value="PRODUCT">Product & Core Value</option>
                <option value="FEATURES">Features & Capabilities</option>
                <option value="PRICING">Pricing & Commercials</option>
                <option value="INTEGRATIONS">Integrations & Workflows</option>
                <option value="SALES">Sales Angles & Scripts</option>
                <option value="OBJECTIONS">Objections & Rebuttals</option>
                <option value="CUSTOMER_STORIES">Customer Stories & Proof</option>
                <option value="INVESTOR">Investor & Deck Context</option>
                <option value="FINANCIAL">Unit Economics & Financials</option>
                <option value="LEGAL">Compliance & Legal</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">
              Document Content / Guidelines <span className="text-rose-500">*</span>
            </label>
            <textarea
              required
              rows={4}
              placeholder="Provide exact facts, numbers, feature descriptions, or objection rebuttals for AI reference..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden resize-none"
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Source Reference</label>
            <input
              type="text"
              placeholder="e.g. Abedin Tech Whitepaper 2026 / Sales Enablement Deck"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
            />
          </div>

          <div className="flex items-center gap-4 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={approvedForAI}
                onChange={(e) => setApprovedForAI(e.target.checked)}
                className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300"
              />
              <span className="font-semibold text-slate-700">Approved for AI Grounding</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isSensitive}
                onChange={(e) => setIsSensitive(e.target.checked)}
                className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 border-slate-300"
              />
              <span className="font-semibold text-slate-700">Requires Founder Approval to Share</span>
            </label>
          </div>

          {/* Footer */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title || !content}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Adding Document...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Document</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
