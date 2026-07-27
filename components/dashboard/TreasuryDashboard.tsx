"use client";

import React, { useState, useEffect } from "react";
import {
  Vault,
  TrendingUp,
  ShieldCheck,
  Building2,
  ArrowUpRight,
  RefreshCw,
  PieChart,
  CheckCircle2,
  DollarSign,
} from "lucide-react";

interface HistoryRecord {
  id: number;
  timestamp: string;
  asset: string;
  insuranceAmount: number;
  daoAmount: number;
  status: string;
  txHash: string;
}

interface TreasuryData {
  currentBalance: number;
  totalCollected: number;
  totalDistributedInsurance: number;
  totalDistributedDao: number;
  rules: {
    insuranceShareBps: number;
    daoShareBps: number;
  };
  asset: string;
  history: HistoryRecord[];
}

export function TreasuryDashboard() {
  const [data, setData] = useState<TreasuryData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchTreasuryData = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/treasury");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error("Failed to fetch treasury data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTreasuryData();
  }, []);

  const handleAction = async (actionType: "collect" | "distribute") => {
    try {
      setActionLoading(actionType);
      setMessage(null);
      const res = await fetch("/api/treasury", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionType }),
      });
      const result = await res.json();
      if (res.ok) {
        setData(result.data);
        setMessage(result.message);
      } else {
        setMessage(result.error || "Action failed");
      }
    } catch (err) {
      setMessage("Failed to execute action");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" />
        Loading Protocol Treasury Metrics...
      </div>
    );
  }

  const currentBalance = data?.currentBalance ?? 0;
  const totalCollected = data?.totalCollected ?? 0;
  const totalInsurance = data?.totalDistributedInsurance ?? 0;
  const totalDao = data?.totalDistributedDao ?? 0;
  const insurancePct = ((data?.rules.insuranceShareBps ?? 5000) / 100).toFixed(0);
  const daoPct = ((data?.rules.daoShareBps ?? 5000) / 100).toFixed(0);

  return (
    <div className="space-y-8 p-6 bg-slate-900 text-slate-100 rounded-2xl border border-slate-800 shadow-xl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
              <Vault className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Protocol Treasury & Fee Strategy
              </h1>
              <p className="text-sm text-slate-400">
                Automated protocol fee management and 50/50 fund distribution
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleAction("collect")}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-xl transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50"
          >
            {actionLoading === "collect" ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <TrendingUp className="w-4 h-4" />
            )}
            Collect Pool Fees
          </button>

          <button
            onClick={() => handleAction("distribute")}
            disabled={!!actionLoading || currentBalance <= 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm rounded-xl transition-all shadow-lg shadow-emerald-600/20 disabled:opacity-50"
          >
            {actionLoading === "distribute" ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <ArrowUpRight className="w-4 h-4" />
            )}
            Distribute Treasury (50/50)
          </button>
        </div>
      </div>

      {/* Action Notification Alert */}
      {message && (
        <div className="flex items-center gap-2 p-4 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm rounded-xl">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      {/* Metrics Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50 space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span>Treasury Balance</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-extrabold text-white">
            ${currentBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </div>
          <p className="text-xs text-slate-400">Available for distribution</p>
        </div>

        <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50 space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span>Total Fees Collected</span>
            <TrendingUp className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-2xl font-extrabold text-white">
            ${totalCollected.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </div>
          <p className="text-xs text-slate-400">Cumulative lending protocol fees</p>
        </div>

        <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50 space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span>Insurance Fund ({insurancePct}%)</span>
            <ShieldCheck className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-extrabold text-white">
            ${totalInsurance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </div>
          <p className="text-xs text-slate-400">Distributed to liquidation insurance</p>
        </div>

        <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50 space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span>DAO Governance ({daoPct}%)</span>
            <Building2 className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-extrabold text-white">
            ${totalDao.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </div>
          <p className="text-xs text-slate-400">Distributed to DAO treasury</p>
        </div>
      </div>

      {/* Treasury Distribution Strategy Breakdown */}
      <div className="p-6 bg-slate-800/40 rounded-xl border border-slate-700/60 space-y-4">
        <div className="flex items-center gap-2 text-white font-semibold text-lg">
          <PieChart className="w-5 h-5 text-indigo-400" />
          <h2>Automated Treasury Distribution Strategy</h2>
        </div>
        <p className="text-sm text-slate-300">
          Protocol platform fees are automatically collected and distributed according to fixed on-chain rules:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-slate-900/80 rounded-xl border border-blue-500/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 font-bold text-sm">
                50%
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Insurance Fund</h3>
                <p className="text-xs text-slate-400">Covers default payouts & bad debt protection</p>
              </div>
            </div>
            <ShieldCheck className="w-5 h-5 text-blue-400" />
          </div>

          <div className="p-4 bg-slate-900/80 rounded-xl border border-purple-500/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 font-bold text-sm">
                50%
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">DAO Governance Treasury</h3>
                <p className="text-xs text-slate-400">Allocated to token holders & protocol reserves</p>
              </div>
            </div>
            <Building2 className="w-5 h-5 text-purple-400" />
          </div>
        </div>
      </div>

      {/* Historical Distributions Log Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Historical Distribution Log</h2>
          <span className="text-xs text-slate-400">
            {data?.history.length ?? 0} Recorded Distributions
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-800/80 text-xs uppercase text-slate-400 tracking-wider">
              <tr>
                <th className="p-3.5">ID</th>
                <th className="p-3.5">Date</th>
                <th className="p-3.5">Asset</th>
                <th className="p-3.5">Insurance Payout (50%)</th>
                <th className="p-3.5">DAO Payout (50%)</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5">Tx Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900/50">
              {data?.history && data.history.length > 0 ? (
                data.history.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="p-3.5 font-mono text-xs text-slate-400">#{item.id}</td>
                    <td className="p-3.5 text-xs text-slate-300">
                      {new Date(item.timestamp).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="p-3.5 font-semibold text-white">{item.asset}</td>
                    <td className="p-3.5 text-blue-400 font-mono">
                      +${item.insuranceAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5 text-purple-400 font-mono">
                      +${item.daoAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3.5">
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {item.status}
                      </span>
                    </td>
                    <td className="p-3.5 font-mono text-xs text-slate-400">
                      <span className="hover:text-indigo-400 cursor-pointer">{item.txHash}</span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500 text-sm">
                    No distributions recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
