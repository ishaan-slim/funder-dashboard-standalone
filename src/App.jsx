import React, { useState, useMemo, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend, Cell } from "recharts";
import { Upload, ChevronDown, ChevronRight, Filter, X, Users, Clock, TrendingDown, TrendingUp, AlertCircle } from "lucide-react";

// ---------- Stage reference tables ----------
const STAGES_TRACK_1 = [
  ["01","Logged Deal"],["02","Awaiting Signed Application"],["05","Additional Information Requested"],
  ["10","Assigned to Credit"],["11","Credit Reviewed"],["12","Credit Committee"],["15","Price Proposal Quote"],
  ["18","Negotiation"],["19","Terms Rejected"],["20","Accepted Terms"],["22","Generate Disclosure"],
  ["30","Interview"],["40","Formal Valuation"],["50","Final Review"],["60","Terms Accepted"],
  ["70","Docs Requested"],["72","Docs Generated"],["74","Docs Out"],["76","Docs In"],["80","Funding"],
  ["85","Funding Booked"],["90","Closed/Won"],["98","Cancelled"],["99","Declined"],
];
const STAGES_TRACK_2 = [
  ["101","Logged Deal"],["105","Additional Information Requested"],["110","Pending Review"],
  ["120","Submitted to Source"],["125","Submitted to Real Estate Lender"],["130","Additional Information Requested"],
  ["135","Term Sheet Presented"],["140","Credit Decision"],["150","Present Approval Terms"],["155","Negotiate"],
  ["159","Terms Rejected"],["160","Terms Accepted"],["162","Generate Disclosure"],["165","Final Review / Valuations"],
  ["170","Docs Requested"],["171","Docs Generated"],["174","Docs Out"],["176","Docs In"],
  ["180","Submitted to Funding"],["185","Funded/Booked"],["190","Closed/Won"],["198","Cancelled/Dead"],["199","Declined"],
];
const ALL_STAGES = [...STAGES_TRACK_1, ...STAGES_TRACK_2];
const STAGE_LABEL = Object.fromEntries(ALL_STAGES.map(([c, n]) => [c, `${c} - ${n}`]));
const TERMINAL_NEGATIVE = new Set(["19","98","99","159","198","199"]);
const DECLINE_STAGES = new Set(["99", "199"]);
// "Funded" = reached 85/185 (Funding Booked / Funded-Booked) OR the formal
// Closed/Won stage 90/190. Both count toward the funded KPI; 90/190 is a
// stricter subset for deals that have also been fully closed out.
const FUNDED_STAGES = new Set(["85","185","90","190"]);
const CLOSED_WON_STAGES = new Set(["90","190"]);
const TERMINAL_POSITIVE = FUNDED_STAGES; // any deal that reached funding is "terminal" for open/closed purposes
const FUNDER_ASSIGN_STAGE = { "1": "76", "2": "176" };

// Key transitions for the INFERRED attribution model: for each, we track how
// long a deal sat in fromStage before someone's edit moved it to toStage,
// and credit that duration to whoever made that edit (ChangedBy).
// "toAny: true" means: match ANY next stage change out of fromStage (not a
// fixed destination) -- used for "Assigned to Credit -> action taken", since
// the next move could be approval, decline, or anything else. Both stage
// tracks (10 vs 110) are combined into one person-level KPI, not split.
// Docs and funding-side stages should never appear as a destination out of
// Assigned to Credit -- a deal never moves directly from credit review into
// documents, funding, or closed. Any such row in the data is an anomaly
// (bulk edit, correction), not a real workflow step, so it's excluded.
const CREDIT_ACTION_EXCLUDED_DESTINATIONS = [
  "70","170","72","171","74","174","76","176", // docs
  "80","180","85","185", // funding
  "90","190", // closed/won
];

const KEY_TRANSITIONS = [
  { id: "credit-action-taken", fromStages: ["10", "110"], toAny: true, excludeToStages: CREDIT_ACTION_EXCLUDED_DESTINATIONS, label: "Assigned to Credit → Action Taken" },
  { id: "docs-req-to-out", fromStages: ["70", "170"], toAny: false, toStages: ["74", "174"], label: "Docs Requested → Docs Out" },
  { id: "source-to-approved", fromStages: ["120", "130", "135"], toAny: false, toStages: ["150"], label: "Submitted to Source → Approved" },
];


// Classifies each possible destination stage (out of Assigned to Credit) by
// what KIND of outcome it represents, purely for coloring/grouping in the UI.
// This is presentation-only context, not a change to any KPI math.
const OUTCOME_TYPE = {
  // approval-track: moving the deal forward toward funding
  "11": "approval", "12": "approval", "15": "approval", "18": "approval", "20": "approval", "22": "approval",
  "120": "approval", "125": "approval", "135": "approval", "140": "approval", "150": "approval", "155": "approval", "160": "approval", "162": "approval",
  // decline: deal was turned down
  "99": "decline", "199": "decline",
  // cancelled: deal was withdrawn/dead, not a credit decision
  "98": "cancelled", "198": "cancelled",
  // more info needed: sent back for additional information
  "05": "info", "105": "info", "130": "info",
};
const OUTCOME_STYLES = {
  approval: { bg: "#E6F4EA", text: "#1E7A3D", label: "Approval track" },
  decline: { bg: "#FCEAEA", text: "#B3261E", label: "Decline" },
  cancelled: { bg: "#F1F0EE", text: "#6B6257", label: "Cancelled" },
  info: { bg: "#FEF6E0", text: "#8A6D1D", label: "More info requested" },
  other: { bg: "#EEF0F3", text: "#4B5563", label: "Other" },
};
function outcomeTypeOf(stageCode) {
  return OUTCOME_TYPE[String(stageCode)] || "other";
}
// Stages where hitting them more than once on the same deal means it was
// submitted to multiple lenders/sources -- worth flagging distinctly.
const MULTI_SUBMISSION_STAGES = new Set(["120", "125"]);


// Only these people's edits count toward the inferred model -- everyone else
// (sales staff, admins, etc.) is excluded entirely, not just de-emphasized.
const UNDERWRITER_WHITELIST = ["Javier Mendoza", "Jay Cristobal", "Shervin Rashti"];



function trackOf(stageCode) {
  return String(stageCode).length >= 3 ? "2" : "1";
}
function stageOrderIndex(stageCode) {
  const track = trackOf(stageCode);
  const list = track === "2" ? STAGES_TRACK_2 : STAGES_TRACK_1;
  return list.findIndex(([c]) => c === String(stageCode));
}

// ---------- Sample data generator ----------
function generateSampleData() {
  const funders = ["Dana Whitfield", "Marcus Cole", "Priya Anand", "Sam Ortiz", "Elena Voss"];
  const staff = ["Javier Mendoza", "Jay Cristobal", "Shervin Rashti", "Ishaan Hussain", "Casey Nolan"];
  const opps = [];
  let id = 1000;
  const now = new Date("2026-08-11T12:00:00Z").getTime();
  const DAY = 86400000;

  function buildTimeline(track, startTs, funderName, outcome) {
    const list = track === "2" ? STAGES_TRACK_2 : STAGES_TRACK_1;
    const assignStage = FUNDER_ASSIGN_STAGE[track];
    const mainPath = list.filter(([c]) => !TERMINAL_NEGATIVE.has(c) && !TERMINAL_POSITIVE.has(c)).map(([c]) => c);
    const assignIdx = mainPath.indexOf(assignStage);
    let path = mainPath.slice();
    let cutIdx = path.length;
    if (outcome === "cancelled") {
      cutIdx = Math.max(1, Math.floor(Math.random() * path.length));
      path = path.slice(0, cutIdx);
      path.push(track === "2" ? "198" : "98");
    } else if (outcome === "declined") {
      cutIdx = Math.max(1, Math.floor(Math.random() * path.length));
      path = path.slice(0, cutIdx);
      path.push(track === "2" ? "199" : "99");
    } else {
      path.push(track === "2" ? "190" : "90");
    }

    const stageHistory = [];
    const funderHistory = [];
    let ts = startTs;
    let funderSet = false;
    for (let i = 0; i < path.length; i++) {
      const stage = path[i];
      // duration in this stage before moving on (except last)
      const changedBy = i === 0 ? null : staff[Math.floor(Math.random() * staff.length)];
      stageHistory.push({ stage, timestamp: ts, changedBy });
      const isAssignPoint = stage === assignStage;
      if (isAssignPoint && !funderSet && (outcome !== "cancelled" && outcome !== "declined" || cutIdx > assignIdx)) {
        funderHistory.push({ funder: funderName, timestamp: ts });
        funderSet = true;
      }
      // random stage duration: origination stages faster, post-assignment slower with variance
      const base = i < assignIdx ? 1.5 : 3;
      const dur = Math.max(0.2, base + (Math.random() - 0.3) * base * 1.8);
      ts += dur * DAY;
    }
    return { stageHistory, funderHistory, endTs: ts };
  }

  for (let i = 0; i < 260; i++) {
    const track = Math.random() < 0.6 ? "1" : "2";
    const startTs = now - (Math.random() * 300 + 5) * DAY;
    const roll = Math.random();
    const outcome = roll < 0.12 ? "cancelled" : roll < 0.20 ? "declined" : "won";
    const funderName = funders[Math.floor(Math.random() * funders.length)];
    const { stageHistory, funderHistory } = buildTimeline(track, startTs, funderName, outcome);
    id += 1;
    opps.push({
      id: `OPP-${id}`,
      name: `Deal ${id}`,
      track,
      createdDate: startTs,
      stageHistory,
      funderHistory,
    });
  }
  return opps;
}

// ---------- Derivation engine ----------
function deriveDeals(rawOpps) {
  return rawOpps.map((opp) => {
    const sh = [...opp.stageHistory].sort((a, b) => a.timestamp - b.timestamp);
    const fh = [...(opp.funderHistory || [])].sort((a, b) => a.timestamp - b.timestamp);
    const assignEvent = fh[0] || null;
    const assignTs = assignEvent ? assignEvent.timestamp : null;
    const funder = assignEvent ? assignEvent.funder : null;

    const finalStage = sh.length ? sh[sh.length - 1].stage : null;
    // "reached funding" = deal has EVER passed through 85/185 or 90/190,
    // not just whether the most recent stage happens to be one of those.
    // This matters because a deal can sit at 85/185 for a while before
    // (or without ever) being flipped to 90/190.
    const reachedFundedStage = sh.some((s) => FUNDED_STAGES.has(String(s.stage)));
    const reachedClosedWonStage = sh.some((s) => CLOSED_WON_STAGES.has(String(s.stage)));
    const isCancelled = finalStage === "19" || finalStage === "159" || finalStage === "98" || finalStage === "198";
    const isDeclined = finalStage === "99" || finalStage === "199";
    // isFunded rolls up 85/185 (Funding Booked) AND 90/190 (Closed/Won) together
    const isFunded = reachedFundedStage;
    // isClosedWon is the stricter subset: only the formal Closed/Won stage
    const isClosedWon = reachedClosedWonStage;
    const isWon = isFunded; // kept for backward compatibility with existing filters/labels below
    const isClosed = isCancelled || isDeclined || isFunded;
    const isTerminated = isCancelled || isDeclined;

    // segment durations between consecutive stage events
    const segments = [];
    for (let i = 0; i < sh.length - 1; i++) {
      const cur = sh[i];
      const next = sh[i + 1];
      const durationMs = next.timestamp - cur.timestamp;
      const isPreAssign = assignTs === null ? true : cur.timestamp < assignTs;
      segments.push({
        fromStage: cur.stage,
        toStage: next.stage,
        startTs: cur.timestamp,
        endTs: next.timestamp,
        durationDays: durationMs / 86400000,
        phase: isPreAssign ? "origination" : "funder",
        changedBy: next.changedBy || null, // who made the edit that moved it INTO next.stage
      });
    }
    // last stage -> now (still open) or terminal (no further duration needed for milestone calc, but useful for "current age")
    const lastTs = sh.length ? sh[sh.length - 1].timestamp : opp.createdDate;
    const nowTs = Date.now();

    const originationDays = assignTs !== null ? (assignTs - opp.createdDate) / 86400000 : null;
    const funderDays = assignTs !== null ? (lastTs - assignTs) / 86400000 : null;
    const totalDays = (lastTs - opp.createdDate) / 86400000;

    return {
      id: opp.id,
      name: opp.name,
      track: opp.track,
      createdDate: opp.createdDate,
      stageHistory: sh,
      segments,
      assignTs,
      funder,
      finalStage,
      isCancelled,
      isDeclined,
      isFunded,
      isClosedWon,
      isWon, // = isFunded, kept as alias
      isClosed,
      isTerminated,
      originationDays,
      funderDays,
      totalDays,
    };
  });
}

// ---------- Stats helpers ----------
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmtDays(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (v < 1) return `${(v * 24).toFixed(1)}h`;
  return `${v.toFixed(1)}d`;
}

// ---------- CSV/JSON parsing ----------
// Minimal RFC4180-aware CSV line splitter: handles quoted fields containing
// commas (e.g. "E&K Construction, LLC") which a naive split(",") breaks on.
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// Salesforce's stage picklist value sometimes comes through as just the
// numeric code ("10") and sometimes as "code - Label" ("10 - Assigned to
// Credit"), depending on the query/export path. All of the dashboard's
// stage-matching logic (funded/cancelled/declined detection, the Inferred
// tab's transitions, track detection) expects the bare numeric code, so
// every incoming stage value is normalized through this function first.
function extractStageCode(rawValue) {
  const str = String(rawValue || "").trim();
  const match = str.match(/^(\d+)/);
  return match ? match[1] : str;
}

function parseUploadedData(text, filename) {
  try {
    if (filename.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text);
      return normalizeImported(parsed);
    }
    // Expects the flat event-log schema produced by build_dashboard_csv.py:
    // OpportunityId,Name,Track,CreatedDate,Field,NewValue,Timestamp,ChangedBy
    const lines = text.trim().split(/\r?\n/);
    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map((l) => {
      const cells = parseCsvLine(l);
      const row = {};
      headers.forEach((h, i) => (row[h] = cells[i] !== undefined ? cells[i] : ""));
      return row;
    });
    const byOpp = {};
    rows.forEach((r) => {
      const oid = r.OpportunityId || r.Id;
      if (!oid) return;
      if (!byOpp[oid]) {
        byOpp[oid] = {
          id: oid,
          name: r.Name || oid,
          track: r.Track || (extractStageCode(r.NewValue).length >= 3 ? "2" : "1"),
          createdDate: r.CreatedDate ? new Date(r.CreatedDate).getTime() : Date.now(),
          stageHistory: [],
          funderHistory: [],
        };
      }
      const ts = r.Timestamp ? new Date(r.Timestamp).getTime() : null;
      if (!ts) return;
      if (r.Field === "StageName") {
        byOpp[oid].stageHistory.push({
          stage: extractStageCode(r.NewValue),
          timestamp: ts,
          changedBy: r.ChangedBy ? String(r.ChangedBy).trim() : null,
        });
      } else if (r.Field === "Assigned_Funder__c" || r.Field === "AssignedFunder") {
        byOpp[oid].funderHistory.push({ funder: r.NewValue, timestamp: ts });
      }
    });
    return Object.values(byOpp);
  } catch (e) {
    throw new Error("Could not parse file: " + e.message);
  }
}
function normalizeImported(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed.opportunities) return parsed.opportunities;
  return [];
}

// ---------- UI atoms ----------
function Pill({ children, tone = "neutral" }) {
  const tones = {
    neutral: "bg-[#EEF0F3] text-[#4B5563]",
    good: "bg-[#E6F4EA] text-[#1E7A3D]",
    bad: "bg-[#FCEAEA] text-[#B3261E]",
    accent: "bg-[#EAF1FB] text-[#1D4E89]",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

function StatCard({ label, value, sub, icon: Icon, tone = "neutral" }) {
  const toneColor = { neutral: "#1D2433", good: "#1E7A3D", bad: "#B3261E", accent: "#1D4E89" }[tone];
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg p-4 flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-[#6B7280] font-semibold">{label}</span>
        {Icon && <Icon size={14} color="#9AA3AF" />}
      </div>
      <span className="text-2xl font-semibold tabular-nums" style={{ color: toneColor }}>{value}</span>
      {sub && <span className="text-[12px] text-[#8A93A3]">{sub}</span>}
    </div>
  );
}

function StageSelect({ value, onChange, stages, placeholder }) {
  return (
    <select
      value={value || ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white text-[#1D2433] focus:outline-none focus:ring-2 focus:ring-[#1D4E89] min-w-0"
    >
      <option value="">{placeholder}</option>
      {stages.map(([c, n]) => (
        <option key={c} value={c}>{c} - {n}</option>
      ))}
    </select>
  );
}

// ---------- Main App ----------
export default function FunderKpiDashboard() {
  const [rawOpps, setRawOpps] = useState(() => generateSampleData());
  const [usingSample, setUsingSample] = useState(true);
  const [uploadError, setUploadError] = useState(null);
  const [activeTab, setActiveTab] = useState("funder"); // "funder" | "inferred"

  const ADMIN_NAMES = ["Ishaan Hussain"]; // process/admin — excluded entirely from inferred attribution, not just flagged
  // Underwriter whitelist takes precedence for the inferred model: only these
  // people's edits count. (Kept ADMIN_NAMES too since it's harmless as a
  // second layer, but the whitelist alone already excludes sales staff.)

  const [trackFilter, setTrackFilter] = useState("all"); // all | 1 | 2
  const [funderFilter, setFunderFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all"); // all | open | won | cancelled | declined | terminated
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [milestoneFrom, setMilestoneFrom] = useState("01");
  const [milestoneTo, setMilestoneTo] = useState("90");
  const [expandedFunder, setExpandedFunder] = useState(null);
  const [selectedTransitionId, setSelectedTransitionId] = useState(KEY_TRANSITIONS[0].id);
  const [expandedPerson, setExpandedPerson] = useState(null);

  const deals = useMemo(() => deriveDeals(rawOpps), [rawOpps]);

  const funders = useMemo(() => {
    const s = new Set();
    deals.forEach((d) => d.funder && s.add(d.funder));
    return Array.from(s).sort();
  }, [deals]);

  const filteredDeals = useMemo(() => {
    return deals.filter((d) => {
      if (trackFilter !== "all" && d.track !== trackFilter) return false;
      if (funderFilter !== "all" && d.funder !== funderFilter) return false;
      if (outcomeFilter === "open" && d.isClosed) return false;
      if (outcomeFilter === "won" && !d.isWon) return false;
      if (outcomeFilter === "cancelled" && !d.isCancelled) return false;
      if (outcomeFilter === "declined" && !d.isDeclined) return false;
      if (outcomeFilter === "terminated" && !d.isTerminated) return false;
      if (dateFrom && d.createdDate < new Date(dateFrom).getTime()) return false;
      if (dateTo && d.createdDate > new Date(dateTo).getTime() + 86400000) return false;
      return true;
    });
  }, [deals, trackFilter, funderFilter, outcomeFilter, dateFrom, dateTo]);

  // The Inferred tab is about who EDITED a deal's stage history, not who the
  // Assigned Funder (concrete field) is -- those are different people/models
  // entirely. Applying the funder filter here would silently restrict
  // Javier/Jay/Shervin's action counts down to only the small subset of
  // deals where Assigned Funder happens to equal that name, which is a
  // completely different (and usually much smaller) set of deals than the
  // ones they actually acted on. So the Inferred tab uses every other filter
  // (track, outcome, date) but never the concrete funder-field filter.
  const inferredFilteredDeals = useMemo(() => {
    return deals.filter((d) => {
      if (trackFilter !== "all" && d.track !== trackFilter) return false;
      if (outcomeFilter === "open" && d.isClosed) return false;
      if (outcomeFilter === "won" && !d.isWon) return false;
      if (outcomeFilter === "cancelled" && !d.isCancelled) return false;
      if (outcomeFilter === "declined" && !d.isDeclined) return false;
      if (outcomeFilter === "terminated" && !d.isTerminated) return false;
      if (dateFrom && d.createdDate < new Date(dateFrom).getTime()) return false;
      if (dateTo && d.createdDate > new Date(dateTo).getTime() + 86400000) return false;
      return true;
    });
  }, [deals, trackFilter, outcomeFilter, dateFrom, dateTo]);

  // ----- Milestone time-to calc -----
  const milestoneStats = useMemo(() => {
    const fromIdx = stageOrderIndex(milestoneFrom);
    const toIdx = stageOrderIndex(milestoneTo);
    const results = [];
    filteredDeals.forEach((d) => {
      const track = trackOf(milestoneFrom);
      if (trackOf(milestoneTo) !== track) return;
      if (d.track !== track) return;
      const fromEvt = d.stageHistory.find((s) => s.stage === milestoneFrom);
      const toEvt = d.stageHistory.find((s) => s.stage === milestoneTo);
      if (!fromEvt || !toEvt) return;
      if (toEvt.timestamp < fromEvt.timestamp) return;
      results.push({
        dealId: d.id,
        funder: d.funder,
        days: (toEvt.timestamp - fromEvt.timestamp) / 86400000,
      });
    });
    return results;
  }, [filteredDeals, milestoneFrom, milestoneTo]);

  const milestoneByFunder = useMemo(() => {
    const groups = {};
    milestoneStats.forEach((r) => {
      const key = r.funder || "Unassigned";
      if (!groups[key]) groups[key] = [];
      groups[key].push(r.days);
    });
    return Object.entries(groups)
      .map(([funder, arr]) => ({ funder, avg: mean(arr), median: median(arr), count: arr.length }))
      .sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity));
  }, [milestoneStats]);

  // ----- Summary KPIs -----
  const summary = useMemo(() => {
    const total = filteredDeals.length;
    const won = filteredDeals.filter((d) => d.isWon).length;
    const cancelled = filteredDeals.filter((d) => d.isCancelled).length;
    const declined = filteredDeals.filter((d) => d.isDeclined).length;
    const open = filteredDeals.filter((d) => !d.isClosed).length;
    const avgOrigination = mean(filteredDeals.filter((d) => d.originationDays !== null).map((d) => d.originationDays));
    const avgFunderTime = mean(filteredDeals.filter((d) => d.funderDays !== null).map((d) => d.funderDays));
    const avgTotal = mean(filteredDeals.map((d) => d.totalDays));
    return { total, won, cancelled, declined, open, avgOrigination, avgFunderTime, avgTotal };
  }, [filteredDeals]);

  // ----- Per-funder KPI table -----
  const funderTable = useMemo(() => {
    const groups = {};
    filteredDeals.forEach((d) => {
      if (!d.funder) return;
      if (!groups[d.funder]) groups[d.funder] = [];
      groups[d.funder].push(d);
    });
    return Object.entries(groups).map(([funder, arr]) => {
      const won = arr.filter((d) => d.isWon).length;
      const cancelled = arr.filter((d) => d.isCancelled).length;
      const declined = arr.filter((d) => d.isDeclined).length;
      const closed = arr.filter((d) => d.isClosed).length;
      const avgFunderDays = mean(arr.filter((d) => d.funderDays !== null).map((d) => d.funderDays));
      const medFunderDays = median(arr.filter((d) => d.funderDays !== null).map((d) => d.funderDays));
      return {
        funder,
        count: arr.length,
        won,
        cancelled,
        declined,
        closeRate: closed ? won / closed : null,
        avgFunderDays,
        medFunderDays,
        deals: arr,
      };
    }).sort((a, b) => b.count - a.count);
  }, [filteredDeals]);

  // stage-duration breakdown per funder (for expanded row) - only funder-phase segments
  function funderStageBreakdown(funder) {
    const segs = [];
    filteredDeals.filter((d) => d.funder === funder).forEach((d) => {
      d.segments.forEach((s) => {
        if (s.phase === "funder") segs.push(s);
      });
    });
    const byStage = {};
    segs.forEach((s) => {
      if (!byStage[s.fromStage]) byStage[s.fromStage] = [];
      byStage[s.fromStage].push(s.durationDays);
    });
    return Object.entries(byStage)
      .map(([stage, arr]) => ({ stage, label: STAGE_LABEL[stage] || stage, avg: mean(arr), count: arr.length }))
      .sort((a, b) => stageOrderIndex(a.stage) - stageOrderIndex(b.stage));
  }

  // ----- Inferred (stage-action) attribution -----
  const selectedTransition = KEY_TRANSITIONS.find((t) => t.id === selectedTransitionId) || KEY_TRANSITIONS[0];

  const hasChangedByData = useMemo(
    () => deals.some((d) => d.segments.some((s) => s.changedBy)),
    [deals]
  );

  const isUnderwriter = useCallback(
    (person) => person && UNDERWRITER_WHITELIST.includes(person) && !ADMIN_NAMES.includes(person),
    []
  );

  const inferredRows = useMemo(() => {
    const rows = [];
    inferredFilteredDeals.forEach((d) => {
      // Match any segment starting from one of the transition's fromStages.
      // For toAny transitions, any destination counts; otherwise only the
      // configured toStages count. Tracks are combined -- fromStages already
      // lists both e.g. ["10","110"].
      const matchingSegs = d.segments.filter((s) => {
        if (!selectedTransition.fromStages.includes(s.fromStage)) return false;
        if (selectedTransition.excludeToStages && selectedTransition.excludeToStages.includes(s.toStage)) return false;
        if (selectedTransition.toAny) return true;
        return selectedTransition.toStages.includes(s.toStage);
      });
      if (matchingSegs.length === 0) return;

      if (selectedTransition.toAny) {
        // "Any next stage" transitions (e.g. Assigned to Credit -> action
        // taken) can legitimately recur many times on the same deal --
        // rework loops (info requested, then back to credit, etc). Every
        // occurrence counts separately (per decision), but each is tagged
        // "initial" (the very first time the deal ever entered this
        // fromStage) vs "repeat" (a later re-entry), so initial review
        // speed and rework-cycle speed can be seen apart from one another.
        matchingSegs.forEach((seg, idx) => {
          if (!isUnderwriter(seg.changedBy)) return;
          rows.push({
            dealId: d.id,
            dealName: d.name,
            person: seg.changedBy,
            days: seg.durationDays,
            destinationStage: seg.toStage,
            occurrenceType: idx === 0 ? "new" : "returning",
          });
        });
      } else {
        // Fixed-destination transitions (e.g. Docs Requested -> Docs Out):
        // credit only the FIRST occurrence per deal -- later re-entries are
        // separate document rounds (corrections, GOTs/POAs/addendums), not
        // counted as their own KPI data points, just surfaced as context.
        const firstRealSeg = matchingSegs.find((s) => isUnderwriter(s.changedBy));
        if (!firstRealSeg) return;
        rows.push({
          dealId: d.id,
          dealName: d.name,
          person: firstRealSeg.changedBy,
          days: firstRealSeg.durationDays,
          destinationStage: firstRealSeg.toStage,
          hadAdditionalRounds: matchingSegs.length > 1,
          roundCount: matchingSegs.length,
        });
      }
    });
    return rows;
  }, [inferredFilteredDeals, selectedTransition, isUnderwriter]);

  const inferredByPerson = useMemo(() => {
    const groups = {};
    inferredRows.forEach((r) => {
      const key = r.person;
      if (!groups[key]) groups[key] = { rows: [], additionalRoundsCount: 0, newRows: [], returningRows: [] };
      groups[key].rows.push(r.days);
      if (r.hadAdditionalRounds) groups[key].additionalRoundsCount += 1;
      if (r.occurrenceType === "new") groups[key].newRows.push(r.days);
      if (r.occurrenceType === "returning") groups[key].returningRows.push(r.days);
    });
    return Object.entries(groups)
      .map(([person, g]) => ({
        person,
        avg: mean(g.rows),
        median: median(g.rows),
        count: g.rows.length,
        additionalRoundsCount: g.additionalRoundsCount,
        newAvg: mean(g.newRows),
        newCount: g.newRows.length,
        returningAvg: mean(g.returningRows),
        returningCount: g.returningRows.length,
      }))
      .sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity));
  }, [inferredRows]);

  // Granular breakdown: per person, per destination stage (only meaningful
  // for toAny transitions like "Assigned to Credit -> action taken", where
  // the destination varies -- e.g. did it go to Credit Reviewed, or straight
  // to a decline?). Also split by initial vs repeat where that distinction
  // applies, so rework cycles don't blend into first-touch numbers.
  const inferredByPersonAndStage = useMemo(() => {
    const groups = {}; // person -> stage -> occurrenceType -> [days]
    inferredRows.forEach((r) => {
      const otype = r.occurrenceType || "all";
      if (!groups[r.person]) groups[r.person] = {};
      if (!groups[r.person][r.destinationStage]) groups[r.person][r.destinationStage] = {};
      if (!groups[r.person][r.destinationStage][otype]) groups[r.person][r.destinationStage][otype] = [];
      groups[r.person][r.destinationStage][otype].push(r.days);
    });
    const result = [];
    Object.entries(groups).forEach(([person, byStage]) => {
      Object.entries(byStage).forEach(([stage, byType]) => {
        Object.entries(byType).forEach(([otype, days]) => {
          result.push({
            person,
            stage,
            stageLabel: STAGE_LABEL[stage] || stage,
            occurrenceType: otype,
            avg: mean(days),
            median: median(days),
            count: days.length,
          });
        });
      });
    });
    return result.sort((a, b) => a.person.localeCompare(b.person) || stageOrderIndex(a.stage) - stageOrderIndex(b.stage));
  }, [inferredRows]);

  // Dedicated decline summary -- pulled from the same inferredRows used above,
  // just pre-filtered to the decline stages (99/199) so this doesn't require
  // scanning the full destination-stage table to find it. Only meaningful
  // when the selected transition is "Assigned to Credit -> Action Taken",
  // since that's the one where decline is a possible destination.
  const declineByPerson = useMemo(() => {
    if (!selectedTransition.toAny) return [];
    const groups = {};
    inferredRows
      .filter((r) => DECLINE_STAGES.has(r.destinationStage))
      .forEach((r) => {
        if (!groups[r.person]) groups[r.person] = { new: [], returning: [] };
        groups[r.person][r.occurrenceType].push(r.days);
      });
    return Object.entries(groups)
      .map(([person, g]) => ({
        person,
        newCount: g.new.length,
        newAvg: mean(g.new),
        returningCount: g.returning.length,
        returningAvg: mean(g.returning),
        totalCount: g.new.length + g.returning.length,
      }))
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [inferredRows, selectedTransition]);

  // Multi-submission signal: if a deal hits 120/125 (Submitted to Source /
  // Submitted to Real Estate Lender) more than once, it means it was shopped
  // to multiple lenders/sources -- context worth surfacing, not a KPI metric.
  const multiSubmissionByPerson = useMemo(() => {
    if (!selectedTransition.toAny) return {};
    const dealHits = {}; // person -> Set of dealIds hit multiple times
    inferredFilteredDeals.forEach((d) => {
      const hits = d.segments.filter(
        (s) => selectedTransition.fromStages.includes(s.fromStage) && MULTI_SUBMISSION_STAGES.has(s.toStage)
      );
      if (hits.length > 1) {
        hits.forEach((h) => {
          if (!isUnderwriter(h.changedBy)) return;
          if (!dealHits[h.changedBy]) dealHits[h.changedBy] = new Set();
          dealHits[h.changedBy].add(d.id);
        });
      }
    });
    const result = {};
    Object.entries(dealHits).forEach(([person, dealSet]) => { result[person] = dealSet.size; });
    return result;
  }, [inferredFilteredDeals, selectedTransition, isUnderwriter]);

  const inferredChartData = inferredByPerson.map((r) => ({
    name: r.person,
    avg: Number(r.avg?.toFixed(2) || 0),
    count: r.count,
  }));

  const chartData = milestoneByFunder.map((r) => ({ name: r.funder, avg: Number(r.avg?.toFixed(2) || 0), count: r.count }));

  const stagesForTrack = trackFilter === "2" ? STAGES_TRACK_2 : trackFilter === "1" ? STAGES_TRACK_1 : STAGES_TRACK_1;

  // This should be the Apps Script WEB APP url (Deploy -> New deployment ->
  // Web app), NOT the Sheets "Publish to web" CSV url -- Google's Sheets
  // publish-to-web CSV endpoint does not send CORS headers and is blocked
  // by browsers when fetched from a page on a different origin. The Web
  // App's doGet() handler serves the same data as plain CSV text and does
  // work for cross-origin fetches.
  const SALESFORCE_CSV_URL = "https://script.google.com/macros/s/AKfycbwTn8A6DywHZ8lm-q-jfnxyFIy_ngr3pQAODQYIfaY_XBB-T8eWILuSGIPjmurfZamB/exec";
  // Shared access key checked by the Apps Script's doGet() before it'll
  // return data -- must match the ACCESS_KEY Script Property set on the
  // Apps Script side.
  const SALESFORCE_ACCESS_KEY = "rH[!-naWP]_WQ^NI";

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Apps Script Web Apps don't reliably support CORS for plain fetch()
  // calls (a documented limitation -- the /exec URL's redirect chain
  // doesn't carry CORS headers through for fetch(), even though loading
  // the same URL directly in a browser tab works fine). JSONP sidesteps
  // this entirely by loading the response via a <script> tag instead --
  // those have always been allowed cross-origin, since they predate CORS.
  const loadViaJsonp = useCallback((url, timeoutMs = 15000) => {
    return new Promise((resolve, reject) => {
      const callbackName = "__sfDashboardCallback_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const script = document.createElement("script");
      let settled = false;

      const cleanup = () => {
        delete window[callbackName];
        if (script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Request timed out. The Apps Script Web App may be slow to respond or unreachable."));
      }, timeoutMs);

      window[callbackName] = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Could not load the data source script. Check that the Apps Script Web App URL is correct and still deployed."));
      };

      const separator = url.includes("?") ? "&" : "?";
      script.src = url + separator + "callback=" + callbackName;
      document.body.appendChild(script);
    });
  }, []);

  const refreshFromSalesforce = useCallback(async () => {
    setUploadError(null);
    setIsRefreshing(true);
    try {
      const separator = SALESFORCE_CSV_URL.includes("?") ? "&" : "?";
      const keyParam = SALESFORCE_ACCESS_KEY ? "&key=" + encodeURIComponent(SALESFORCE_ACCESS_KEY) : "";
      // Cache-bust so the browser doesn't serve a stale cached copy --
      // the Apps Script sync updates this data daily, so a fresh fetch
      // each time the button is clicked matters.
      const bustUrl = SALESFORCE_CSV_URL + separator + "_cb=" + Date.now() + keyParam;

      const payload = await loadViaJsonp(bustUrl);
      if (!payload || typeof payload.ok === "undefined") {
        throw new Error("Unexpected response shape from the data source.");
      }
      if (!payload.ok) {
        throw new Error(payload.data || "Request was rejected by the data source.");
      }
      const text = payload.data || "";
      const parsed = parseUploadedData(text, "output.csv");
      if (!parsed.length) throw new Error("The data source returned no records. Check that the Apps Script sync has run and the 'output' sheet has data.");
      setRawOpps(parsed);
      setUsingSample(false);
      setLastRefreshed(new Date());
    } catch (err) {
      setUploadError(err.message || "Failed to refresh from Salesforce.");
    } finally {
      setIsRefreshing(false);
    }
  }, [loadViaJsonp]);

  return (
    <div className="w-full min-h-screen bg-[#F6F7F9] text-[#1D2433]" style={{ fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .mono { font-family: 'IBM Plex Mono', monospace; }
        table.kpi-table { border-collapse: collapse; width: 100%; }
        table.kpi-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6B7280; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #E4E7EC; }
        table.kpi-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #EEF0F3; }
        table.kpi-table tr:hover td { background: #FAFBFC; }
      `}</style>

      {/* Header */}
      <div className="border-b border-[#E4E7EC] bg-white px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h1 className="text-lg font-semibold text-[#1D2433]">Funder KPI Dashboard</h1>
          <p className="text-[12px] text-[#8A93A3] mt-0.5">Time-in-stage &amp; time-to-milestone tracking, split by origination and funder-assigned phases</p>
        </div>
        <div className="flex items-center gap-3">
          {usingSample && <Pill tone="accent">Sample data</Pill>}
          {lastRefreshed && (
            <span className="text-[12px] text-[#8A93A3]">
              Last refreshed {lastRefreshed.toLocaleDateString()} {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button
            onClick={refreshFromSalesforce}
            disabled={isRefreshing}
            className="flex items-center gap-2 text-[13px] font-medium border border-[#D8DCE3] rounded px-3 py-1.5 hover:bg-[#F6F7F9] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload size={14} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "Refreshing…" : "Refresh from Salesforce"}
          </button>
        </div>
      </div>
      {uploadError && (
        <div className="mx-6 mt-4 flex items-center gap-2 bg-[#FCEAEA] text-[#B3261E] text-[13px] px-3 py-2 rounded border border-[#F5C6C4]">
          <AlertCircle size={14} /> {uploadError}
        </div>
      )}

      {/* Tabs */}
      <div className="px-6 pt-4 flex items-center gap-1 border-b border-[#E4E7EC] bg-white">
        <button
          onClick={() => setActiveTab("funder")}
          className={`px-4 py-2 text-[13px] font-medium rounded-t border-b-2 transition-colors ${
            activeTab === "funder" ? "border-[#1D4E89] text-[#1D4E89]" : "border-transparent text-[#8A93A3] hover:text-[#4B5563]"
          }`}
        >
          Assigned Funder (concrete)
        </button>
        <button
          onClick={() => setActiveTab("inferred")}
          className={`px-4 py-2 text-[13px] font-medium rounded-t border-b-2 transition-colors ${
            activeTab === "inferred" ? "border-[#1D4E89] text-[#1D4E89]" : "border-transparent text-[#8A93A3] hover:text-[#4B5563]"
          }`}
        >
          Inferred (stage actions)
        </button>
      </div>


      <div className="px-6 py-5 flex flex-col gap-5">

        {/* Filters */}
        <div className="bg-white border border-[#E4E7EC] rounded-lg p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#6B7280] mr-1">
            <Filter size={13} /> Filters
          </div>
          <select value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white">
            <option value="all">All record types</option>
            <option value="1">01-99 track</option>
            <option value="2">101-199 track</option>
          </select>
          <select
            value={funderFilter}
            onChange={(e) => setFunderFilter(e.target.value)}
            disabled={activeTab === "inferred"}
            title={activeTab === "inferred" ? "Assigned Funder filter doesn't apply here — the Inferred tab tracks who edited each deal's stage history, not the concrete Assigned Funder field." : undefined}
            className={`text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white ${activeTab === "inferred" ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <option value="all">All funders</option>
            {funders.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          {activeTab === "inferred" && (
            <span className="text-[11px] text-[#8A93A3] italic">Funder filter doesn't apply to Inferred — that's based on who edited the deal, not the Assigned Funder field.</span>
          )}
          <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white">
            <option value="all">All outcomes</option>
            <option value="open">Open only</option>
            <option value="won">Funded only (85/185 or 90/190)</option>
            <option value="cancelled">Cancelled only</option>
            <option value="declined">Declined only</option>
            <option value="terminated">Cancelled + Declined</option>
          </select>
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] text-[#8A93A3]">Created</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5" />
            <span className="text-[12px] text-[#8A93A3]">to</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5" />
          </div>
          {(trackFilter !== "all" || funderFilter !== "all" || outcomeFilter !== "all" || dateFrom || dateTo) && (
            <button
              onClick={() => { setTrackFilter("all"); setFunderFilter("all"); setOutcomeFilter("all"); setDateFrom(""); setDateTo(""); }}
              className="flex items-center gap-1 text-[12px] text-[#B3261E] ml-1"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label="Total deals" value={summary.total} icon={Users} />
          <StatCard label="Open" value={summary.open} icon={Clock} />
          <StatCard label="Funded" value={summary.won} sub="Reached 85/185 or 90/190" tone="good" icon={TrendingUp} />
          <StatCard label="Cancelled" value={summary.cancelled} tone="bad" icon={TrendingDown} />
          <StatCard label="Declined" value={summary.declined} tone="bad" icon={TrendingDown} />
          <StatCard label="Avg origination time" value={fmtDays(summary.avgOrigination)} sub="Created → funder assigned" tone="accent" />
          <StatCard label="Avg funder time" value={fmtDays(summary.avgFunderTime)} sub="Assigned → latest stage" tone="accent" />
        </div>

        {/* Milestone picker + chart */}
        {activeTab === "funder" && (
        <div className="bg-white border border-[#E4E7EC] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-[13px] font-semibold text-[#1D2433]">Time between milestones</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <StageSelect value={milestoneFrom} onChange={setMilestoneFrom} stages={stagesForTrack} placeholder="From stage" />
              <ChevronRight size={14} color="#9AA3AF" />
              <StageSelect value={milestoneTo} onChange={setMilestoneTo} stages={stagesForTrack} placeholder="To stage" />
            </div>
          </div>
          {trackFilter === "all" && (
            <p className="text-[12px] text-[#8A93A3] mb-2">Showing results for the {trackOf(milestoneFrom) === "2" ? "101-199" : "01-99"} track (based on selected stages). Set the record-type filter above to scope explicitly.</p>
          )}
          {chartData.length === 0 ? (
            <p className="text-[13px] text-[#8A93A3] py-8 text-center">No deals in the current filter have passed through both selected stages.</p>
          ) : (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} label={{ value: "days", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8A93A3" }} />
                  <Tooltip
                    formatter={(v, n) => [n === "avg" ? `${v} days` : v, n === "avg" ? "Avg time" : "Deals"]}
                    contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #E4E7EC" }}
                  />
                  <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                    {chartData.map((_, i) => <Cell key={i} fill="#1D4E89" />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        )}

        {/* Per-funder KPI table */}
        {activeTab === "funder" && (
        <div className="bg-white border border-[#E4E7EC] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E4E7EC]">
            <h2 className="text-[13px] font-semibold text-[#1D2433]">Funder performance</h2>
            <p className="text-[12px] text-[#8A93A3] mt-0.5">Funder-phase metrics only — time from assignment (Docs In) onward. Click a row for per-stage breakdown.</p>
          </div>
          <table className="kpi-table">
            <thead>
              <tr>
                <th>Funder</th>
                <th>Deals</th>
                <th>Funded</th>
                <th>Cancelled</th>
                <th>Declined</th>
                <th>Close rate</th>
                <th>Avg funder time</th>
                <th>Median funder time</th>
              </tr>
            </thead>
            <tbody>
              {funderTable.map((row) => (
                <React.Fragment key={row.funder}>
                  <tr
                    className="cursor-pointer"
                    onClick={() => setExpandedFunder(expandedFunder === row.funder ? null : row.funder)}
                  >
                    <td className="font-medium flex items-center gap-1.5">
                      {expandedFunder === row.funder ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {row.funder}
                    </td>
                    <td className="mono">{row.count}</td>
                    <td className="mono text-[#1E7A3D]">{row.won}</td>
                    <td className="mono text-[#B3261E]">{row.cancelled}</td>
                    <td className="mono text-[#B3261E]">{row.declined}</td>
                    <td className="mono">{row.closeRate !== null ? `${(row.closeRate * 100).toFixed(0)}%` : "—"}</td>
                    <td className="mono">{fmtDays(row.avgFunderDays)}</td>
                    <td className="mono">{fmtDays(row.medFunderDays)}</td>
                  </tr>
                  {expandedFunder === row.funder && (
                    <tr>
                      <td colSpan={8} className="bg-[#FAFBFC] p-0">
                        <div className="px-8 py-3">
                          <p className="text-[11px] uppercase tracking-wide text-[#8A93A3] font-semibold mb-2">Avg time per stage (post-assignment)</p>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            {funderStageBreakdown(row.funder).map((s) => (
                              <div key={s.stage} className="border border-[#E4E7EC] rounded px-2.5 py-1.5 bg-white">
                                <div className="text-[11px] text-[#6B7280] truncate">{s.label}</div>
                                <div className="text-[13px] font-semibold mono">{fmtDays(s.avg)} <span className="text-[11px] text-[#8A93A3] font-normal">({s.count})</span></div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {funderTable.length === 0 && (
                <tr><td colSpan={8} className="text-center text-[#8A93A3] py-6">No funder-assigned deals in the current filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        {/* Milestone leaderboard table */}
        {activeTab === "funder" && milestoneByFunder.length > 0 && (
          <div className="bg-white border border-[#E4E7EC] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E4E7EC]">
              <h2 className="text-[13px] font-semibold text-[#1D2433]">
                {STAGE_LABEL[milestoneFrom] || milestoneFrom} → {STAGE_LABEL[milestoneTo] || milestoneTo}
              </h2>
              <p className="text-[12px] text-[#8A93A3] mt-0.5">Ranked fastest to slowest by average</p>
            </div>
            <table className="kpi-table">
              <thead>
                <tr><th>Funder</th><th>Deals</th><th>Avg</th><th>Median</th></tr>
              </thead>
              <tbody>
                {milestoneByFunder.map((r) => (
                  <tr key={r.funder}>
                    <td className="font-medium">{r.funder}</td>
                    <td className="mono">{r.count}</td>
                    <td className="mono">{fmtDays(r.avg)}</td>
                    <td className="mono">{fmtDays(r.median)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === "funder" && (
        <p className="text-[11px] text-[#AAB1BC] text-center pb-4">
          Origination time = deal created → funder assigned (76/176, shared/team metric). Funder time = assignment → latest stage (attributed to assigned funder). Reassignment mid-deal is not tracked separately.
        </p>
        )}

        {/* ---------------- INFERRED (stage-action) TAB ---------------- */}
        {activeTab === "inferred" && (
          <>
            {!hasChangedByData && (
              <div className="bg-white border border-[#E4E7EC] rounded-lg p-6 text-center">
                <AlertCircle size={20} color="#B3261E" className="mx-auto mb-2" />
                <p className="text-[14px] font-medium text-[#1D2433]">No "Changed By" data found in the imported file</p>
                <p className="text-[12px] text-[#8A93A3] mt-1 max-w-md mx-auto">
                  This tab attributes stage-transition time to whoever made the edit that caused the transition. Your stage-history export needs a Changed By / Created By column — re-run the CSV builder script against a report export that includes it.
                </p>
              </div>
            )}

            <div className="bg-white border border-[#E4E7EC] rounded-lg p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div>
                  <h2 className="text-[13px] font-semibold text-[#1D2433]">Inferred stage-action attribution</h2>
                  <p className="text-[12px] text-[#8A93A3] mt-0.5">Time credited to whoever's edit moved the deal forward. Only Javier, Jay, and Shervin are tracked — everyone else is excluded.</p>
                </div>
                <select
                  value={selectedTransitionId}
                  onChange={(e) => { setSelectedTransitionId(e.target.value); setExpandedPerson(null); }}
                  className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white"
                >
                  {KEY_TRANSITIONS.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </div>

              {inferredChartData.length === 0 ? (
                <p className="text-[13px] text-[#8A93A3] py-8 text-center">No deals in the current filter have a recorded edit for this transition.</p>
              ) : (
                <div style={{ width: "100%", height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart data={inferredChartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} label={{ value: "days", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8A93A3" }} />
                      <Tooltip
                        formatter={(v, n) => [n === "avg" ? `${v} days` : v, n === "avg" ? "Avg time" : "Deals"]}
                        contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #E4E7EC" }}
                      />
                      <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                        {inferredChartData.map((_, i) => <Cell key={i} fill="#1D4E89" />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Per-person collapsible cards */}
            <div className="flex flex-col gap-3">
              {inferredByPerson.length === 0 && (
                <div className="bg-white border border-[#E4E7EC] rounded-lg p-6 text-center text-[13px] text-[#8A93A3]">
                  No data for this transition in the current filter.
                </div>
              )}
              {inferredByPerson.map((r) => {
                const isOpen = expandedPerson === r.person;
                const personStageRows = inferredByPersonAndStage.filter((row) => row.person === r.person);
                const personDeclines = declineByPerson.find((d) => d.person === r.person);
                const multiSubCount = multiSubmissionByPerson[r.person] || 0;

                // group this person's stage rows by outcome type, for color-coded sections
                const byOutcome = { approval: [], decline: [], info: [], cancelled: [], other: [] };
                personStageRows.forEach((row) => {
                  const otype = outcomeTypeOf(row.stage);
                  byOutcome[otype].push(row);
                });

                return (
                  <div key={r.person} className="bg-white border border-[#E4E7EC] rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedPerson(isOpen ? null : r.person)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#FAFBFC] transition-colors text-left"
                    >
                      <div className="flex items-center gap-2.5">
                        {isOpen ? <ChevronDown size={15} color="#6B7280" /> : <ChevronRight size={15} color="#6B7280" />}
                        <span className="text-[14px] font-semibold text-[#1D2433]">{r.person}</span>
                        {multiSubCount > 0 && (
                          <span title={`${multiSubCount} deal(s) submitted to multiple lenders/sources`}>
                            <Pill tone="accent">{multiSubCount} multi-lender</Pill>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-[12px]">
                        <span className="text-[#8A93A3]">
                          <span className="font-semibold text-[#1D2433] mono">{r.count}</span> actions
                        </span>
                        <span className="text-[#8A93A3]">
                          avg <span className="font-semibold text-[#1D2433] mono">{fmtDays(r.avg)}</span>
                        </span>
                        {personDeclines && (
                          <span className="text-[#B3261E]">
                            <span className="font-semibold mono">{personDeclines.totalCount}</span> declines
                          </span>
                        )}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-[#E4E7EC] px-4 py-4 bg-[#FAFBFC]">
                        {selectedTransition.toAny ? (
                          <>
                            {/* New vs returning summary */}
                            <div className="grid grid-cols-2 gap-3 mb-4">
                              <div className="bg-white border border-[#E4E7EC] rounded-lg p-3">
                                <div className="text-[11px] uppercase tracking-wide text-[#6B7280] font-semibold mb-1">New deals</div>
                                <div className="text-[18px] font-semibold mono text-[#1D2433]">{r.newCount}</div>
                                <div className="text-[12px] text-[#8A93A3]">avg {fmtDays(r.newAvg)} — first time reaching this stage</div>
                              </div>
                              <div className="bg-white border border-[#E4E7EC] rounded-lg p-3">
                                <div className="text-[11px] uppercase tracking-wide text-[#6B7280] font-semibold mb-1">Returning deals</div>
                                <div className="text-[18px] font-semibold mono text-[#1D2433]">{r.returningCount}</div>
                                <div className="text-[12px] text-[#8A93A3]">avg {fmtDays(r.returningAvg)} — came back from a later stage</div>
                              </div>
                            </div>

                            {/* Color-coded outcome sections */}
                            {["approval", "decline", "info", "cancelled", "other"].map((otype) => {
                              const rows = byOutcome[otype];
                              if (!rows || rows.length === 0) return null;
                              const style = OUTCOME_STYLES[otype];
                              return (
                                <div key={otype} className="mb-3 last:mb-0">
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ background: style.text }}></span>
                                    <span className="text-[12px] font-semibold" style={{ color: style.text }}>{style.label}</span>
                                  </div>
                                  <div className="rounded-lg overflow-hidden border" style={{ borderColor: style.bg }}>
                                    <table className="kpi-table">
                                      <thead>
                                        <tr style={{ background: style.bg }}>
                                          <th>Destination stage</th><th>New / Returning</th><th>Deals</th><th>Avg time</th><th>Median</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {rows.map((row) => (
                                          <tr key={`${row.stage}-${row.occurrenceType}`}>
                                            <td>{row.stageLabel}</td>
                                            <td>
                                              <Pill tone={row.occurrenceType === "new" ? "accent" : "neutral"}>
                                                {row.occurrenceType === "new" ? "New" : "Returning"}
                                              </Pill>
                                            </td>
                                            <td className="mono">{row.count}</td>
                                            <td className="mono">{fmtDays(row.avg)}</td>
                                            <td className="mono">{fmtDays(row.median)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              );
                            })}

                            {multiSubCount > 0 && (
                              <p className="text-[11px] text-[#8A93A3] mt-3 italic">
                                {multiSubCount} deal(s) hit "Submitted to Source" or "Submitted to Real Estate Lender" more than once — meaning the deal was shopped to multiple lenders before landing.
                              </p>
                            )}
                          </>
                        ) : (
                          <div className="bg-white border border-[#E4E7EC] rounded-lg p-3">
                            <table className="kpi-table">
                              <thead>
                                <tr><th>Deals</th><th>Avg time</th><th>Median time</th><th>Had additional rounds</th></tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td className="mono">{r.count}</td>
                                  <td className="mono">{fmtDays(r.avg)}</td>
                                  <td className="mono">{fmtDays(r.median)}</td>
                                  <td className="mono">{r.additionalRoundsCount > 0 ? r.additionalRoundsCount : "—"}</td>
                                </tr>
                              </tbody>
                            </table>
                            <p className="text-[11px] text-[#8A93A3] mt-2">Credits the first time this transition happened per deal — later re-entries (corrections, separate document rounds like GOTs/POAs/addendums) are shown as additional rounds, not counted as separate KPI data points.</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-[#AAB1BC] text-center pb-4 max-w-2xl mx-auto">
              Only Javier Mendoza, Jay Cristobal, and Shervin Rashti are tracked here — everyone else's edits (sales staff, admin/process work) are excluded entirely, not just de-emphasized. If a deal's first matching stage-change was made by someone off this list, the next occurrence made by one of these three is credited instead; a deal is only dropped if none of the three ever touched that transition.
            </p>
          </>

        )}
      </div>
    </div>
  );
}
