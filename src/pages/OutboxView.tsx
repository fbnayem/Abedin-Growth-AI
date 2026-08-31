import { apiFetch } from '../lib/apiFetch';
import React, { useState, useEffect } from "react";
import { Send, CheckCircle2, XCircle, Clock, ShieldCheck, Mail, RefreshCw } from "lucide-react";

export const OutboxView: React.FC = () => {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOutbox = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/outbox");
      const isJson = res.headers.get("content-type")?.includes("application/json");
      if (!isJson) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setMessages(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOutbox();
  }, []);

  const handleApprove = async (id: string) => {
    try {
      await apiFetch(`/api/outbox/${id}/approve`, { method: "POST" });
      fetchOutbox();
    } catch (e) {
      console.error(e);
    }
  };

  const handleReject = async (id: string) => {
    try {
      await apiFetch(`/api/outbox/${id}/reject`, { method: "POST" });
      fetchOutbox();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Transactional Outbox</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold border border-amber-200 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Human Review Mode
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Intercept, review, and manually approve AI-generated emails before dispatch.
          </p>
        </div>
        <button
          onClick={fetchOutbox}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-600 hover:text-slate-900 transition-colors shadow-2xs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {messages.filter(m => m.status === "HUMAN_REVIEW" || m.status === "PENDING").map((msg) => (
          <div key={msg.id} className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs flex flex-col sm:flex-row gap-4 justify-between">
            <div className="space-y-2 flex-1">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-slate-400" />
                <span className="text-xs font-bold text-slate-900">{msg.to}</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${msg.status === "HUMAN_REVIEW" ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"}`}>
                  {msg.status}
                </span>
              </div>
              <h3 className="text-sm font-bold text-slate-900">{msg.subject}</h3>
              <div className="text-xs text-slate-600 font-mono whitespace-pre-wrap bg-slate-50 p-3 rounded-lg border border-slate-100 line-clamp-3">
                {msg.textBody}
              </div>
            </div>
            
            <div className="flex sm:flex-col items-center justify-end gap-2 pt-2 sm:pt-0">
              <button
                onClick={() => handleApprove(msg.id)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-xs transition-colors w-full justify-center"
              >
                <CheckCircle2 className="w-4 h-4" />
                Approve
              </button>
              <button
                onClick={() => handleReject(msg.id)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition-colors w-full justify-center"
              >
                <XCircle className="w-4 h-4" />
                Reject
              </button>
            </div>
          </div>
        ))}
        {messages.filter(m => m.status === "HUMAN_REVIEW" || m.status === "PENDING").length === 0 && (
          <div className="p-8 text-center bg-white rounded-2xl border border-slate-200 shadow-2xs">
            <ShieldCheck className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <h3 className="text-sm font-bold text-slate-900">Queue is Clear</h3>
            <p className="text-xs text-slate-500 mt-1">No pending automated outbound emails require human intervention.</p>
          </div>
        )}
      </div>
    </div>
  );
};
