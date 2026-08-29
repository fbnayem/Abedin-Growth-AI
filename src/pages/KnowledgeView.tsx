import React, { useState } from "react";
import {
  BookOpen,
  Sparkles,
  Plus,
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  FileText,
  Building,
  Target,
  Edit,
  Save,
} from "lucide-react";
import { CompanyBrain, KnowledgeItem } from "../types";
import { AddKnowledgeModal } from "../components/AddKnowledgeModal";

interface KnowledgeViewProps {
  brain: CompanyBrain;
  knowledgeItems: KnowledgeItem[];
  onUpdateBrain: (updated: CompanyBrain) => void;
  onAddKnowledgeItem: (item: KnowledgeItem) => void;
}

export const KnowledgeView: React.FC<KnowledgeViewProps> = ({
  brain,
  knowledgeItems,
  onUpdateBrain,
  onAddKnowledgeItem,
}) => {
  const [activeTab, setActiveTab] = useState<"brain" | "docs">("brain");
  const [editingBrain, setEditingBrain] = useState(false);
  const [tagline, setTagline] = useState(brain.tagline || "");
  const [pricingOverview, setPricingOverview] = useState(brain.pricingOverview || "");
  const [isAddDocOpen, setIsAddDocOpen] = useState(false);

  const handleSaveBrain = () => {
    onUpdateBrain({
      ...brain,
      tagline,
      pricingOverview,
    });
    setEditingBrain(false);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Company Brain & Knowledge</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold">
              AI Grounding Core
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            The single source of truth used by all Gemini agents to generate accurate, non-hallucinatory outreach.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {activeTab === "brain" ? (
            <button
              onClick={() => {
                if (editingBrain) handleSaveBrain();
                else setEditingBrain(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors"
            >
              {editingBrain ? (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Brain</span>
                </>
              ) : (
                <>
                  <Edit className="w-3.5 h-3.5" />
                  <span>Edit Brain</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={() => setIsAddDocOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Document</span>
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 text-xs font-semibold">
        <button
          onClick={() => setActiveTab("brain")}
          className={`py-2 px-3 border-b-2 transition-colors ${
            activeTab === "brain"
              ? "border-blue-600 text-blue-600 font-bold"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          Company Brain (Strategic Model)
        </button>
        <button
          onClick={() => setActiveTab("docs")}
          className={`py-2 px-3 border-b-2 transition-colors ${
            activeTab === "docs"
              ? "border-blue-600 text-blue-600 font-bold"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          Knowledge Base Documents ({knowledgeItems.length})
        </button>
      </div>

      {/* Brain View */}
      {activeTab === "brain" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Card 1: Core Value Proposition */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 text-blue-600 font-bold text-xs uppercase tracking-wider">
              <Sparkles className="w-4 h-4" />
              <span>Core Value Proposition</span>
            </div>

            <div>
              <div className="text-xs font-bold text-slate-700 mb-1">Company Tagline</div>
              {editingBrain ? (
                <input
                  type="text"
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                />
              ) : (
                <p className="text-xs text-slate-900 font-semibold">{brain.tagline}</p>
              )}
            </div>

            <div className="space-y-1">
              <div className="text-xs font-bold text-slate-700">Primary Benefits</div>
              <ul className="space-y-1">
                {(brain.primaryBenefits || []).map((b, i) => (
                  <li key={i} className="text-xs text-slate-600 flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Card 2: Target ICP & Personas */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 text-indigo-600 font-bold text-xs uppercase tracking-wider">
              <Target className="w-4 h-4" />
              <span>Ideal Customer Profile (ICP)</span>
            </div>

            <div className="space-y-1 text-xs">
              <div className="text-slate-500 font-medium">Target Industries:</div>
              <div className="flex flex-wrap gap-1">
                {(brain.targetIndustries || []).map((ind, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold border border-blue-100"
                  >
                    {ind}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-1 text-xs">
              <div className="text-slate-500 font-medium">Key Buyer Personas:</div>
              <ul className="list-disc pl-4 space-y-0.5 text-slate-700">
                {(brain.targetPersonas || []).map((p, i) => (
                  <li key={i}>{p.title} — Focus: {p.primaryGoal || (p as any).painPoint || "Operational efficiency"}</li>
                ))}
              </ul>
            </div>
          </div>

          {/* Card 3: Objection Handling Matrix */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3 md:col-span-2">
            <div className="flex items-center gap-2 text-purple-600 font-bold text-xs uppercase tracking-wider">
              <ShieldCheck className="w-4 h-4" />
              <span>Objection Handling Playbook</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(brain.objectionsHandling || (brain as any).objectionsAndAnswers || []).map((obj: any, i: number) => (
                <div
                  key={i}
                  className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1 text-xs"
                >
                  <div className="font-bold text-rose-800">&quot;{obj.objection}&quot;</div>
                  <div className="text-slate-700 leading-relaxed font-sans">{obj.counterAngle || obj.recommendedResponse || obj.answer}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* Docs View */
        <div className="space-y-3">
          {(!knowledgeItems || knowledgeItems.length === 0) ? (
            <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-3">
              <FileText className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="text-sm font-bold text-slate-800">No Knowledge Documents Yet</div>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Add case studies, objection rebuttals, SLAs, or product brochures for AI grounding.
              </p>
              <button
                onClick={() => setIsAddDocOpen(true)}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-sm inline-flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Knowledge Document</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {knowledgeItems.map((doc) => (
                <div
                  key={doc.id}
                  className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs space-y-2 flex flex-col justify-between"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-slate-100 text-slate-700">
                        {doc.category}
                      </span>
                      {doc.approvedForAI ? (
                        <span className="text-[10px] text-emerald-700 font-semibold flex items-center gap-0.5">
                          <CheckCircle2 className="w-3 h-3" /> AI Grounded
                        </span>
                      ) : (
                        <span className="text-[10px] text-amber-700 font-semibold flex items-center gap-0.5">
                          <ShieldAlert className="w-3 h-3" /> Excluded
                        </span>
                      )}
                    </div>

                    <h4 className="text-xs font-bold text-slate-900">{doc.title}</h4>
                    <p className="text-xs text-slate-600 line-clamp-3 leading-relaxed">
                      {doc.content}
                    </p>
                  </div>

                  <div className="text-[10px] text-slate-400 pt-2 border-t border-slate-100">
                    Source: {doc.source}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Knowledge Modal */}
      <AddKnowledgeModal
        isOpen={isAddDocOpen}
        onClose={() => setIsAddDocOpen(false)}
        onKnowledgeCreated={(newItem) => {
          onAddKnowledgeItem(newItem);
        }}
      />
    </div>
  );
};
