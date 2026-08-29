import React, { useState } from "react";
import {
  Building2,
  Search,
  Plus,
  Sparkles,
  PhoneCall,
  Globe,
  Users,
  ExternalLink,
  ChevronRight,
  TrendingUp,
} from "lucide-react";
import { Lead } from "../types";

interface CompaniesViewProps {
  leads: Lead[];
  onSelectCompanyLeads: (companyName: string) => void;
}

export const CompaniesView: React.FC<CompaniesViewProps> = ({
  leads,
  onSelectCompanyLeads,
}) => {
  const [searchQuery, setSearchQuery] = useState("");

  // Group leads into distinct companies
  const companyMap: { [key: string]: { name: string; industry: string; country: string; website: string; leads: Lead[]; employeeCount: string } } = {};

  leads.forEach((l) => {
    if (!companyMap[l.companyName]) {
      companyMap[l.companyName] = {
        name: l.companyName,
        industry: l.industry,
        country: l.country,
        website: l.companyWebsite || "",
        employeeCount: l.employeeCount || "10-50",
        leads: [],
      };
    }
    companyMap[l.companyName].leads.push(l);
  });

  const companies = Object.values(companyMap);

  const filteredCompanies = companies.filter((c) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.industry.toLowerCase().includes(q) ||
        c.country.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-5">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Target Accounts & Companies</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold">
              {companies.length} Accounts
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Account-level organization for multi-contact clinic chains, practices, and organizations.
          </p>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search accounts by company name, industry, region..."
          className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden bg-white font-medium"
        />
      </div>

      {/* Companies Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredCompanies.map((c) => (
          <div
            key={c.name}
            className="p-5 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-sm transition-all space-y-3 flex flex-col justify-between"
          >
            <div className="space-y-2.5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-sm text-slate-900">{c.name}</h3>
                  <div className="text-xs text-blue-600 font-medium">{c.industry}</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-semibold">
                  {c.country}
                </span>
              </div>

              <div className="text-xs text-slate-500 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-slate-400" />
                  <span className="truncate max-w-[200px]">{c.website || "Website on file"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-slate-400" />
                  <span>Scale: {c.employeeCount}</span>
                </div>
                <div className="flex items-center gap-1.5 text-emerald-700 font-medium">
                  <PhoneCall className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Estimated After-Hours Calls: ~15-25/day</span>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                {c.leads.length} Decision Maker{c.leads.length > 1 ? "s" : ""}
              </span>

              <button
                onClick={() => onSelectCompanyLeads(c.name)}
                className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors"
              >
                <span>View Contacts</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
