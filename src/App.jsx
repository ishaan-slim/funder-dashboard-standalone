import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { BarChart, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend, Cell } from "recharts";
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

// Categorical color palette for the Lender Performance chart/table --
// cycles through if there are more lenders than colors. Chosen for
// visual distinctness at a glance, not tied to approval rate or any
// other metric.
const LENDER_COLOR_PALETTE = [
  "#1D4E89", "#1E7A3D", "#B3261E", "#8A6D1D", "#6B4FA0",
  "#0E7C86", "#C2410C", "#4338CA", "#BE185D", "#166534",
  "#9333EA", "#0369A1", "#A16207", "#B91C1C", "#0F766E",
];
function colorForLender(lenderName, allLenderNames) {
  const idx = allLenderNames.indexOf(lenderName);
  return LENDER_COLOR_PALETTE[idx % LENDER_COLOR_PALETTE.length];
}
function initialsForLender(lenderName) {
  return lenderName
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function outcomeTypeOf(stageCode) {
  return OUTCOME_TYPE[String(stageCode)] || "other";
}
// Stages where hitting them more than once on the same deal means it was
// submitted to multiple lenders/sources -- worth flagging distinctly.
const MULTI_SUBMISSION_STAGES = new Set(["120", "125"]);


// Only these people's edits count toward the inferred model -- everyone else
// (sales staff, admins, etc.) is excluded entirely, not just de-emphasized.
// Full roster of people trackable in the Stage History tab. Javier and Jay
// are the core underwriters and default ON; Shervin and Ishaan are
// optional -- toggle them on via the checkboxes to include their edits in
// the attribution, stats, and charts using the exact same logic.
const TRACKABLE_PEOPLE = ["Javier Mendoza", "Jay Cristobal", "Shervin Rashti", "Ishaan Hussain"];
const DEFAULT_SELECTED_PEOPLE = ["Javier Mendoza", "Jay Cristobal"];
// General ops staff tracked separately from underwriting -- Clinton handles
// the early Logged Deal -> Assigned to Credit intake step, a different job
// function from Javier/Jay/Shervin's underwriting actions.
const OPS_NAMES = ["Clinton Ordeniza"];



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

    // segment durations between consecutive stage events. Each segment
    // carries its OWN track based on its actual stage code -- a single
    // deal can start on the Internal/Balance Sheet track (2-digit stages)
    // and later move to Syndication (3-digit) after being submitted to
    // source, so track is a property of each stage transition, not a
    // fixed property of the whole deal.
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
        track: trackOf(cur.stage), // this specific transition's track, not the deal's overall track
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
// Sales tab: a deal's outcome is read from its CURRENT stage (the Sales
// sync pulls one row per opportunity since Jan 2023 rather than the full
// stage history, which would be far too large for that date range).
const SALES_FUNDED_STAGES = new Set(["85", "185", "90", "190"]);
const SALES_DECLINED_STAGES = new Set(["99", "199"]);
const SALES_CANCELLED_STAGES = new Set(["98", "198"]);
// ---------- Who can see what ----------
// IMPORTANT: this decides what the DASHBOARD shows. It is NOT a security
// boundary. The data itself is served by the Apps Script, which doesn't check
// who is asking, so a technically capable person could still read it
// directly. What this does do: nobody lands on a tab they weren't given, and
// a Sales-only account never even requests the other sheets.
//
// People are listed by a SHA-256 hash of their lowercase sign-in email, so no
// address sits in this public repo. To add someone, in Terminal:
//   printf '%s' 'their.email@company.com' | tr '[:upper:]' '[:lower:]' | shasum -a 256 | cut -d' ' -f1
// and paste the result into the right list below. Anyone signed in but not
// listed sees a "No access yet" page (which shows their code, so they can
// send it to an admin).
const ADMIN_EMAIL_HASHES = [
  "e2cc4a7c4d5436c8c5a5d6db11e9294f74c336d619cd20ce6c7f4b098736602a", // ishaan@slimcapital.com
]; // full access: every tab
const SALES_EMAIL_HASHES = [
  "0b94b2de0c7588c8fb7243fbdd654c0c3f4a7f2a34654d969b4d4a6be633c8aa", // jeff
]; // Sales tab only
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The Sales tab only covers these reps (matched to the Opportunity Owner
// name from the sync). Alphabetical so chart order and colors stay fixed.
const SALES_REP_NAMES = ["Chase Brannon", "Gregory Lamb", "Jeff Brannon", "Maria Mendoza", "Ryan Lamastra"];

function fmtMoney(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}
// "Samantha Rivera" -> "Samantha R." for compact chart axis labels.
function shortPersonName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || "";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function fmtDays(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const hours = v * 24;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (v < 1) return `${hours.toFixed(1)}h`;
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

// Parses the funding_sources sheet's CSV shape (distinct from the main
// output.csv): OpportunityId,Name,Track,CreatedDate,LenderName,Status,
// SubmittedDate,SubmittedBy -- one row per lender submission, not an
// event log, so no per-opportunity grouping is needed here.
function parseDateMs(s) {
  if (!s) return null;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}
// Maps an owner name from the sheet onto the roster spelling (ignoring
// case/extra spaces) so everything downstream can use exact matching.
function canonicalSalesRep(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "(No owner)";
  const match = SALES_REP_NAMES.find((n) => n.toLowerCase() === trimmed.toLowerCase());
  return match || trimmed;
}

// Parses the "sales" sheet: one row per opportunity since Jan 2023.
// Columns: OpportunityId,Name,Owner,CreatedDate,CreatedDateTimestamp,
// CloseDate,Stage,InvoiceAmount,LoanPurpose,ContractType,Broker,
// BrokerSalesRep,ReasonLost,FacilityLender,OriginationSource
function parseSalesData(text) {
  try {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((l) => {
      const cells = parseCsvLine(l);
      const row = {};
      headers.forEach((h, i) => (row[h] = cells[i] !== undefined ? cells[i] : ""));
      const amount = parseFloat(String(row.InvoiceAmount || "").replace(/[$,]/g, ""));
      return {
        opportunityId: row.OpportunityId || "",
        name: row.Name || "",
        owner: canonicalSalesRep(row.Owner),
        created: row.CreatedDate ? new Date(row.CreatedDate).getTime() : null,
        closeDate: row.CloseDate || "",
        closeMs: parseDateMs(row.CloseDate),
        stage: extractStageCode(row.Stage),
        amount: Number.isNaN(amount) ? 0 : amount,
        loanPurpose: (row.LoanPurpose || "").trim(),
        contractType: (row.ContractType || "").trim(),
        broker: (row.Broker || "").trim(),
        brokerRep: (row.BrokerSalesRep || "").trim(),
        reasonLost: (row.ReasonLost || "").trim(),
        facilityLender: (row.FacilityLender || "").trim(),
        originationSource: (row.OriginationSource || "").trim(),
        // Placeholder until the Apps Script pulls an industry field: the
        // sheet column should be headed "Industry". Blank until then.
        industry: (row.Industry || "").trim(),
      };
    }).filter((r) => r.opportunityId);
  } catch (e) {
    console.warn("Failed to parse sales data:", e);
    return [];
  }
}

function parseFundingSourceData(text) {
  try {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((l) => {
      const cells = parseCsvLine(l);
      const row = {};
      headers.forEach((h, i) => (row[h] = cells[i] !== undefined ? cells[i] : ""));
      return {
        opportunityId: row.OpportunityId || "",
        name: row.Name || "",
        track: row.Track || "1",
        createdDate: row.CreatedDate ? new Date(row.CreatedDate).getTime() : null,
        lenderName: (row.LenderName || "").trim(),
        status: (row.Status || "").trim(),
        submittedDate: row.SubmittedDate ? new Date(row.SubmittedDate).getTime() : null,
        submittedBy: (row.SubmittedBy || "").trim(),
        lastModifiedDate: row.LastModifiedDate ? new Date(row.LastModifiedDate).getTime() : null,
        lastModifiedBy: (row.LastModifiedBy || "").trim(),
      };
    }).filter((r) => r.opportunityId && r.lenderName);
  } catch (e) {
    console.warn("Failed to parse funding source data:", e);
    return [];
  }
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

function StatCard({ label, value, sub, icon: Icon, tone = "neutral", tooltip }) {
  const toneColor = { neutral: "#1D2433", good: "#1E7A3D", bad: "#B3261E", accent: "#1D4E89" }[tone];
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4 flex flex-col gap-1 min-w-0" title={tooltip}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-[#6B7280] font-semibold">{label}</span>
        {Icon && <Icon size={14} color="#9AA3AF" />}
      </div>
      <span className="text-2xl font-semibold tabular-nums" style={{ color: toneColor }}>{value}</span>
      {sub && <span className="text-[12px] text-[#8A93A3]">{sub}</span>}
    </div>
  );
}

// Custom Recharts tooltip for the avg-time bar charts: shows the average
// time in both days and hours together, since "1.09 days" alone isn't as
// immediately intuitive as also seeing "26.2 hours" alongside it.
function TimeChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const avgEntry = payload.find((p) => p.dataKey === "avg");
  const countEntry = payload.find((p) => p.dataKey === "count");
  const days = avgEntry ? avgEntry.value : null;
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card px-3 py-2 shadow-sm" style={{ fontSize: 12 }}>
      <div className="font-semibold text-[#1D2433] mb-1">{label}</div>
      {days !== null && (
        <>
          <div className="text-[#4B5563]">Avg time: {fmtDays(days)}</div>
          <div className="text-[#8A93A3]">({days.toFixed(2)} days)</div>
        </>
      )}
      {countEntry && <div className="text-[#8A93A3] mt-0.5">{countEntry.value} deals</div>}
    </div>
  );
}

// Tooltip for the volume-mode chart: just shows the deal/action count
// clearly, no time-unit conversion needed.
function VolumeChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const countEntry = payload.find((p) => p.dataKey === "count");
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card px-3 py-2 shadow-sm" style={{ fontSize: 12 }}>
      <div className="font-semibold text-[#1D2433] mb-1">{label}</div>
      {countEntry && <div className="text-[#4B5563]">{countEntry.value} deals / actions</div>}
    </div>
  );
}

// ---------- Sales analysis (pure functions) ----------
// Inclusive date-range test. With no dates set, everything passes (even a
// missing date); once a bound is set, a missing date fails.
function inDateRange(ms, fromStr, toStr) {
  if (!fromStr && !toStr) return true;
  if (ms === null || ms === undefined) return false;
  if (fromStr && ms < new Date(fromStr).getTime()) return false;
  if (toStr && ms > new Date(toStr).getTime() + 86400000 - 1) return false;
  return true;
}
function pctChange(cur, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  return (cur - prev) / prev;
}
// Periods are calendar months or Monday-start weeks, all in UTC.
function periodStart(ms, kind) {
  const d = new Date(ms);
  if (kind === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}
function nextPeriodStart(startMs, kind) {
  if (kind === "month") { const d = new Date(startMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
  return startMs + 7 * 86400000;
}
function prevPeriodStart(startMs, kind) {
  if (kind === "month") { const d = new Date(startMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); }
  return startMs - 7 * 86400000;
}
function periodLabel(startMs, kind) {
  const d = new Date(startMs);
  return kind === "month"
    ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    : "Wk of " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// The list of periods a trend covers: the Period dates if set, otherwise the
// last N periods (or everything since the earliest data point for "all").
function trendPeriodList(kind, range, dateFrom, dateTo, now, minMs) {
  const currentStart = periodStart(now, kind);
  const endStart = dateTo ? periodStart(new Date(dateTo).getTime(), kind) : currentStart;
  let startStart;
  if (dateFrom) startStart = periodStart(new Date(dateFrom).getTime(), kind);
  else if (range === "all") startStart = Number.isFinite(minMs) ? periodStart(minMs, kind) : endStart;
  else {
    startStart = endStart;
    for (let i = 1; i < Number(range); i++) startStart = prevPeriodStart(startStart, kind);
  }
  const periods = [];
  for (let s = startStart; s <= endStart; s = nextPeriodStart(s, kind)) {
    periods.push({ start: s, label: periodLabel(s, kind), inProgress: s === currentStart });
    if (periods.length > 700) break;
  }
  return periods;
}

// Originations (by CREATED date) and fundings (deals now at a funded
// stage, by CLOSE date) per period, per rep.
function buildTrend(rows, reps, { kind, range, dateFrom, dateTo, now }) {
  const counts = {};
  reps.forEach((rep) => { counts[rep] = { orig: new Map(), fund: new Map() }; });
  let minMs = Infinity;
  rows.forEach((r) => {
    const c = counts[r.owner];
    if (!c) return;
    if (r.created) {
      const k = periodStart(r.created, kind);
      c.orig.set(k, (c.orig.get(k) || 0) + 1);
      if (r.created < minMs) minMs = r.created;
    }
    if (SALES_FUNDED_STAGES.has(r.stage) && r.closeMs) {
      const k = periodStart(r.closeMs, kind);
      c.fund.set(k, (c.fund.get(k) || 0) + 1);
      if (r.closeMs < minMs) minMs = r.closeMs;
    }
  });
  const periods = trendPeriodList(kind, range, dateFrom, dateTo, now, minMs);
  const series = {};
  reps.forEach((rep) => {
    series[rep] = {
      orig: periods.map((p) => counts[rep].orig.get(p.start) || 0),
      fund: periods.map((p) => counts[rep].fund.get(p.start) || 0),
    };
  });
  return { periods, series };
}

// Buckets the free-form Origination Source value into the three groups
// the sales team cares about. Matching is by keyword, so adjust here if the
// real picklist values use different wording.
function classifyOrigination(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "Not specified";
  if (s.includes("vendor")) return "Vendor referred";
  if (s.includes("broker")) return "Broker";
  if (s.includes("end user") || s.includes("end-user") || s.includes("enduser") || s.includes("direct")) return "End user";
  return "Other";
}

// ---------- Call stats (the daily per-rep table the Apps Script builds) ----------
// calls_daily columns: Date (Pacific day), Rep, Outbound, OutboundAnswered,
// InboundAnswered, InboundMissed, TalkSeconds.
function parseCallsDaily(text) {
  try {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    const num = (v) => { const x = parseFloat(String(v || "").replace(/,/g, "")); return Number.isNaN(x) ? 0 : x; };
    return lines.slice(1).map((l) => {
      const cells = parseCsvLine(l);
      const row = {};
      headers.forEach((h, i) => (row[h] = cells[i] !== undefined ? cells[i] : ""));
      return {
        date: (row.Date || "").trim(),
        rep: canonicalSalesRep(row.Rep),
        outbound: num(row.Outbound),
        outAnswered: num(row.OutboundAnswered),
        inAnswered: num(row.InboundAnswered),
        inMissed: num(row.InboundMissed),
        talkSeconds: num(row.TalkSeconds),
      };
    }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  } catch (e) {
    console.warn("Failed to parse call data:", e);
    return [];
  }
}
// yyyy-mm-dd strings compare correctly as text.
function inDateStringRange(dateStr, fromStr, toStr) {
  if (fromStr && dateStr < fromStr) return false;
  if (toStr && dateStr > toStr) return false;
  return true;
}
function callTotals(rows) {
  const t = { dials: 0, outAnswered: 0, inAnswered: 0, inMissed: 0, talkSeconds: 0 };
  rows.forEach((r) => {
    t.dials += r.outbound; t.outAnswered += r.outAnswered; t.inAnswered += r.inAnswered;
    t.inMissed += r.inMissed; t.talkSeconds += r.talkSeconds;
  });
  const answered = t.outAnswered + t.inAnswered;
  return {
    ...t,
    answered,
    connectRate: t.dials ? t.outAnswered / t.dials : null,
    avgTalkSeconds: answered ? t.talkSeconds / answered : null,
  };
}
function fmtMinutes(seconds, decimals = 0) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  return `${(seconds / 60).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} min`;
}
function fmtRatio(v) { return v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(1); }

// Call activity per period per rep. Also returns byStart so a rep's panel
// can look values up by period regardless of how the window was chosen.
function buildCallsTrend(rows, reps, { kind, range, dateFrom, dateTo, now }) {
  const byRep = {};
  reps.forEach((rep) => { byRep[rep] = new Map(); });
  let minMs = Infinity;
  rows.forEach((r) => {
    const m = byRep[r.rep];
    if (!m) return;
    const ms = Date.UTC(+r.date.slice(0, 4), +r.date.slice(5, 7) - 1, +r.date.slice(8, 10));
    const k = periodStart(ms, kind);
    const cur = m.get(k) || { dials: 0, connected: 0, missed: 0, talkSeconds: 0, volume: 0 };
    cur.dials += r.outbound;
    cur.connected += r.outAnswered + r.inAnswered;
    cur.missed += r.inMissed;
    cur.volume += r.outbound + r.inAnswered + r.inMissed;
    cur.talkSeconds += r.talkSeconds;
    m.set(k, cur);
    if (ms < minMs) minMs = ms;
  });
  const periods = trendPeriodList(kind, range, dateFrom, dateTo, now, minMs);
  const zero = { dials: 0, connected: 0, missed: 0, talkSeconds: 0, volume: 0 };
  const series = {};
  const byStart = {};
  reps.forEach((rep) => {
    const at = (p) => byRep[rep].get(p.start) || zero;
    series[rep] = {
      dials: periods.map((p) => at(p).dials),
      connected: periods.map((p) => at(p).connected),
      missed: periods.map((p) => at(p).missed),
      volume: periods.map((p) => at(p).volume),
      talk: periods.map((p) => Math.round((at(p).talkSeconds / 60) * 10) / 10),
    };
    byStart[rep] = {};
    periods.forEach((p) => { byStart[rep][p.start] = at(p); });
  });
  return { periods, series, byStart };
}

// Everything shown in a rep's drill-down panel. Cancelled reasons, mix and
// industry use deals CREATED in the period; top originators use deals
// FUNDED in the period (by close date).
function computeRepAnalysis(rows, rep, dateFrom, dateTo) {
  const mine = rows.filter((r) => r.owner === rep);
  const created = mine.filter((r) => inDateRange(r.created, dateFrom, dateTo));
  const byCountDesc = (a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label));

  const cancelled = created.filter((r) => SALES_CANCELLED_STAGES.has(r.stage));
  const reasonCounts = {};
  cancelled.forEach((r) => { const k = r.reasonLost || "No reason given"; reasonCounts[k] = (reasonCounts[k] || 0) + 1; });
  const reasons = Object.entries(reasonCounts)
    .map(([label, count]) => ({ label, count, pct: count / cancelled.length }))
    .sort(byCountDesc);

  const mixCounts = {};
  const otherRaw = {};
  created.forEach((r) => {
    const b = classifyOrigination(r.originationSource);
    mixCounts[b] = (mixCounts[b] || 0) + 1;
    if (b === "Other") otherRaw[r.originationSource] = (otherRaw[r.originationSource] || 0) + 1;
  });
  const core = ["Vendor referred", "Broker", "End user"];
  const mix = ["Vendor referred", "Broker", "End user", "Other", "Not specified"]
    .map((label) => ({ label, count: mixCounts[label] || 0, pct: created.length ? (mixCounts[label] || 0) / created.length : null }))
    .filter((m) => m.count > 0 || core.includes(m.label));
  const otherSources = Object.entries(otherRaw).sort((a, b) => b[1] - a[1]);

  const indCounts = {};
  let industryFilled = 0;
  created.forEach((r) => { if (r.industry) { industryFilled += 1; indCounts[r.industry] = (indCounts[r.industry] || 0) + 1; } });
  const industry = Object.entries(indCounts)
    .map(([label, count]) => ({ label, count, pct: count / created.length }))
    .sort(byCountDesc).slice(0, 5);
  if (industryFilled && industryFilled < created.length) {
    industry.push({ label: "Not specified", count: created.length - industryFilled, pct: (created.length - industryFilled) / created.length });
  }

  const funded = mine.filter((r) => SALES_FUNDED_STAGES.has(r.stage) && inDateRange(r.closeMs, dateFrom, dateTo));
  const brokerCounts = {};
  let noBroker = 0;
  funded.forEach((r) => { if (r.broker) brokerCounts[r.broker] = (brokerCounts[r.broker] || 0) + 1; else noBroker += 1; });
  const ranked = Object.entries(brokerCounts).map(([label, count]) => ({ label, count })).sort(byCountDesc);
  const fundedTotal = funded.length;
  const share = (n) => (fundedTotal ? n / fundedTotal : null);
  const top = ranked.slice(0, 5).map((o) => ({ ...o, pct: share(o.count) }));
  const rest = ranked.slice(5);
  const otherCount = rest.reduce((s, o) => s + o.count, 0);

  return {
    dealsInPeriod: created.length,
    cancelledTotal: cancelled.length,
    reasons,
    mix,
    otherSources,
    industryFilled,
    industry,
    fundedTotal,
    originators: {
      top,
      otherBrokers: { count: otherCount, brokers: rest.length, pct: share(otherCount) },
      noBroker: { count: noBroker, pct: share(noBroker) },
    },
  };
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="inline-flex items-center border border-[#D8DCE3] rounded-lg overflow-hidden">
      {options.map(([v, label], i) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`text-[12px] font-semibold px-4 py-1.5 transition-colors ${i > 0 ? "border-l border-[#D8DCE3]" : ""} ${
            value === v ? "bg-[#1D4E89] text-white" : "bg-white text-[#4B5563] hover:bg-[#F6F7F9]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function DeltaChip({ cur, prev, muted }) {
  const change = pctChange(cur, prev);
  if (change === null) return <span className="text-[#AAB1BC] text-[11px]">—</span>;
  const up = change >= 0;
  const color = muted ? "#8A93A3" : up ? "#1E7A3D" : "#B3261E";
  return <span style={{ color }} className="text-[11px] font-medium">{up ? "▲" : "▼"} {Math.abs(change * 100).toFixed(0)}%</span>;
}

// Per-rep call series for the chart and table when call data is included:
// call volume (outbound dials + inbound answered + inbound missed) and talk
// minutes for each rep and period. Nothing is added up across reps. Values
// are looked up by period start so they line up with the sales trend however
// its window was chosen.
function buildCallSeriesByRep(periods, reps, byStart) {
  const out = {};
  reps.forEach((rep) => {
    const volume = [];
    const talk = [];
    periods.forEach((p) => {
      const x = byStart[rep] && byStart[rep][p.start];
      volume.push(x ? x.volume : 0);
      talk.push(x ? Math.round((x.talkSeconds / 60) * 10) / 10 : 0);
    });
    out[rep] = { volume, talk };
  });
  return out;
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg px-3 py-2 shadow-sm" style={{ fontSize: 12 }}>
      <div className="font-semibold text-[#1D2433] mb-1">{label}{p.inProgress ? " (in progress)" : ""}</div>
      {payload.map((e) => <div key={e.dataKey} style={{ color: e.color }}>{e.dataKey}: {e.value}</div>)}
      {!p.callMode && (p.both
        ? payload.length > 2 && <div className="text-[#4B5563] mt-0.5">Total: {p.totalOrig} originated · {p.totalFund} funded</div>
        : payload.length > 1 && <div className="text-[#4B5563] mt-0.5">Total: {p.total}</div>)}
    </div>
  );
}

// Period-by-period counts (most recent first) with a MoM or WoW % change
// next to every number.
function TrendTable({ periods, reps, series, metricKeys, kind }) {
  const metricLabel = { orig: "Originated", fund: "Funded", callVol: "Calls", talkMin: "Talk min" };
  const multi = metricKeys.length > 1;
  // values[repIndex][metricIndex]; totals[metricIndex]
  const rows = periods.map((p, i) => {
    const values = reps.map((rep) => metricKeys.map((k) => series[rep][k][i]));
    const totals = metricKeys.map((_, m) => values.reduce((s, v) => s + v[m], 0));
    return { p, i, values, totals };
  });
  const deltaLabel = kind === "month" ? "MoM" : "WoW";
  const edge = multi ? { borderLeft: "1px solid #EEF0F3" } : undefined;
  const groups = reps.length > 1 ? [...reps, "__total"] : reps;
  return (
    <div className="overflow-x-auto mt-4 border-t border-[#EEF0F3] pt-3">
      <p className="text-[11px] text-[#8A93A3] mb-2">Each number is followed by its {deltaLabel} change versus the prior {kind}. The current {kind} is still in progress.</p>
      <table className="kpi-table">
        <thead>
          <tr>
            <th rowSpan={multi ? 2 : 1}>{kind === "month" ? "Month" : "Week"}</th>
            {reps.map((rep) => (
              <th key={rep} colSpan={metricKeys.length} style={edge}>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorForLender(rep, SALES_REP_NAMES) }}></span>
                  {rep}
                </span>
              </th>
            ))}
            {reps.length > 1 && <th colSpan={metricKeys.length} style={edge}>Total</th>}
          </tr>
          {multi && (
            <tr>
              {groups.flatMap((g) => metricKeys.map((k, m) => (
                <th key={g + k} style={m === 0 ? edge : undefined}>{metricLabel[k]}</th>
              )))}
            </tr>
          )}
        </thead>
        <tbody>
          {[...rows].reverse().map(({ p, i, values, totals }) => (
            <tr key={p.start}>
              <td className="font-medium whitespace-nowrap">
                {p.label}{p.inProgress && <span className="ml-1.5"><Pill tone="neutral">in progress</Pill></span>}
              </td>
              {values.flatMap((vs, j) => vs.map((v, m) => (
                <td key={reps[j] + metricKeys[m]} className="mono whitespace-nowrap" style={m === 0 ? edge : undefined}>
                  {v} <DeltaChip cur={v} prev={i > 0 ? rows[i - 1].values[j][m] : null} muted={p.inProgress} />
                </td>
              )))}
              {reps.length > 1 && totals.map((t, m) => (
                <td key={"total" + m} className="mono font-semibold whitespace-nowrap" style={m === 0 ? edge : undefined}>
                  {t} <DeltaChip cur={t} prev={i > 0 ? rows[i - 1].totals[m] : null} muted={p.inProgress} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PctBar({ pct, color }) {
  return (
    <div className="h-1.5 rounded bg-[#EEF0F3] overflow-hidden">
      <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, (pct || 0) * 100))}%`, background: color }} />
    </div>
  );
}
function BreakdownRows({ rows, color }) {
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="text-[#1D2433] truncate" title={r.label}>{r.label}</span>
            <span className="mono text-[#4B5563] whitespace-nowrap">{r.count} · {r.pct === null ? "—" : `${(r.pct * 100).toFixed(1)}%`}</span>
          </div>
          <PctBar pct={r.pct} color={color} />
        </div>
      ))}
    </div>
  );
}
function AnalysisCard({ title, subtitle, children, className = "" }) {
  return (
    <div className={`bg-white border border-[#E4E7EC] rounded-lg p-4 ${className}`}>
      <h3 className="text-[12px] font-semibold text-[#1D2433]">{title}</h3>
      <p className="text-[11px] text-[#8A93A3] mt-0.5 mb-3">{subtitle}</p>
      {children}
    </div>
  );
}

// ---------- Ask the data (rule-based analytics Q&A) ----------
// A deliberately narrow question answerer: calls vs deals, by rep and period.
// It is NOT a language model. It finds a rep, a period and a metric in the
// question and answers from the data already loaded in the browser (nothing
// is sent anywhere), using the same rules as the cards and tables.
const ASK_REP_WORDS = [
  { name: "Chase Brannon", words: ["chase"] },
  { name: "Gregory Lamb", words: ["greg", "gregory", "lamb"] },
  { name: "Jeff Brannon", words: ["jeff", "jeffrey"] },
  { name: "Maria Mendoza", words: ["maria", "mendoza"] },
  { name: "Ryan Lamastra", words: ["ryan", "lamastra"] },
];
const ASK_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ASK_CALL_KEYS = ["dials", "volume", "answered", "missed", "inbound", "talk"];
const ASK_KEY_ORDER = ["dials", "volume", "answered", "missed", "inbound", "talk", "originations", "fundings"];
const ASK_COLUMNS = {
  dials: { label: "Dials", short: "Dials", phrase: "dials", one: "dial", def: "Dials are outbound calls placed." },
  volume: { label: "Calls (in + out)", short: "Calls", phrase: "calls (in + out)", one: "call (in + out)", def: "Calls (in + out) counts every call handled, outbound and inbound." },
  answered: { label: "Answered (in + out)", short: "Answered", phrase: "answered calls", one: "answered call", def: "Answered means the call was picked up, any length." },
  missed: { label: "Missed inbound", short: "Missed", phrase: "missed inbound calls", one: "missed inbound call", def: "Missed inbound counts inbound calls nobody picked up." },
  inbound: { label: "Inbound calls", short: "Inbound", phrase: "inbound calls", one: "inbound call", def: "Inbound counts answered and missed inbound calls." },
  talk: { label: "Talk min", short: "Talk min", phrase: "talk minutes", one: "talk minute", def: "Talk time counts answered calls only." },
  originations: { label: "Originations", short: "Originations", phrase: "originations", one: "origination", def: "Originations are deals created in the period." },
  fundings: { label: "Fundings", short: "Fundings", phrase: "fundings", one: "funding", def: "Fundings are deals now at a funded stage with a close date in the period." },
};
const askPad = (n) => String(n).padStart(2, "0");

// Pacific calendar date (yyyy-mm-dd) of a UTC instant, using the same US
// daylight-time rules the Apps Script uses for call days.
function pacificDateOf(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const nthSunday = (monthIndex, n) => 1 + ((7 - new Date(Date.UTC(y, monthIndex, 1)).getUTCDay()) % 7) + (n - 1) * 7;
  const start = Date.UTC(y, 2, nthSunday(2, 2), 10, 0, 0);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 9, 0, 0);
  const d = new Date(utcMs + (utcMs >= start && utcMs < end ? -7 : -8) * 3600000);
  return `${d.getUTCFullYear()}-${askPad(d.getUTCMonth() + 1)}-${askPad(d.getUTCDate())}`;
}
function dsToMs(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
function dsFromMs(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${askPad(d.getUTCMonth() + 1)}-${askPad(d.getUTCDate())}`; }
function dsAdd(s, days) { return dsFromMs(dsToMs(s) + days * 86400000); }
function dsMonthEnd(y, m1) { return dsFromMs(Date.UTC(y, m1, 0)); }
function dsShort(s) { return new Date(dsToMs(s)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); }
function askRangeLabel(from, to) {
  if (!from && !to) return "all loaded data";
  if (from === to) return `${dsShort(from)}, ${from.slice(0, 4)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${dsShort(from)} – ${dsShort(to)}, ${to.slice(0, 4)}`;
  return `${dsShort(from)}, ${from.slice(0, 4)} – ${dsShort(to)}, ${to.slice(0, 4)}`;
}

// Every period phrase in the question, in the order it appears. Weeks start
// Monday. Current periods run through today.
function resolveAskPeriods(q, today) {
  const ty = +today.slice(0, 4);
  const tm = +today.slice(5, 7);
  const found = [];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const mk = (label, from, to) => ({ label, from, to, text: `${label} (${askRangeLabel(from, to)})` });
  const add = (index, p) => found.push({ index, p });
  const first = (re) => re.exec(q);
  const monthPeriod = (y, m1) => {
    const cur = y === ty && m1 === tm;
    return mk(`${cap(ASK_MONTH_NAMES[m1 - 1])} ${y}${cur ? " so far" : ""}`, `${y}-${askPad(m1)}-01`, cur ? today : dsMonthEnd(y, m1));
  };
  const quarterPeriod = (y, q1) => {
    const startM = (q1 - 1) * 3 + 1;
    const to = dsMonthEnd(y, startM + 2);
    return mk(`Q${q1} ${y}`, `${y}-${askPad(startM)}-01`, to > today ? today : to);
  };
  const dow = (new Date(dsToMs(today)).getUTCDay() + 6) % 7;
  const weekStart = dsAdd(today, -dow);
  const curQuarter = Math.floor((tm - 1) / 3) + 1;

  let m;
  if ((m = first(/\btoday\b/))) add(m.index, mk("Today", today, today));
  if ((m = first(/\byesterday\b/))) add(m.index, mk("Yesterday", dsAdd(today, -1), dsAdd(today, -1)));
  if ((m = first(/\bthis week\b/))) add(m.index, mk("This week so far", weekStart, today));
  if ((m = first(/\blast week\b/))) add(m.index, mk("Last week", dsAdd(weekStart, -7), dsAdd(weekStart, -1)));
  if ((m = first(/\bthis month\b/))) add(m.index, monthPeriod(ty, tm));
  if ((m = first(/\blast month\b/))) add(m.index, tm === 1 ? monthPeriod(ty - 1, 12) : monthPeriod(ty, tm - 1));
  if ((m = first(/\bthis year\b|\bytd\b|\byear to date\b/))) add(m.index, mk("This year so far", `${ty}-01-01`, today));
  if ((m = first(/\blast year\b/))) add(m.index, mk(`${ty - 1}`, `${ty - 1}-01-01`, `${ty - 1}-12-31`));
  if ((m = first(/\bthis quarter\b/))) add(m.index, quarterPeriod(ty, curQuarter));
  if ((m = first(/\blast quarter\b/))) add(m.index, curQuarter === 1 ? quarterPeriod(ty - 1, 4) : quarterPeriod(ty, curQuarter - 1));
  if ((m = first(/\blast (\d+) (day|days|week|weeks|month|months)\b/))) {
    const n = Math.max(1, Math.min(+m[1], 400));
    if (m[2].indexOf("day") === 0) add(m.index, mk(`Last ${n} days`, dsAdd(today, -(n - 1)), today));
    else if (m[2].indexOf("week") === 0) add(m.index, mk(`Last ${n} weeks`, dsAdd(today, -(7 * n - 1)), today));
    else {
      // the last N full calendar months before this one
      const endIdx = ty * 12 + (tm - 1) - 1;
      const startIdx = endIdx - (n - 1);
      const sy = Math.floor(startIdx / 12), sm = (startIdx % 12) + 1, ey = Math.floor(endIdx / 12), em = (endIdx % 12) + 1;
      add(m.index, mk(`Last ${n} full months`, `${sy}-${askPad(sm)}-01`, dsMonthEnd(ey, em)));
    }
  }
  const qre = /\bq([1-4])(?:\s*(\d{4}))?\b/g;
  while ((m = qre.exec(q))) add(m.index, quarterPeriod(m[2] ? +m[2] : ty, +m[1]));
  const mre = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b(?:\s+(\d{4}))?/g;
  while ((m = mre.exec(q))) {
    const word = m[1];
    // "may" is also a verb: only treat it as the month after a preposition or before a year
    if (word === "may" && !m[2] && !/\b(in|for|during|of|from|through|to|since)\s+$/.test(q.slice(0, m.index))) continue;
    const idx = ASK_MONTH_NAMES.findIndex((n) => n === word || n.slice(0, 3) === word.slice(0, 3));
    if (idx < 0) continue;
    let y = m[2] ? +m[2] : ty;
    if (!m[2] && idx + 1 > tm) y = ty - 1; // a month later than this one means last year's
    add(m.index, monthPeriod(y, idx + 1));
  }
  if ((m = first(/\ball time\b|\bever\b|\boverall\b|\bto date\b/))) add(m.index, { label: "All time", from: null, to: null, text: "All loaded data" });

  found.sort((a, b) => a.index - b.index);
  const seen = {};
  return found.filter((f) => (seen[f.p.label] ? false : (seen[f.p.label] = true))).map((f) => f.p);
}

function detectAskMetrics(q) {
  const has = (re) => re.test(q);
  const m = [];
  if (has(/\btalk(ing)?\b|\bminutes?\b|time on (the )?phone|call length|call time/)) m.push("talk");
  if (has(/\bmissed\b/)) m.push("missed");
  if (has(/\banswer(ed)?\b|\bpicked up\b|\bconnect(ed|s)?\b/)) m.push("answered");
  if (has(/\binbound\b|\bincoming\b|\breceived\b/)) m.push("inbound");
  if (has(/\bdial(s|ed|led)?\b|\boutbound\b|\bcalls? (made|placed)\b|\b(make|made|makes|making|place|placed)\b[^?.]*\bcalls?\b|\bcalls?\b[^?.]*\b(make|made|makes|making|place|placed)\b/)) m.push("dials");
  if (has(/\bcalls?\b/) && !m.some((k) => ASK_CALL_KEYS.indexOf(k) !== -1)) m.push("volume");
  const funding = has(/\bfund(ed|ing|ings)?\b/);
  if (funding) m.push("fundings");
  if (has(/\boriginat|\bnew deals?\b|\bdeals? (created|opened|originated)\b/) || (!funding && has(/\bdeals?\b/))) m.push("originations");
  return m.filter((k, i) => m.indexOf(k) === i);
}

// The same rules as the Sales tab: calls by Pacific day, deals created by
// created date, fundings = deals at a funded stage with a close date in range.
function askMeasures(rep, p, ctx) {
  let dials = 0, outAnswered = 0, inAnswered = 0, inMissed = 0, talkSeconds = 0;
  ctx.calls.forEach((r) => {
    if (r.rep !== rep || !inDateStringRange(r.date, p.from, p.to)) return;
    dials += r.outbound; outAnswered += r.outAnswered; inAnswered += r.inAnswered; inMissed += r.inMissed; talkSeconds += r.talkSeconds;
  });
  let originations = 0, fundings = 0;
  ctx.sales.forEach((r) => {
    if (r.owner !== rep) return;
    if (inDateRange(r.created, p.from, p.to)) originations += 1;
    if (SALES_FUNDED_STAGES.has(r.stage) && inDateRange(r.closeMs, p.from, p.to)) fundings += 1;
  });
  return { dials, volume: dials + inAnswered + inMissed, answered: outAnswered + inAnswered, missed: inMissed, inbound: inAnswered + inMissed, talk: talkSeconds / 60, originations, fundings };
}

// Returns { ok: true, headline, columns, rows, notes } or { ok: false, message }.
// ctx = { reps, sales, calls, nowMs }.
function answerQuestion(question, ctx) {
  const q = String(question || "").toLowerCase().trim();
  const help = 'I can answer questions about calls (dials, answered, missed, inbound, talk time) and deals (originations, fundings) for a rep and a period. Try "How many calls did Jeff make this month compared to fundings?" or "Who made the most calls last week?"';
  if (!q) return { ok: false, message: help };

  const words = q.match(/[a-z']+/g) || [];
  const named = ASK_REP_WORDS.filter((r) => r.words.some((w) => words.indexOf(w) !== -1)).map((r) => r.name);
  const everyone = /\b(everyone|everybody|all reps|all the reps|all of the reps|each rep|every rep|the team|our team|all of them|per rep|by rep|the reps|reps)\b/.test(q);
  if (words.indexOf("brannon") !== -1 && named.indexOf("Jeff Brannon") === -1 && named.indexOf("Chase Brannon") === -1) {
    return { ok: false, message: "Which Brannon: Jeff or Chase?" };
  }
  const reps = named.length && !everyone ? ctx.reps.filter((r) => named.indexOf(r) !== -1) : ctx.reps;
  if (!reps.length) return { ok: false, message: help };

  const metrics = detectAskMetrics(q);
  if (!metrics.length) return { ok: false, message: "I'm not sure which numbers you want. " + help };
  const callKeys = metrics.filter((k) => ASK_CALL_KEYS.indexOf(k) !== -1);
  const dealKeys = metrics.filter((k) => ASK_CALL_KEYS.indexOf(k) === -1);
  if (callKeys.length && !ctx.calls.length) return { ok: false, message: "Call data isn't loaded yet. Run rollUpCallsDaily in the Apps Script, then reload this page." };
  if (dealKeys.length && !ctx.sales.length) return { ok: false, message: "Sales data isn't loaded yet. Reload this page once the sync has run." };

  const today = pacificDateOf(ctx.nowMs);
  let periods = resolveAskPeriods(q, today);
  const assumedPeriod = periods.length === 0;
  if (assumedPeriod) periods = resolveAskPeriods("this month", today);
  const multiPeriod = periods.length > 1;

  const keys = ASK_KEY_ORDER.filter((k) => metrics.indexOf(k) !== -1);
  const callKey = keys.find((k) => ASK_CALL_KEYS.indexOf(k) !== -1);
  const dealKey = keys.indexOf("fundings") !== -1 ? "fundings" : keys.indexOf("originations") !== -1 ? "originations" : null;
  const ratio = callKey && dealKey;
  const n0 = (v) => Math.round(v).toLocaleString("en-US");
  const fmt = (k, v) => (k === "talk" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : n0(v));
  const ratioText = (m) => (m[dealKey] ? (m[callKey] / m[dealKey]).toFixed(1) : "—");

  const rows = [];
  periods.forEach((p) => reps.forEach((rep) => rows.push({ rep, p, m: askMeasures(rep, p, ctx) })));

  // "who made the most ..." ranks the reps on the first metric asked
  const sup = /\b(most|highest|top|best|biggest|least|lowest|fewest|worst)\b/.exec(q);
  const ranking = !!sup && !multiPeriod && reps.length > 1;
  const asc = ranking && /least|lowest|fewest|worst/.test(sup[1]);
  if (ranking) rows.sort((a, b) => (asc ? 1 : -1) * (a.m[keys[0]] - b.m[keys[0]]) || a.rep.localeCompare(b.rep));

  const columns = ["Rep", ...(multiPeriod ? ["Period"] : []), ...keys.map((k) => ASK_COLUMNS[k].label), ...(ratio ? [`${ASK_COLUMNS[callKey].short} per ${dealKey === "fundings" ? "funding" : "origination"}`] : [])];
  const table = rows.map((r) => [r.rep, ...(multiPeriod ? [r.p.label] : []), ...keys.map((k) => fmt(k, r.m[k])), ...(ratio ? [ratioText(r.m)] : [])]);

  const periodText = periods.map((p) => p.text).join(" vs ");
  const phrase = (k, v) => `${fmt(k, v)} ${Math.round(v) === 1 && k !== "talk" ? ASK_COLUMNS[k].one : ASK_COLUMNS[k].phrase}`;
  let headline;
  if (ranking) {
    const lead = rows[0];
    headline = !asc && lead.m[keys[0]] === 0
      ? `Nobody has any ${ASK_COLUMNS[keys[0]].phrase} for ${periodText}.`
      : `${lead.rep} has the ${asc ? "lowest" : "highest"} ${ASK_COLUMNS[keys[0]].phrase} for ${periodText}: ${fmt(keys[0], lead.m[keys[0]])}.`;
  } else if (reps.length === 1 && !multiPeriod) {
    const m = rows[0].m;
    headline = `${reps[0]}, ${periodText}: ${keys.map((k) => phrase(k, m[k])).join(" · ")}${ratio && m[dealKey] ? ` (${ratioText(m)} ${ASK_COLUMNS[callKey].phrase} per ${dealKey === "fundings" ? "funding" : "origination"})` : ""}.`;
  } else {
    headline = `${keys.map((k) => ASK_COLUMNS[k].phrase).join(" and ")} ${reps.length > 1 ? "by rep" : "for " + reps[0]}, ${periodText}.`;
  }

  const notes = [];
  if (named.length === 0 && !everyone) notes.push(`No rep named, so this covers all ${ctx.reps.length} reps.`);
  if (assumedPeriod) notes.push(`No period given, so I used ${periods[0].text}.`);
  keys.forEach((k) => notes.push(ASK_COLUMNS[k].def));
  if (callKeys.length) {
    const minDate = ctx.calls.reduce((lo, r) => (r.date < lo ? r.date : lo), "9999-99-99");
    if (periods.some((p) => p.from && p.from < minDate)) notes.push(`Call data only starts on ${minDate}; earlier days show 0.`);
  }
  notes.push("Answers use all loaded data and ignore the filters above.");
  return { ok: true, headline, columns, rows: table, notes };
}

function AskData({ reps, sales, calls }) {
  const [text, setText] = useState("");
  const [log, setLog] = useState([]);
  const endRef = useRef(null);
  const examples = [
    "How many calls did Jeff make this month compared to fundings?",
    "Who made the most calls last week?",
    "Talk time for everyone in September",
  ];
  const ask = (raw) => {
    const q = String(raw === undefined ? text : raw).trim();
    if (!q) return;
    const a = answerQuestion(q, { reps, sales, calls, nowMs: Date.now() });
    setLog((prev) => [...prev, { q, a }].slice(-6));
    setText("");
  };
  useEffect(() => {
    if (log.length && endRef.current && endRef.current.scrollIntoView) endRef.current.scrollIntoView({ block: "nearest" });
  }, [log]);
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[13px] font-semibold text-[#1D2433]">Ask the data</h2>
          <p className="text-[12px] text-[#8A93A3] mt-0.5">Calls vs deals, by rep and period. Answers come straight from the loaded data and follow the same rules as the numbers on this tab.</p>
        </div>
        {log.length > 0 && (
          <button type="button" onClick={() => setLog([])} className="text-[12px] text-[#6B7280] hover:underline">Clear</button>
        )}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex items-center gap-2 mt-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. How many calls did Jeff make this month compared to fundings?"
          aria-label="Ask a question about calls and deals"
          className="flex-1 min-w-0 text-[13px] border border-[#D8DCE3] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#1D4E89]"
        />
        <button type="submit" className="text-[13px] font-semibold text-white bg-[#1D4E89] rounded-lg px-4 py-2 hover:bg-[#183F6E] transition-colors">Ask</button>
      </form>
      <div className="flex flex-wrap gap-2 mt-2">
        {examples.map((ex) => (
          <button key={ex} type="button" onClick={() => ask(ex)} className="text-[11px] text-[#1D4E89] bg-[#EEF4FB] border border-[#D6E4F5] rounded-full px-3 py-1 hover:bg-[#E2EDF9] transition-colors">{ex}</button>
        ))}
      </div>
      {log.length > 0 && (
        <div className="mt-3 flex flex-col gap-3 max-h-80 overflow-y-auto pr-1">
          {log.map((m, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="self-end max-w-[85%] text-[12px] text-[#1D2433] bg-[#EEF4FB] rounded-lg px-3 py-1.5">{m.q}</div>
              <div className="self-start max-w-full text-[12px] text-[#1D2433] bg-[#F6F7F9] border border-[#E4E7EC] rounded-lg px-3 py-2">
                {m.a.ok ? (
                  <>
                    <div className="font-medium">{m.a.headline}</div>
                    {m.a.rows.length > 0 && (
                      <div className="overflow-x-auto mt-2">
                        <table className="kpi-table">
                          <thead><tr>{m.a.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                          <tbody>
                            {m.a.rows.map((r, ri) => (
                              <tr key={ri}>{r.map((c, ci) => <td key={ci} className={ci === 0 ? "font-medium whitespace-nowrap" : "mono whitespace-nowrap"}>{c}</td>)}</tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {m.a.notes.map((n, ni) => <div key={ni} className="text-[11px] text-[#8A93A3] mt-1">{n}</div>)}
                  </>
                ) : (
                  <div>{m.a.message}</div>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

// The drill-down shown when a rep's row is expanded.
function SalesRepPanel({ rep, analysis, trend, kind, onKindChange, color, calls, callTrend }) {
  const a = analysis;
  const deltaLabel = kind === "month" ? "MoM" : "WoW";
  const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const s = trend.series[rep];
  const callAt = (p) => (callTrend && callTrend.byStart[rep] && callTrend.byStart[rep][p.start]) || { dials: 0, connected: 0 };
  const trendRows = trend.periods.map((p, i) => ({ p, i, orig: s.orig[i], fund: s.fund[i], dials: callAt(p).dials, connected: callAt(p).connected }));
  const o = a.originators;
  return (
    <div className="px-5 py-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
      <AnalysisCard title="Cancelled deals by reason lost" subtitle={`${a.cancelledTotal} cancelled deal${a.cancelledTotal === 1 ? "" : "s"} (98/198) created in the period`}>
        {a.cancelledTotal === 0
          ? <p className="text-[12px] text-[#8A93A3]">No cancelled deals in this period.</p>
          : <BreakdownRows rows={a.reasons} color="#6B6257" />}
      </AnalysisCard>

      <AnalysisCard title="Origination mix" subtitle={`Share of the ${a.dealsInPeriod} deal${a.dealsInPeriod === 1 ? "" : "s"} created in the period`}>
        {a.dealsInPeriod === 0
          ? <p className="text-[12px] text-[#8A93A3]">No deals created in this period.</p>
          : <BreakdownRows rows={a.mix} color={color} />}
        {a.otherSources.length > 0 && (
          <p className="text-[11px] text-[#8A93A3] mt-2">Other includes: {a.otherSources.map(([name, n]) => `${name || "(blank)"} (${n})`).join(", ")}</p>
        )}
      </AnalysisCard>

      <AnalysisCard title="Top 5 originators of funded deals" subtitle={`Broker firm on the ${a.fundedTotal} deal${a.fundedTotal === 1 ? "" : "s"} funded in the period (by close date)`}>
        {a.fundedTotal === 0 ? (
          <p className="text-[12px] text-[#8A93A3]">No funded deals in this period.</p>
        ) : (
          <table className="kpi-table">
            <thead><tr><th>#</th><th>Broker</th><th>Funded deals</th><th>% of funded</th></tr></thead>
            <tbody>
              {o.top.map((b, i) => (
                <tr key={b.label}>
                  <td className="mono">{i + 1}</td>
                  <td className="font-medium">{b.label}</td>
                  <td className="mono">{b.count}</td>
                  <td className="mono">{pct(b.pct)}</td>
                </tr>
              ))}
              {o.otherBrokers.count > 0 && (
                <tr className="text-[#6B7280]"><td></td><td>Other brokers ({o.otherBrokers.brokers})</td><td className="mono">{o.otherBrokers.count}</td><td className="mono">{pct(o.otherBrokers.pct)}</td></tr>
              )}
              {o.noBroker.count > 0 && (
                <tr className="text-[#6B7280]"><td></td><td>No broker listed</td><td className="mono">{o.noBroker.count}</td><td className="mono">{pct(o.noBroker.pct)}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </AnalysisCard>

      <AnalysisCard title="Industry" subtitle="Top 5 by share of deals created in the period">
        {a.industryFilled === 0 ? (
          <p className="text-[12px] text-[#8A93A3]">Industry isn't in the sales sheet yet. Once the Apps Script pulls the industry field, this fills in automatically.</p>
        ) : (
          <BreakdownRows rows={a.industry} color={color} />
        )}
      </AnalysisCard>

      <AnalysisCard title="Call activity" subtitle="Calls in the period, by Pacific day. Answered means picked up, any length.">
        {!calls ? (
          <p className="text-[12px] text-[#8A93A3]">No call data loaded yet.</p>
        ) : calls.dials + calls.inAnswered + calls.inMissed === 0 ? (
          <p className="text-[12px] text-[#8A93A3]">No calls in this period.</p>
        ) : (
          <table className="kpi-table">
            <tbody>
              <tr><td>Outbound dials</td><td className="mono">{calls.dials.toLocaleString()}</td></tr>
              <tr><td>Answered outbound</td><td className="mono">{calls.outAnswered.toLocaleString()} · {pct(calls.connectRate)}</td></tr>
              <tr><td>Inbound answered</td><td className="mono">{calls.inAnswered.toLocaleString()}</td></tr>
              <tr><td>Inbound missed</td><td className="mono">{calls.inMissed.toLocaleString()}</td></tr>
              <tr><td>Talk time</td><td className="mono">{fmtMinutes(calls.talkSeconds)}</td></tr>
              <tr><td>Average call length</td><td className="mono">{fmtMinutes(calls.avgTalkSeconds, 1)}</td></tr>
              <tr><td>Dials per deal originated</td><td className="mono">{fmtRatio(calls.dialsPerDeal)}</td></tr>
              <tr><td>Dials per funded deal</td><td className="mono">{fmtRatio(calls.dialsPerFunded)}</td></tr>
            </tbody>
          </table>
        )}
      </AnalysisCard>

      <AnalysisCard className="lg:col-span-2" title={`${rep}: ${callTrend ? "originations, fundings and calls" : "originations and fundings"}, ${deltaLabel}`} subtitle={callTrend ? "Originations by created date, fundings by close date, calls by Pacific day" : "Originations by created date, fundings by close date"}>
        <div className="flex items-center gap-3 mb-3">
          <Segmented options={[["month", "Month"], ["week", "Week"]]} value={kind} onChange={onKindChange} />
        </div>
        <div className="max-h-64 overflow-y-auto">
          <table className="kpi-table">
            <thead><tr><th>{kind === "month" ? "Month" : "Week"}</th><th>Originated</th><th>Funded</th>{callTrend && <><th>Dials</th><th>Answered</th></>}</tr></thead>
            <tbody>
              {[...trendRows].reverse().map(({ p, i, orig, fund, dials, connected }) => (
                <tr key={p.start}>
                  <td className="font-medium whitespace-nowrap">{p.label}{p.inProgress && <span className="ml-1.5"><Pill tone="neutral">in progress</Pill></span>}</td>
                  <td className="mono whitespace-nowrap">{orig} <DeltaChip cur={orig} prev={i > 0 ? trendRows[i - 1].orig : null} muted={p.inProgress} /></td>
                  <td className="mono whitespace-nowrap">{fund} <DeltaChip cur={fund} prev={i > 0 ? trendRows[i - 1].fund : null} muted={p.inProgress} /></td>
                  {callTrend && (
                    <>
                      <td className="mono whitespace-nowrap">{dials} <DeltaChip cur={dials} prev={i > 0 ? trendRows[i - 1].dials : null} muted={p.inProgress} /></td>
                      <td className="mono whitespace-nowrap">{connected} <DeltaChip cur={connected} prev={i > 0 ? trendRows[i - 1].connected : null} muted={p.inProgress} /></td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AnalysisCard>
    </div>
  );
}

// Sales chart tooltip: full rep name plus the core stats on hover.
function SalesChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0] && payload[0].payload;
  if (!d) return null;
  const pct = (v) => (v === null ? "—" : `${v.toFixed(1)}%`);
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card px-3 py-2 shadow-sm" style={{ fontSize: 12 }}>
      <div className="font-semibold text-[#1D2433] mb-1">{d.fullName}</div>
      <div className="text-[#4B5563]">Deals originated: {d.deals}</div>
      <div className="text-[#4B5563]">Deal amount: {fmtMoney(d.amount)}</div>
      <div className="text-[#1E7A3D]">Funded: {d.funded} ({pct(d.conversionRate)})</div>
      <div className="text-[#B3261E]">Declined: {pct(d.declineRate)}</div>
      <div className="text-[#6B6257]">Cancelled: {pct(d.cancelRate)}</div>
    </div>
  );
}

// Lender chart tooltip: since the x-axis shows abbreviated initials only,
// this shows the full lender name plus all four core stats on hover.
function LenderChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0] && payload[0].payload;
  if (!d) return null;
  return (
    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card px-3 py-2 shadow-sm" style={{ fontSize: 12 }}>
      <div className="font-semibold text-[#1D2433] mb-1">{d.fullName}</div>
      <div className="text-[#4B5563]">Deals submitted: {d.submitted}</div>
      <div className="text-[#1E7A3D]">Deals approved: {d.approved}</div>
      <div className="text-[#4B5563]">Approval rate: {d.rate === null ? "—" : `${d.rate.toFixed(1)}%`}</div>
      <div className="text-[#B3261E]">Decline rate: {d.declineRate === null ? "—" : `${d.declineRate.toFixed(1)}%`}</div>
    </div>
  );
}

// Dropdown with checkboxes (a "multipicklist"): click to open, tick any
// number of options, click outside to close.
function MultiSelect({ options, selected, onChange, noun = "items" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const allSelected = selected.length === options.length;
  const label = allSelected
    ? `All ${noun}`
    : selected.length === 0
      ? `No ${noun} selected`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} ${noun}`;
  const toggle = (opt) =>
    onChange(selected.includes(opt) ? selected.filter((s) => s !== opt) : options.filter((o) => o === opt || selected.includes(o)));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white min-w-[150px] justify-between hover:bg-[#F6F7F9]"
      >
        <span>{label}</span>
        <ChevronDown size={13} color="#6B7280" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-[#D8DCE3] rounded-lg shadow-lg py-1 min-w-[200px]">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#EEF0F3]">
            <button type="button" onClick={() => onChange(options)} className="text-[11px] text-[#1D4E89] hover:underline">Select all</button>
            <button type="button" onClick={() => onChange([])} className="text-[11px] text-[#6B7280] hover:underline">Clear</button>
          </div>
          {options.map((opt) => (
            <label key={opt} className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-[#1D2433] cursor-pointer hover:bg-[#F6F7F9] select-none">
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)} className="w-3.5 h-3.5 accent-[#1D4E89]" />
              {opt}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function StageSelect({ value, onChange, stages, placeholder }) {  return (
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
export default function FunderKpiDashboard({ userEmail }) {
  const [rawOpps, setRawOpps] = useState(() => generateSampleData());
  const [rawFundingSources, setRawFundingSources] = useState([]);
  const [rawSales, setRawSales] = useState([]);
  const [rawCalls, setRawCalls] = useState([]);
  // Who is signed in and what they may see: "pending" until the email has been
  // hashed, then "admin" (all tabs), "sales" (Sales tab only) or "none".
  const [role, setRole] = useState("pending");
  const [accessCode, setAccessCode] = useState("");
  const [usingSample, setUsingSample] = useState(true);
  const [uploadError, setUploadError] = useState(null);
  const [activeTab, setActiveTab] = useState("funder"); // "funder" | "inferred" | "lenders"

  // Which people's edits count toward Stage History attribution. Javier
  // and Jay are on by default; Shervin and Ishaan are opt-in via
  // checkboxes in the UI, but once selected use identical logic --
  // first real occurrence per deal, same charts/stats/breakdown tables.
  const [selectedPeople, setSelectedPeople] = useState(DEFAULT_SELECTED_PEOPLE);

  const [trackFilter, setTrackFilter] = useState("all"); // all | 1 | 2
  const [funderFilter, setFunderFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all"); // all | open | won | cancelled | declined | terminated
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Lender Performance tab has its OWN date filter, scoped to when each
  // Funding_Source__c record was submitted (its CreatedDate) -- separate
  // from the Assigned Funder/Stage History tabs' "Created" filter, which
  // is about the Opportunity's creation date instead.
  const [lenderDateFrom, setLenderDateFrom] = useState("");
  const [lenderDateTo, setLenderDateTo] = useState("");

  const [milestoneFrom, setMilestoneFrom] = useState("01");
  const [milestoneTo, setMilestoneTo] = useState("90");
  const [expandedFunder, setExpandedFunder] = useState(null);  const [selectedTransitionId, setSelectedTransitionId] = useState(KEY_TRANSITIONS[0].id);
  const [expandedPerson, setExpandedPerson] = useState(null);
  const [expandedOutcomeSections, setExpandedOutcomeSections] = useState({}); // { "personName:outcomeType": true }
  const [inferredChartMode, setInferredChartMode] = useState("time"); // "time" | "volume"
  const [lenderChartMode, setLenderChartMode] = useState("approved"); // "approved" | "volume"

  // Sales tab: its own rep (opportunity owner) + created-date filters,
  // independent of every other tab's filters.
  const [salesSelectedReps, setSalesSelectedReps] = useState(SALES_REP_NAMES);
  const [salesDateFrom, setSalesDateFrom] = useState("");
  const [salesDateTo, setSalesDateTo] = useState("");
  const [salesChartMode, setSalesChartMode] = useState("deals"); // "deals" | "amount" | "rate"
  const [salesView, setSalesView] = useState("rep"); // "rep" | "trend"
  const [trendPeriod, setTrendPeriod] = useState("month"); // "month" | "week"
  const [trendMetric, setTrendMetric] = useState("originations"); // "originations" | "fundings" | "both"
  const [trendRange, setTrendRange] = useState("12"); // "12" | "24" | "all"
  const [callTrendMetric, setCallTrendMetric] = useState("dials"); // "dials" | "connected" | "missed" | "talk"
  const [includeCallData, setIncludeCallData] = useState(false); // trend: calls become the bars, deals become lines, per rep
  const [callBarMeasure, setCallBarMeasure] = useState("volume"); // which call measure the bars show: "volume" | "talk"
  const [expandedSalesRep, setExpandedSalesRep] = useState(null);

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

  // Operations/Admin: tracks Clinton's edits for whichever milestone
  // (from/to stage pair) is currently selected in the Time Between
  // Milestones picker above -- reuses that same picker rather than a
  // separate fixed transition, so it only shows data when the selected
  // stages are ones he actually works (e.g. 01 -> 10).
  // Operations/Admin intake speed: Created -> first time hitting stage 10.
  // Salesforce Field History Tracking only logs CHANGES to a field, not
  // its value at record creation -- so most deals never get an explicit
  // "01" history row even though 01 is genuinely their starting stage
  // (confirmed: ~91% of deals in this dataset have "10" as their first
  // tracked stage event, not "01"). Using the deal's real CreatedDate as
  // the start point instead of requiring a literal 01 row captures the
  // true intake time and correctly attributes it to whoever's edit first
  // moved the deal into stage 10 -- Clinton's real volume (~1800 deals)
  // was being undercounted to just 65 when this required an explicit
  // 01->10 transition, since most 01 entries were never tracked.
  const opsRows = useMemo(() => {
    const rows = [];
    if (milestoneFrom !== "01" || milestoneTo !== "10") return rows; // only applies to this specific milestone
    inferredFilteredDeals.forEach((d) => {
      const sh = d.stageHistory; // already sorted by timestamp in deriveDeals
      let firstTenEvent = null;
      const seenStages = new Set();
      for (const s of sh) {
        if (s.stage === "10" && !seenStages.has("10")) {
          firstTenEvent = s;
          break;
        }
        seenStages.add(s.stage);
      }
      if (!firstTenEvent || !firstTenEvent.changedBy) return;
      if (!OPS_NAMES.includes(firstTenEvent.changedBy)) return;
      const days = (firstTenEvent.timestamp - d.createdDate) / 86400000;
      if (days < 0) return; // guard against any data oddity
      rows.push({ dealId: d.id, person: firstTenEvent.changedBy, days });
    });
    return rows;
  }, [inferredFilteredDeals, milestoneFrom, milestoneTo]);

  const opsByPerson = useMemo(() => {
    const groups = {};
    opsRows.forEach((r) => {
      if (!groups[r.person]) groups[r.person] = [];
      groups[r.person].push(r.days);
    });
    return Object.entries(groups)
      .map(([person, days]) => ({ person, count: days.length, avg: mean(days), median: median(days) }))
      .sort((a, b) => b.count - a.count);
  }, [opsRows]);

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
    (person) => person && selectedPeople.includes(person),
    [selectedPeople]
  );

  // Submission volume + approval rate: for each deal, find whoever's edit
  // FIRST moved it into 120/130/135 (Submitted to Source) -- that's the
  // denominator, one per deal, credited to the submitter. The numerator is
  // how many of THAT SAME person's submitted deals also reached 150
  // (Approved) at any point afterward. This is a different question from
  // the "Submitted to Source -> Approved" KEY_TRANSITION above, which
  // tracks whoever made the specific 120/130/135->150 edit -- that can be
  // a different person than who originally submitted the deal.
  const SUBMIT_STAGES = useMemo(() => new Set(["120", "130", "135"]), []);
  const submissionStats = useMemo(() => {
    const submitted = {};
    const approved = {};
    inferredFilteredDeals.forEach((d) => {
      const sh = d.stageHistory;
      let submitter = null;
      let submitIdx = null;
      for (let i = 0; i < sh.length; i++) {
        if (SUBMIT_STAGES.has(sh[i].stage)) {
          submitter = sh[i].changedBy;
          submitIdx = i;
          break;
        }
      }
      if (!submitter || !isUnderwriter(submitter)) return;
      submitted[submitter] = (submitted[submitter] || 0) + 1;
      const reachedApproval = sh.slice(submitIdx).some((s) => s.stage === "150");
      if (reachedApproval) approved[submitter] = (approved[submitter] || 0) + 1;
    });
    return Object.keys(submitted)
      .map((person) => ({
        person,
        submitted: submitted[person],
        approved: approved[person] || 0,
        rate: submitted[person] ? (approved[person] || 0) / submitted[person] : null,
      }))
      .sort((a, b) => b.submitted - a.submitted);
  }, [inferredFilteredDeals, isUnderwriter, SUBMIT_STAGES]);

  // Applies the Lender Performance tab's own date filter (on each
  // submission's CreatedDate/submittedDate) -- separate from the other
  // tabs' Created-date filter, which scopes by Opportunity creation.
  const filteredFundingSources = useMemo(() => {
    return rawFundingSources.filter((r) => {
      if (lenderDateFrom && (!r.submittedDate || r.submittedDate < new Date(lenderDateFrom).getTime())) return false;
      if (lenderDateTo && (!r.submittedDate || r.submittedDate > new Date(lenderDateTo).getTime() + 86400000)) return false;
      return true;
    });
  }, [rawFundingSources, lenderDateFrom, lenderDateTo]);

  // Lender Performance: per lender, total submissions, approvals,
  // declines, and approval rate. Uses filteredFundingSources (one row
  // per lender submission) -- independent of the Stage History tab's
  // underwriter whitelist, since this tracks lenders, not staff.
  //
  // Note: time-to-decision isn't computable from this data yet --
  // Funding_Source__c stores only the CURRENT status, not a history of
  // when it changed (Status__c isn't Field-History-Tracked the way
  // Opportunity.StageName is), so there's no reliable "when was this
  // approved/declined" timestamp to measure against SubmittedDate.
  const lenderStats = useMemo(() => {
    const byLender = {};
    filteredFundingSources.forEach((r) => {
      if (!r.lenderName) return;
      if (!byLender[r.lenderName]) {
        byLender[r.lenderName] = { submitted: 0, approved: 0, declined: 0, pending: 0 };
      }
      const g = byLender[r.lenderName];
      g.submitted += 1;
      const status = r.status.toLowerCase();
      if (status === "approved") g.approved += 1;
      else if (status === "declined") g.declined += 1;
      else if (status === "pending" || status === "submitted" || status === "more info needed") g.pending += 1;
    });
    return Object.entries(byLender)
      .map(([lender, g]) => ({
        lender,
        submitted: g.submitted,
        approved: g.approved,
        declined: g.declined,
        pending: g.pending,
        rate: g.submitted ? g.approved / g.submitted : null,
        declineRate: g.submitted ? g.declined / g.submitted : null,
      }))
      .sort((a, b) => b.submitted - a.submitted);
  }, [filteredFundingSources]);

  // Overall Lender Performance summary: total submitted/approved/declined
  // across ALL lenders combined, plus a syndication-specific funded
  // conversion rate. "Funded" here means the deal reached 185 or 190
  // SPECIFICALLY (the Syndication-track funded stages) -- not the
  // double-digit equivalents (85/90), since every deal in this
  // denominator is by definition a syndicated (3-digit) deal already.
  // Also counts "stale" submissions: still Pending/Submitted/More Info
  // Needed AND not modified in the last 7 days.
  const lenderSummary = useMemo(() => {
    const dealById = {};
    deals.forEach((d) => { dealById[d.id] = d; });

    const uniqueSubmittedOppIds = new Set();
    let totalSubmitted = 0, totalApproved = 0, totalDeclined = 0, staleCount = 0;
    const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    filteredFundingSources.forEach((r) => {
      if (!r.lenderName) return;
      totalSubmitted += 1;
      uniqueSubmittedOppIds.add(r.opportunityId);
      const status = r.status.toLowerCase();
      if (status === "approved") totalApproved += 1;
      else if (status === "declined") totalDeclined += 1;
      const isNonFinal = status === "pending" || status === "submitted" || status === "more info needed";
      if (isNonFinal && r.lastModifiedDate && (now - r.lastModifiedDate) > STALE_THRESHOLD_MS) {
        staleCount += 1;
      }
    });

    // Syndication-funded conversion: of the UNIQUE deals submitted to any
    // lender (on the 3-digit track), how many reached 185/190 specifically.
    let syndicatedSubmittedCount = 0;
    let syndicatedFundedCount = 0;
    uniqueSubmittedOppIds.forEach((oid) => {
      const d = dealById[oid];
      if (!d || d.track !== "2") return; // only count Syndication-track deals
      syndicatedSubmittedCount += 1;
      const reachedSyndicatedFunded = d.stageHistory.some((s) => s.stage === "185" || s.stage === "190");
      if (reachedSyndicatedFunded) syndicatedFundedCount += 1;
    });

    return {
      totalSubmitted,
      totalApproved,
      totalDeclined,
      staleCount,
      approvalRate: totalSubmitted ? totalApproved / totalSubmitted : null,
      declineRate: totalSubmitted ? totalDeclined / totalSubmitted : null,
      syndicatedSubmittedCount,
      syndicatedFundedCount,
      syndicatedConversionRate: syndicatedSubmittedCount ? syndicatedFundedCount / syndicatedSubmittedCount : null,
    };
  }, [filteredFundingSources, deals]);

  // ---- Sales tab ----
  // Reps = opportunity owners. Alphabetical so each rep keeps the same
  // position (and color) when toggling between chart metrics.
  const salesReps = SALES_REP_NAMES;

  // Rows for the ticked reps. Owner names were matched to the roster when
  // parsed, so an exact check is enough.
  const salesRepRows = useMemo(
    () => rawSales.filter((r) => salesSelectedReps.includes(r.owner)),
    [rawSales, salesSelectedReps]
  );
  const salesNow = useMemo(() => Date.now(), []);

  // Per-rep stats. Period rules: deals, amount, declined and cancelled
  // count deals CREATED in the period; "funded" counts deals now at a funded
  // stage whose CLOSE date is in the period. Conversion is a created-date
  // cohort: of deals created in the period, the share now funded.
  const salesByRep = useMemo(() => {
    const groups = {};
    const grp = (rep) => (groups[rep] = groups[rep] || { deals: 0, amount: 0, cohortFunded: 0, declined: 0, cancelled: 0, funded: 0, fundedAmount: 0 });
    salesRepRows.forEach((r) => {
      const isFunded = SALES_FUNDED_STAGES.has(r.stage);
      if (inDateRange(r.created, salesDateFrom, salesDateTo)) {
        const g = grp(r.owner);
        g.deals += 1;
        g.amount += r.amount;
        if (isFunded) g.cohortFunded += 1;
        else if (SALES_DECLINED_STAGES.has(r.stage)) g.declined += 1;
        else if (SALES_CANCELLED_STAGES.has(r.stage)) g.cancelled += 1;
      }
      if (isFunded && inDateRange(r.closeMs, salesDateFrom, salesDateTo)) {
        const g = grp(r.owner);
        g.funded += 1;
        g.fundedAmount += r.amount;
      }
    });
    return Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .map((rep) => {
        const g = groups[rep];
        return {
          rep,
          ...g,
          conversionRate: g.deals ? g.cohortFunded / g.deals : null,
          declineRate: g.deals ? g.declined / g.deals : null,
          cancelRate: g.deals ? g.cancelled / g.deals : null,
        };
      });
  }, [salesRepRows, salesDateFrom, salesDateTo]);

  const salesSummary = useMemo(() => {
    const t = { deals: 0, amount: 0, cohortFunded: 0, funded: 0, fundedAmount: 0, declined: 0, cancelled: 0 };
    salesByRep.forEach((r) => {
      t.deals += r.deals; t.amount += r.amount; t.cohortFunded += r.cohortFunded; t.funded += r.funded;
      t.fundedAmount += r.fundedAmount; t.declined += r.declined; t.cancelled += r.cancelled;
    });
    return {
      ...t,
      conversionRate: t.deals ? t.cohortFunded / t.deals : null,
      declineRate: t.deals ? t.declined / t.deals : null,
      cancelRate: t.deals ? t.cancelled / t.deals : null,
    };
  }, [salesByRep]);

  // Funded deals with no close date can't be placed in a period, so they
  // drop out of "funded" whenever a period is set (noted under the table).
  const salesFundedNoClose = useMemo(
    () => salesRepRows.filter((r) => SALES_FUNDED_STAGES.has(r.stage) && !r.closeMs).length,
    [salesRepRows]
  );

  // Trend view data: one series per ticked rep.
  const trendReps = useMemo(() => salesReps.filter((r) => salesSelectedReps.includes(r)), [salesSelectedReps]);
  const trendData = useMemo(
    () => buildTrend(salesRepRows, trendReps, { kind: trendPeriod, range: trendRange, dateFrom: salesDateFrom, dateTo: salesDateTo, now: salesNow }),
    [salesRepRows, trendReps, trendPeriod, trendRange, salesDateFrom, salesDateTo, salesNow]
  );
  // ---- Call stats (from the calls_daily sheet) ----
  const callRowsInRange = useMemo(
    () => rawCalls.filter((r) => salesSelectedReps.includes(r.rep) && inDateStringRange(r.date, salesDateFrom, salesDateTo)),
    [rawCalls, salesSelectedReps, salesDateFrom, salesDateTo]
  );
  const callsByRep = useMemo(() => {
    const groups = {};
    callRowsInRange.forEach((r) => { (groups[r.rep] = groups[r.rep] || []).push(r); });
    return Object.keys(groups).sort((a, b) => a.localeCompare(b)).map((rep) => {
      const t = callTotals(groups[rep]);
      const s = salesByRep.find((x) => x.rep === rep);
      return { rep, ...t, dialsPerDeal: s && s.deals ? t.dials / s.deals : null, dialsPerFunded: s && s.funded ? t.dials / s.funded : null };
    });
  }, [callRowsInRange, salesByRep]);
  const callsSummary = useMemo(() => {
    const t = callTotals(callRowsInRange);
    return {
      ...t,
      dialsPerDeal: salesSummary.deals ? t.dials / salesSummary.deals : null,
      dialsPerFunded: salesSummary.funded ? t.dials / salesSummary.funded : null,
    };
  }, [callRowsInRange, salesSummary]);
  const callsTrend = useMemo(
    () => buildCallsTrend(rawCalls.filter((r) => salesSelectedReps.includes(r.rep)), trendReps, { kind: trendPeriod, range: trendRange, dateFrom: salesDateFrom, dateTo: salesDateTo, now: salesNow }),
    [rawCalls, salesSelectedReps, trendReps, trendPeriod, trendRange, salesDateFrom, salesDateTo, salesNow]
  );

  // "both" shows originations and fundings side by side for every rep;
  // "calls" switches the whole trend over to call activity.
  const trendIsCalls = trendMetric === "calls";
  const callKey = callTrendMetric;
  const trendSource = trendIsCalls ? callsTrend : trendData;
  const trendMetricKeys = trendIsCalls ? [callKey] : trendMetric === "both" ? ["orig", "fund"] : [trendMetric === "fundings" ? "fund" : "orig"];

  // Include call data: calls become the bars and the deal data (originations
  // and/or fundings) becomes lines, one set per rep. Nothing is added up
  // across reps. Call volume and talk time sit on very different scales, so
  // the bars show one at a time; the table shows both.
  const showCallCombo = !trendIsCalls && rawCalls.length > 0 && includeCallData;
  const callBarLabel = callBarMeasure === "volume" ? "calls" : "talk min";
  const comboDealKeys = trendMetric === "both" ? ["orig", "fund"] : [trendMetric === "fundings" ? "fund" : "orig"];
  const callSeriesByRep = useMemo(
    () => (showCallCombo ? buildCallSeriesByRep(trendData.periods, trendReps, callsTrend.byStart) : null),
    [showCallCombo, trendData, trendReps, callsTrend]
  );
  const tableSeries = showCallCombo
    ? Object.fromEntries(trendReps.map((rep) => [rep, { ...trendData.series[rep], callVol: callSeriesByRep[rep].volume, talkMin: callSeriesByRep[rep].talk }]))
    : trendSource.series;
  const tableMetricKeys = showCallCombo ? [...comboDealKeys, "callVol", "talkMin"] : trendMetricKeys;
  const TrendChartComponent = showCallCombo ? ComposedChart : BarChart;
  const trendChartData = useMemo(
    () => trendSource.periods.map((p, i) => {
      if (showCallCombo) {
        const row = { label: p.label, inProgress: p.inProgress, callMode: true };
        trendReps.forEach((rep) => {
          row[`${rep} · ${callBarLabel}`] = callSeriesByRep[rep][callBarMeasure === "volume" ? "volume" : "talk"][i];
          if (comboDealKeys.indexOf("orig") !== -1) row[`${rep} · originated`] = trendData.series[rep].orig[i];
          if (comboDealKeys.indexOf("fund") !== -1) row[`${rep} · funded`] = trendData.series[rep].fund[i];
        });
        return row;
      }
      const both = trendMetric === "both";
      const row = { label: p.label, inProgress: p.inProgress, both, total: 0, totalOrig: 0, totalFund: 0 };
      trendReps.forEach((rep) => {
        if (trendIsCalls) { const v = trendSource.series[rep][callKey][i]; row[rep] = v; row.total += v; return; }
        const o = trendSource.series[rep].orig[i];
        const f = trendSource.series[rep].fund[i];
        row.totalOrig += o;
        row.totalFund += f;
        if (both) { row[`${rep} · originated`] = o; row[`${rep} · funded`] = f; }
        else { const v = trendMetric === "fundings" ? f : o; row[rep] = v; row.total += v; }
      });
      return row;
    }),
    [trendSource, trendReps, trendMetric, trendIsCalls, callKey, showCallCombo, callSeriesByRep, callBarMeasure, callBarLabel, trendData]
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

  // The top milestone chart is keyed by Assigned Funder (Javier/Jay/etc)
  // by default, but for the 01->10 milestone specifically, ops staff
  // (Clinton) should also appear -- a different attribution model (who
  // made the edit, not who the deal's funder is), folded into the same
  // chart so both views are visible together for this one milestone.
  const chartData = [
    ...milestoneByFunder.map((r) => ({ name: r.funder, avg: Number(r.avg?.toFixed(2) || 0), count: r.count, isOps: false })),
    ...opsByPerson.map((r) => ({ name: r.person, avg: Number(r.avg?.toFixed(2) || 0), count: r.count, isOps: true })),
  ];

  // Milestone stage pickers always offer stages from BOTH tracks -- a
  // single deal can have both Internal/Balance Sheet stages (early) and
  // Syndication stages (after being submitted to source), so restricting
  // the dropdown to one track based on the record-type filter would hide
  // valid milestone combinations.
  // Milestone stage pickers respect the record-type filter: if a specific
  // track is selected, only that track's stages are offered (so you can't
  // pick a nonsensical cross-track pair like Internal->174 Docs Out). When
  // "All record types" is selected, both tracks' stages are available,
  // since a single deal can legitimately span both (e.g. 01 -> 120).
  const stagesForTrack = trackFilter === "1" ? STAGES_TRACK_1 : trackFilter === "2" ? STAGES_TRACK_2 : ALL_STAGES;

  // If the record-type filter changes to a specific track and the current
  // milestone selection isn't valid for that track (e.g. "174 - Docs Out"
  // selected while filtering to Internal/Balance Sheet), reset both
  // dropdowns to that track's default stages rather than leaving an
  // orphaned selection that no longer appears in the dropdown's options.
  useEffect(() => {
    const validCodes = new Set(stagesForTrack.map(([c]) => c));
    if (!validCodes.has(milestoneFrom) || !validCodes.has(milestoneTo)) {
      const defaults = trackFilter === "2" ? ["101", "190"] : trackFilter === "1" ? ["01", "90"] : ["01", "90"];
      setMilestoneFrom(defaults[0]);
      setMilestoneTo(defaults[1]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackFilter]);

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
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Apps Script Web Apps don't reliably support CORS for plain fetch()
  // calls (a documented limitation -- the /exec URL's redirect chain
  // doesn't carry CORS headers through for fetch(), even though loading
  // the same URL directly in a browser tab works fine). JSONP sidesteps
  // this entirely by loading the response via a <script> tag instead --
  // those have always been allowed cross-origin, since they predate CORS.
  const loadViaJsonp = useCallback((url, timeoutMs = 30000) => {
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
      const fsUrl = SALESFORCE_CSV_URL + separator + "sheet=funding_sources&_cb=" + Date.now() + keyParam;
      const salesUrl = SALESFORCE_CSV_URL + separator + "sheet=sales&_cb=" + Date.now() + keyParam;
      const callsUrl = SALESFORCE_CSV_URL + separator + "sheet=calls_daily&_cb=" + Date.now() + keyParam;

      // Fetch the sheets IN PARALLEL rather than one after another, so the
      // total wait is the slowest request, not the sum.
      //
      // Only admins request the funder / stage / lender sheets. A Sales-only
      // account never asks for them, so that data isn't downloaded into their
      // browser at all. (A dashboard-side measure, not a security boundary.)
      const isAdmin = role === "admin";
      const skipped = Promise.resolve(null);
      const [mainResult, fsResult, salesResult, callsResult] = await Promise.allSettled([
        isAdmin ? loadViaJsonp(bustUrl) : skipped,
        isAdmin ? loadViaJsonp(fsUrl) : skipped,
        loadViaJsonp(salesUrl),
        loadViaJsonp(callsUrl),
      ]);

      if (isAdmin) {
        if (mainResult.status !== "fulfilled") {
          throw mainResult.reason || new Error("Failed to load data from Salesforce.");
        }
        const payload = mainResult.value;
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

        // funding_sources is best-effort -- if it fails, the main dashboard
        // data above has already loaded successfully, so we don't want a
        // Lender Performance-specific failure to block everything else.
        if (fsResult.status === "fulfilled" && fsResult.value && fsResult.value.ok && fsResult.value.data) {
          setRawFundingSources(parseFundingSourceData(fsResult.value.data));
        } else if (fsResult.status === "rejected") {
          console.warn("Could not load funding_sources data:", fsResult.reason);
        }
      } else {
        // Sales-only: success means the sales sheet came back.
        if (salesResult.status !== "fulfilled" || !salesResult.value || !salesResult.value.ok) {
          throw new Error("Could not load the sales data. Try reloading the page.");
        }
        setUsingSample(false);
        setLastRefreshed(new Date());
      }

      // sales is best-effort too, for the same reason.
      if (salesResult.status === "fulfilled" && salesResult.value && salesResult.value.ok && salesResult.value.data) {
        setRawSales(parseSalesData(salesResult.value.data));
      } else if (salesResult.status === "rejected") {
        console.warn("Could not load sales data:", salesResult.reason);
      }

      // call stats are best-effort too (the calls_daily sheet only exists
      // once the Apps Script's call rollup has run).
      if (callsResult.status === "fulfilled" && callsResult.value && callsResult.value.ok && callsResult.value.data) {
        setRawCalls(parseCallsDaily(callsResult.value.data));
      } else if (callsResult.status === "rejected") {
        console.warn("Could not load call data:", callsResult.reason);
      }
    } catch (err) {
      setUploadError(err.message || "Failed to refresh from Salesforce.");
    } finally {
      setIsRefreshing(false);
      setHasLoadedOnce(true);
    }
  }, [loadViaJsonp, role]);

  // Auto-refresh once when the dashboard first loads, so it shows live
  // data immediately instead of requiring a manual click every visit.
  // This just re-fetches the Apps Script's cached Sheet data (cheap --
  // doesn't touch Salesforce, which only syncs once daily on its own
  // schedule), so it's safe to do on every page load/reload.
  useEffect(() => {
    let alive = true;
    (async () => {
      const email = String(userEmail || "").trim().toLowerCase();
      if (!email) { if (alive) { setAccessCode(""); setRole("none"); } return; }
      let code = "";
      try { code = await sha256Hex(email); } catch (err) { code = ""; }
      if (!alive) return;
      setAccessCode(code);
      if (code && ADMIN_EMAIL_HASHES.indexOf(code) !== -1) setRole("admin");
      else if (code && SALES_EMAIL_HASHES.indexOf(code) !== -1) { setActiveTab("sales"); setRole("sales"); }
      else setRole("none");
    })();
    return () => { alive = false; };
  }, [userEmail]);

  // Load only once the role is known; accounts with no access request nothing.
  useEffect(() => {
    if (role === "admin" || role === "sales") refreshFromSalesforce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  return (
    <div className="w-full min-h-screen bg-[#F6F7F9] text-[#1D2433]" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif" }}>
      <style>{`
        .mono { font-family: 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace; font-variant-numeric: tabular-nums; }
        table.kpi-table { border-collapse: collapse; width: 100%; }
        table.kpi-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6B7280; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #E4E7EC; }
        table.kpi-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #EEF0F3; }
        table.kpi-table tr:hover td { background: #FAFBFC; }
        .fintech-card {
          transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
          box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
        }
        .fintech-card:hover {
          box-shadow: 0 4px 16px -4px rgba(29, 78, 137, 0.14), 0 2px 6px -2px rgba(16, 24, 40, 0.08);
          transform: translateY(-1px);
          border-color: #C7D2E0;
        }
      `}</style>

      {role === "none" ? (
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="w-full max-w-md bg-white border border-[#E4E7EC] rounded-xl p-8 text-center" style={{ boxShadow: "0 4px 20px -6px rgba(16, 24, 40, 0.10)" }}>
            <h1 className="text-[18px] font-semibold text-[#1D2433] mb-2">No access yet</h1>
            {userEmail ? (
              <>
                <p className="text-[13px] text-[#4B5563]">You're signed in as <span className="font-medium">{userEmail}</span>, but this account hasn't been given access to the dashboard. Ask an admin to add you.</p>
                <p className="text-[11px] text-[#8A93A3] mt-4">Access code (send this to an admin)</p>
                <p className="mono text-[11px] text-[#4B5563] break-all select-all mt-1">{accessCode}</p>
              </>
            ) : (
              <p className="text-[13px] text-[#4B5563]">The dashboard didn't receive your sign-in email. Make sure AuthGate.jsx was deployed together with the dashboard file.</p>
            )}
          </div>
        </div>
      ) : !hasLoadedOnce || role === "pending" ? (
        <div className="min-h-screen flex flex-col items-center justify-center gap-3">
          <Upload size={28} color="#1D4E89" className="animate-spin" />
          <p className="text-[14px] font-medium text-[#4B5563]">Loading Funder KPI Dashboard…</p>
          <p className="text-[12px] text-[#8A93A3]">Pulling the latest data from Salesforce</p>
        </div>
      ) : (
        <>
      {/* Header */}
      <div className="border-b border-[#E4E7EC] bg-white px-6 py-4 flex items-center justify-between sticky top-0 z-10" style={{ boxShadow: "0 1px 2px rgba(16, 24, 40, 0.04)" }}>
        <div>
          <h1 className="text-lg font-semibold text-[#1D2433]">Funder KPI Dashboard</h1>
          <p className="text-[12px] text-[#8A93A3] mt-0.5">Time-in-stage &amp; time-to-milestone tracking, split by origination and funder-assigned phases</p>
        </div>
        <div className="flex items-center gap-3">
          {usingSample && role === "admin" && <Pill tone="accent">Sample data</Pill>}
          {isRefreshing && (
            <span className="flex items-center gap-1.5 text-[12px] text-[#8A93A3]">
              <Upload size={13} className="animate-spin" /> Loading latest data…
            </span>
          )}
          {!isRefreshing && lastRefreshed && (
            <span className="text-[12px] text-[#8A93A3]">
              Last refreshed {lastRefreshed.toLocaleDateString()} {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>
      {uploadError && (
        <div className="mx-6 mt-4 flex items-center gap-2 bg-[#FCEAEA] text-[#B3261E] text-[13px] px-3 py-2 rounded border border-[#F5C6C4]">
          <AlertCircle size={14} /> {uploadError}
        </div>
      )}

      {/* Tabs */}
      <div className="px-6 pt-4 flex items-center gap-1 border-b border-[#E4E7EC] bg-white">
        {role === "admin" && (
        <>
        <button
          onClick={() => setActiveTab("funder")}
          className={`px-4 py-2 text-[13px] font-medium rounded-t border-b-2 transition-colors ${
            activeTab === "funder" ? "border-[#1D4E89] text-[#1D4E89]" : "border-transparent text-[#8A93A3] hover:text-[#4B5563]"
          }`}
        >
          Assigned Funder
        </button>
        <button
          onClick={() => setActiveTab("inferred")}
          className={`px-4 py-2 text-[13px] font-medium rounded-t border-b-2 transition-colors ${
            activeTab === "inferred" ? "border-[#1D4E89] text-[#1D4E89]" : "border-transparent text-[#8A93A3] hover:text-[#4B5563]"
          }`}
        >
          Stage History
        </button>
        <button
          onClick={() => setActiveTab("lenders")}
          className={`px-4 py-2 text-[13px] font-medium rounded-t border-b-2 transition-colors ${
            activeTab === "lenders" ? "border-[#1D4E89] text-[#1D4E89]" : "border-transparent text-[#8A93A3] hover:text-[#4B5563]"
          }`}
        >
          Lender Performance
        </button>
        </>
        )}
        <button
          onClick={() => setActiveTab("sales")}
          className={`px-4 py-2 text-[13px] font-medium rounded-t border-b-2 transition-colors ${
            activeTab === "sales" ? "border-[#1D4E89] text-[#1D4E89]" : "border-transparent text-[#8A93A3] hover:text-[#4B5563]"
          }`}
        >
          Sales
        </button>
      </div>


      <div className="px-6 py-5 flex flex-col gap-5">

        {/* Filters -- not shown on Lender Performance, which has its own self-contained summary */}
        {activeTab !== "lenders" && activeTab !== "sales" && (
        <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#6B7280] mr-1">
            <Filter size={13} /> Filters
          </div>
          <select value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white">
            <option value="all">All record types</option>
            <option value="1">Internal/Balance Sheet</option>
            <option value="2">Syndication</option>
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
        )}

        {/* Summary stat cards */}
        {activeTab !== "lenders" && activeTab !== "sales" && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label="Total deals" value={summary.total} icon={Users} />
          <StatCard
            label="Open"
            value={summary.open}
            sub="Still in the pipeline"
            tooltip="Any deal that hasn't reached a final outcome yet — includes deals at Additional Info Requested, Assigned to Credit, Submitted to Source, Approved/Terms Accepted, or any other in-progress stage. Excludes Funded, Cancelled, and Declined deals."
            icon={Clock}
          />
          <StatCard label="Funded" value={summary.won} sub="Reached 85/185 or 90/190" tone="good" icon={TrendingUp} />
          <StatCard label="Cancelled" value={summary.cancelled} tone="bad" icon={TrendingDown} />
          <StatCard label="Declined" value={summary.declined} tone="bad" icon={TrendingDown} />
          <StatCard label="Avg origination time" value={fmtDays(summary.avgOrigination)} sub="Created → funder assigned" tone="accent" />
          <StatCard label="Avg funder time" value={fmtDays(summary.avgFunderTime)} sub="Assigned → latest stage" tone="accent" />
        </div>
        )}

        {/* Milestone picker + chart */}
        {activeTab === "funder" && (
        <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-[13px] font-semibold text-[#1D2433]">Time between milestones</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <StageSelect value={milestoneFrom} onChange={setMilestoneFrom} stages={stagesForTrack} placeholder="From stage" />
              <ChevronRight size={14} color="#9AA3AF" />
              <StageSelect value={milestoneTo} onChange={setMilestoneTo} stages={stagesForTrack} placeholder="To stage" />
            </div>
          </div>
          {trackFilter === "all" && (
            <p className="text-[12px] text-[#8A93A3] mb-2">Showing results for the {trackOf(milestoneFrom) === "2" ? "Syndication" : "Internal/Balance Sheet"} track (based on selected stages). Set the record-type filter above to scope explicitly.</p>
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
                  <Tooltip content={<TimeChartTooltip />} />
                  <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                    {chartData.map((d, i) => <Cell key={i} fill={d.isOps ? "#D9770A" : "#1D4E89"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        )}

        {/* Operations/Admin: Clinton's edits for whichever milestone is selected above */}
        {activeTab === "funder" && opsByPerson.length > 0 && (
          <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E4E7EC]">
              <h2 className="text-[13px] font-semibold text-[#1D2433]">Operations/Admin</h2>
              <p className="text-[12px] text-[#8A93A3] mt-0.5">
                {STAGE_LABEL[milestoneFrom] || milestoneFrom} → {STAGE_LABEL[milestoneTo] || milestoneTo} — intake/ops work, tracked separately from underwriting.
              </p>
            </div>
            <table className="kpi-table">
              <thead>
                <tr><th>Person</th><th>Deals</th><th>Avg time</th><th>Median time</th></tr>
              </thead>
              <tbody>
                {opsByPerson.map((r) => (
                  <tr key={r.person}>
                    <td className="font-medium flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: "#D9770A" }}></span>
                      {r.person}
                    </td>
                    <td className="mono">{r.count}</td>
                    <td className="mono">{fmtDays(r.avg)}</td>
                    <td className="mono">{fmtDays(r.median)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Per-funder KPI table */}
        {activeTab === "funder" && (
        <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
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
          <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
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
              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-6 text-center">
                <AlertCircle size={20} color="#B3261E" className="mx-auto mb-2" />
                <p className="text-[14px] font-medium text-[#1D2433]">No "Changed By" data found in the imported file</p>
                <p className="text-[12px] text-[#8A93A3] mt-1 max-w-md mx-auto">
                  This tab attributes stage-transition time to whoever made the edit that caused the transition. Your stage-history export needs a Changed By / Created By column — re-run the CSV builder script against a report export that includes it.
                </p>
              </div>
            )}

            <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div>
                  <h2 className="text-[13px] font-semibold text-[#1D2433]">Inferred stage-action attribution</h2>
                  <p className="text-[12px] text-[#8A93A3] mt-0.5">Time credited to whoever's edit moved the deal forward. Only {selectedPeople.length ? selectedPeople.join(", ") : "no one"} {selectedPeople.length === 1 ? "is" : "are"} tracked — everyone else is excluded.</p>
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

              <div className="flex items-center gap-4 flex-wrap mb-3 pb-3 border-b border-[#EEF0F3]">
                <span className="text-[11px] uppercase tracking-wide text-[#8A93A3] font-semibold">Include</span>
                {TRACKABLE_PEOPLE.map((person) => {
                  const checked = selectedPeople.includes(person);
                  return (
                    <label key={person} className="flex items-center gap-1.5 text-[12px] text-[#4B5563] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedPeople((prev) =>
                            prev.includes(person) ? prev.filter((p) => p !== person) : [...prev, person]
                          );
                        }}
                        className="w-3.5 h-3.5 accent-[#1D4E89]"
                      />
                      {person}
                    </label>
                  );
                })}
              </div>

              <div className="inline-flex items-center border border-[#D8DCE3] rounded-lg overflow-hidden mb-3">
                <button
                  onClick={() => setInferredChartMode("time")}
                  className={`text-[12px] font-semibold px-4 py-1.5 transition-colors ${
                    inferredChartMode === "time"
                      ? "bg-[#1D4E89] text-white"
                      : "bg-white text-[#4B5563] hover:bg-[#F6F7F9]"
                  }`}
                >
                  Avg time
                </button>
                <button
                  onClick={() => setInferredChartMode("volume")}
                  className={`text-[12px] font-semibold px-4 py-1.5 border-l border-[#D8DCE3] transition-colors ${
                    inferredChartMode === "volume"
                      ? "bg-[#1E7A3D] text-white"
                      : "bg-white text-[#4B5563] hover:bg-[#F6F7F9]"
                  }`}
                >
                  Volume
                </button>
              </div>

              {inferredChartData.length === 0 ? (
                <p className="text-[13px] text-[#8A93A3] py-8 text-center">No deals in the current filter have a recorded edit for this transition.</p>
              ) : (
                <div style={{ width: "100%", height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart
                      data={[...inferredChartData].sort((a, b) => a.name.localeCompare(b.name))}
                      margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#6B7280" }}
                        label={{ value: inferredChartMode === "volume" ? "deals" : "days", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8A93A3" }}
                      />
                      <Tooltip content={inferredChartMode === "volume" ? <VolumeChartTooltip /> : <TimeChartTooltip />} />
                      <Bar dataKey={inferredChartMode === "volume" ? "count" : "avg"} radius={[4, 4, 0, 0]}>
                        {inferredChartData.map((_, i) => <Cell key={i} fill={inferredChartMode === "volume" ? "#1E7A3D" : "#1D4E89"} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Submission volume & approval rate -- independent of the transition dropdown above */}
            {submissionStats.length > 0 && (
              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E4E7EC]">
                  <h2 className="text-[13px] font-semibold text-[#1D2433]">Submission volume &amp; approval rate</h2>
                  <p className="text-[12px] text-[#8A93A3] mt-0.5">
                    Credited to whoever's edit first moved the deal into Submitted to Source (120/130/135). Approval rate = deals that also reached 150 - Present Approval Terms, divided by total submitted.
                  </p>
                </div>
                <table className="kpi-table">
                  <thead>
                    <tr><th>Person</th><th>Submitted</th><th>Approved</th><th>Approval rate</th></tr>
                  </thead>
                  <tbody>
                    {submissionStats.map((r) => (
                      <tr key={r.person}>
                        <td className="font-medium">{r.person}</td>
                        <td className="mono">{r.submitted}</td>
                        <td className="mono">{r.approved}</td>
                        <td className="mono">{r.rate === null ? "—" : `${(r.rate * 100).toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Per-person collapsible cards */}
            <div className="flex flex-col gap-3">
              {inferredByPerson.length === 0 && (
                <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-6 text-center text-[13px] text-[#8A93A3]">
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
                  <div key={r.person} className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
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
                              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-3">
                                <div className="text-[11px] uppercase tracking-wide text-[#6B7280] font-semibold mb-1">New deals</div>
                                <div className="text-[18px] font-semibold mono text-[#1D2433]">{r.newCount}</div>
                                <div className="text-[12px] text-[#8A93A3]">avg {fmtDays(r.newAvg)} — first time reaching this stage</div>
                              </div>
                              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-3">
                                <div className="text-[11px] uppercase tracking-wide text-[#6B7280] font-semibold mb-1">Returning deals</div>
                                <div className="text-[18px] font-semibold mono text-[#1D2433]">{r.returningCount}</div>
                                <div className="text-[12px] text-[#8A93A3]">avg {fmtDays(r.returningAvg)} — came back from a later stage</div>
                              </div>
                            </div>

                            {/* Color-coded outcome sections, collapsible */}
                            {["approval", "decline", "info", "cancelled", "other"].map((otype) => {
                              const rows = byOutcome[otype];
                              if (!rows || rows.length === 0) return null;
                              const style = OUTCOME_STYLES[otype];
                              const sectionKey = r.person + ":" + otype;
                              const sectionOpen = !!expandedOutcomeSections[sectionKey];
                              const totalDeals = rows.reduce((sum, row) => sum + row.count, 0);
                              const weightedAvg = rows.reduce((sum, row) => sum + row.avg * row.count, 0) / (totalDeals || 1);
                              return (
                                <div key={otype} className="mb-2 last:mb-0">
                                  <button
                                    onClick={() => setExpandedOutcomeSections((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }))}
                                    className="w-full flex items-center justify-between gap-2 py-1.5 hover:opacity-80 transition-opacity"
                                  >
                                    <div className="flex items-center gap-1.5">
                                      {sectionOpen ? <ChevronDown size={12} color={style.text} /> : <ChevronRight size={12} color={style.text} />}
                                      <span className="w-2 h-2 rounded-full" style={{ background: style.text }}></span>
                                      <span className="text-[12px] font-semibold" style={{ color: style.text }}>{style.label}</span>
                                    </div>
                                    <span className="text-[11px] text-[#8A93A3]">
                                      {totalDeals} deals · avg {fmtDays(weightedAvg)}
                                    </span>
                                  </button>
                                  {sectionOpen && (
                                    <div className="rounded-lg overflow-hidden border mt-1" style={{ borderColor: style.bg }}>
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
                                  )}
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
                          <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-3">
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
          </>

        )}

        {/* ---------------- SALES TAB ---------------- */}
        {activeTab === "sales" && (
          <>
            <div className="relative z-20 bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#6B7280] mr-1">
                <Filter size={13} /> Filters
              </div>
              <MultiSelect options={salesReps} selected={salesSelectedReps} onChange={setSalesSelectedReps} noun="reps" />
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-[#8A93A3]" title="Deals and originations are dated by created date; fundings by close date">Period</span>
                <input type="date" value={salesDateFrom} onChange={(e) => setSalesDateFrom(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5" />
                <span className="text-[12px] text-[#8A93A3]">to</span>
                <input type="date" value={salesDateTo} onChange={(e) => setSalesDateTo(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5" />
              </div>
              {(salesSelectedReps.length !== SALES_REP_NAMES.length || salesDateFrom || salesDateTo) && (
                <button
                  onClick={() => { setSalesSelectedReps(SALES_REP_NAMES); setSalesDateFrom(""); setSalesDateTo(""); }}
                  className="flex items-center gap-1 text-[12px] text-[#B3261E] ml-1"
                >
                  <X size={12} /> Clear
                </button>
              )}
            </div>

            {rawSales.length === 0 && (
              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-6 text-center">
                <AlertCircle size={20} color="#B3261E" className="mx-auto mb-2" />
                <p className="text-[14px] font-medium text-[#1D2433]">No sales data loaded</p>
                <p className="text-[12px] text-[#8A93A3] mt-1 max-w-md mx-auto">
                  This tab reads the "sales" sheet from your Salesforce sync. Make sure the updated Apps Script is deployed and has run at least once, check sync_log for any sales errors, then refresh.
                </p>
              </div>
            )}

            {rawSales.length > 0 && salesByRep.length === 0 && (
              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-6 text-center text-[13px] text-[#8A93A3]">
                No deals match the current filters. If every rep is ticked and this still shows, check that the Owner names in the sales sheet match the five names in the dropdown.
              </div>
            )}

            {salesByRep.length > 0 && (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <StatCard label="Deals originated" value={salesSummary.deals.toLocaleString()} sub="Created in the period" icon={Users} />
                  <StatCard label="Deal amount" value={fmtMoney(salesSummary.amount)} sub="Invoice amount, deals created" tone="accent" />
                  <StatCard
                    label="Funded"
                    value={salesSummary.funded.toLocaleString()}
                    sub={`${fmtMoney(salesSummary.fundedAmount)} · by close date`}
                    tooltip="Deals currently at 85/185/90/190 whose close date falls in the period."
                    tone="good"
                    icon={TrendingUp}
                  />
                  <StatCard
                    label="Conversion rate"
                    value={salesSummary.conversionRate === null ? "—" : `${(salesSummary.conversionRate * 100).toFixed(1)}%`}
                    sub="Of deals created in the period"
                    tooltip="Deals created in the period that are now funded, divided by deals created in the period. Deals still in the pipeline count in the denominator."
                    tone="good"
                  />
                  <StatCard label="Declined" value={salesSummary.declined.toLocaleString()} tone="bad" icon={TrendingDown} />
                  <StatCard label="Decline rate" value={salesSummary.declineRate === null ? "—" : `${(salesSummary.declineRate * 100).toFixed(1)}%`} tone="bad" />
                  <StatCard label="Cancelled" value={salesSummary.cancelled.toLocaleString()} icon={TrendingDown} />
                  <StatCard label="Cancel rate" value={salesSummary.cancelRate === null ? "—" : `${(salesSummary.cancelRate * 100).toFixed(1)}%`} />
                </div>

                <AskData reps={SALES_REP_NAMES} sales={rawSales.filter((r) => SALES_REP_NAMES.indexOf(r.owner) !== -1)} calls={rawCalls} />

                <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4">
                  <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                    <h2 className="text-[13px] font-semibold text-[#1D2433]">{salesView === "trend" ? "Originations & fundings over time" : "Sales by rep"}</h2>
                    <Segmented options={[["rep", "By rep"], ["trend", "Trend"]]} value={salesView} onChange={setSalesView} />
                  </div>

                  {salesView === "rep" ? (
                    <>
                      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                        <p className="text-[12px] text-[#8A93A3]">Reps stay in alphabetical order in every view — hover a bar for the full name and stats.</p>
                        <Segmented options={[["deals", "Deals"], ["amount", "Amount"], ["rate", "Conversion rate"]]} value={salesChartMode} onChange={setSalesChartMode} />
                      </div>
                      <div style={{ width: "100%", height: 300 }}>
                        <ResponsiveContainer>
                          <BarChart
                            data={salesByRep.map((r) => ({
                              name: shortPersonName(r.rep),
                              fullName: r.rep,
                              deals: r.deals,
                              amount: r.amount,
                              funded: r.funded,
                              rate: r.conversionRate === null ? 0 : Number((r.conversionRate * 100).toFixed(1)),
                              conversionRate: r.conversionRate === null ? null : r.conversionRate * 100,
                              declineRate: r.declineRate === null ? null : r.declineRate * 100,
                              cancelRate: r.cancelRate === null ? null : r.cancelRate * 100,
                            }))}
                            margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                            barCategoryGap="30%"
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F3" vertical={false} />
                            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} interval={0} />
                            <YAxis
                              tick={{ fontSize: 11, fill: "#6B7280" }}
                              tickFormatter={salesChartMode === "amount" ? (v) => fmtMoney(v) : undefined}
                              label={{ value: salesChartMode === "amount" ? "deal amount" : salesChartMode === "rate" ? "% funded" : "deals originated", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8A93A3" }}
                            />
                            <Tooltip content={<SalesChartTooltip />} />
                            <Bar dataKey={salesChartMode === "rate" ? "rate" : salesChartMode} radius={[4, 4, 0, 0]}>
                              {salesByRep.map((r, i) => <Cell key={i} fill={colorForLender(r.rep, salesReps)} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-3 flex-wrap mb-3">
                        <Segmented options={[["originations", "Originations"], ["fundings", "Fundings"], ["both", "Both"], ...(rawCalls.length ? [["calls", "Calls"]] : [])]} value={trendMetric} onChange={setTrendMetric} />
                        {trendIsCalls && (
                          <Segmented options={[["dials", "Dials"], ["connected", "Answered"], ["missed", "Missed inbound"], ["talk", "Talk minutes"]]} value={callTrendMetric} onChange={setCallTrendMetric} />
                        )}
                        {!trendIsCalls && rawCalls.length > 0 && (
                          <div className="flex items-center gap-3 text-[12px] text-[#4B5563]">
                            <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
                              <input type="checkbox" checked={includeCallData} onChange={() => setIncludeCallData((v) => !v)} className="w-3.5 h-3.5 accent-[#1D4E89]" />
                              Include call data
                            </label>
                            {includeCallData && (
                              <Segmented options={[["volume", "Call volume"], ["talk", "Talk time"]]} value={callBarMeasure} onChange={setCallBarMeasure} />
                            )}
                          </div>
                        )}
                        <Segmented options={[["month", "Month"], ["week", "Week"]]} value={trendPeriod} onChange={setTrendPeriod} />
                        <select
                          value={trendRange}
                          onChange={(e) => setTrendRange(e.target.value)}
                          disabled={!!(salesDateFrom || salesDateTo)}
                          title={salesDateFrom || salesDateTo ? "The Period dates above are controlling the range" : undefined}
                          className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5 bg-white disabled:opacity-50"
                        >
                          <option value="12">Last 12</option>
                          <option value="24">Last 24</option>
                          <option value="all">Since Jan 2023</option>
                        </select>
                        <span className="text-[12px] text-[#8A93A3]">
                          {trendIsCalls
                            ? "Counted by Pacific calendar day. Answered means picked up, any length."
                            : showCallCombo
                            ? "Originations by created date, fundings by close date; calls by Pacific calendar day."
                            : trendMetric === "originations"
                            ? "Deals counted by created date"
                            : trendMetric === "fundings"
                              ? "Funded deals counted by close date"
                              : "Originations by created date, fundings by close date. Lighter bar = originated, solid bar = funded."}
                        </span>
                        {showCallCombo && (
                          <span className="text-[12px] text-[#8A93A3]">
                            Bars = {callBarMeasure === "volume" ? "calls (in + out)" : "talk minutes"}, left axis. Lines = {trendMetric === "both" ? "deals (dashed = originated, solid = funded)" : trendMetric === "fundings" ? "fundings" : "originations"}, right axis. Each rep is shown separately.
                          </span>
                        )}
                      </div>
                      {trendSource.periods.length === 0 || trendReps.length === 0 ? (
                        <p className="text-[13px] text-[#8A93A3] py-8 text-center">Nothing to show for the current selection.</p>
                      ) : (
                        <>
                          <div style={{ width: "100%", height: 300 }}>
                            <ResponsiveContainer>
                              <TrendChartComponent data={trendChartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }} barCategoryGap={trendMetric === "both" ? "12%" : "20%"} barGap={trendMetric === "both" ? 1 : 4}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F3" vertical={false} />
                                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} interval={trendSource.periods.length > 14 ? "preserveStartEnd" : 0} />
                                <YAxis
                                  tick={{ fontSize: 11, fill: "#6B7280" }}
                                  allowDecimals={false}
                                  label={{ value: showCallCombo ? (callBarMeasure === "volume" ? "calls (in + out)" : "talk minutes") : trendIsCalls ? { dials: "outbound dials", connected: "answered calls", missed: "missed inbound calls", talk: "talk minutes" }[callKey] : trendMetric === "both" ? "deals" : trendMetric === "fundings" ? "funded deals" : "deals originated", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8A93A3" }}
                                />
                                {showCallCombo && (
                                  <YAxis
                                    yAxisId="deals"
                                    orientation="right"
                                    allowDecimals={false}
                                    tick={{ fontSize: 11, fill: "#374151" }}
                                    label={{ value: trendMetric === "both" ? "deals originated / funded" : trendMetric === "fundings" ? "funded deals" : "deals originated", angle: 90, position: "insideRight", fontSize: 11, fill: "#374151" }}
                                  />
                                )}
                                <Tooltip content={<TrendTooltip />} />
                                {showCallCombo
                                  ? [
                                      // calls: one bar per rep (left axis)
                                      ...trendReps.map((rep) => (
                                        <Bar key={rep + "-calls"} dataKey={`${rep} · ${callBarLabel}`} fill={colorForLender(rep, salesReps)} radius={[3, 3, 0, 0]}>
                                          {trendChartData.map((p, i) => (
                                            <Cell key={i} fill={colorForLender(rep, salesReps)} fillOpacity={p.inProgress ? 0.18 : 0.4} />
                                          ))}
                                        </Bar>
                                      )),
                                      // deals: one line per rep (right axis); dashed = originated when both are shown
                                      ...trendReps.flatMap((rep) => comboDealKeys.map((k) => (
                                        <Line
                                          key={rep + "-" + k}
                                          yAxisId="deals"
                                          type="monotone"
                                          dataKey={`${rep} · ${k === "orig" ? "originated" : "funded"}`}
                                          stroke={colorForLender(rep, salesReps)}
                                          strokeWidth={2}
                                          strokeDasharray={comboDealKeys.length > 1 && k === "orig" ? "5 3" : undefined}
                                          dot={{ r: 3 }}
                                          activeDot={{ r: 5 }}
                                          isAnimationActive={false}
                                        />
                                      ))),
                                    ]
                                  : trendMetric === "both"
                                  ? trendReps.flatMap((rep) => [
                                      // lighter bar = originated, solid bar = funded (same rep color)
                                      <Bar key={rep + "-orig"} dataKey={`${rep} · originated`} fill={colorForLender(rep, salesReps)} radius={[3, 3, 0, 0]}>
                                        {trendChartData.map((p, i) => (
                                          <Cell key={i} fill={colorForLender(rep, salesReps)} fillOpacity={p.inProgress ? 0.15 : 0.35} />
                                        ))}
                                      </Bar>,
                                      <Bar key={rep + "-fund"} dataKey={`${rep} · funded`} fill={colorForLender(rep, salesReps)} radius={[3, 3, 0, 0]}>
                                        {trendChartData.map((p, i) => (
                                          <Cell key={i} fill={colorForLender(rep, salesReps)} fillOpacity={p.inProgress ? 0.45 : 1} />
                                        ))}
                                      </Bar>,
                                    ])
                                  : trendReps.map((rep) => (
                                      <Bar key={rep} dataKey={rep} fill={colorForLender(rep, salesReps)} radius={[3, 3, 0, 0]}>
                                        {trendChartData.map((p, i) => (
                                          <Cell key={i} fill={colorForLender(rep, salesReps)} fillOpacity={p.inProgress ? 0.45 : 1} />
                                        ))}
                                      </Bar>
                                    ))}
                              </TrendChartComponent>
                            </ResponsiveContainer>
                          </div>
                          <TrendTable periods={trendSource.periods} reps={trendReps} series={tableSeries} metricKeys={tableMetricKeys} kind={trendPeriod} />
                        </>
                      )}
                    </>
                  )}
                </div>

                <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#E4E7EC]">
                    <h2 className="text-[13px] font-semibold text-[#1D2433]">Rep performance</h2>
                    <p className="text-[12px] text-[#8A93A3] mt-0.5">Click a rep to see their cancelled reasons, origination mix, top originators and MoM/WoW.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="kpi-table">
                      <thead>
                        <tr>
                          <th>Rep</th>
                          <th title="Deals created in the period">Deals</th>
                          <th title="Invoice amount of deals created in the period">Amount</th>
                          <th title="Deals now funded with a close date in the period">Funded</th>
                          <th title="Invoice amount of those funded deals">Funded amount</th>
                          <th title="Of deals created in the period, the share now funded">Conversion</th>
                          <th>Declined</th><th>Decline rate</th><th>Cancelled</th><th>Cancel rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {salesByRep.map((r) => {
                          const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
                          const isOpen = expandedSalesRep === r.rep;
                          const repColor = colorForLender(r.rep, salesReps);
                          return (
                            <React.Fragment key={r.rep}>
                              <tr className="cursor-pointer" onClick={() => setExpandedSalesRep(isOpen ? null : r.rep)}>
                                <td className="font-medium">
                                  <span className="inline-flex items-center gap-1.5">
                                    {isOpen ? <ChevronDown size={13} color="#6B7280" /> : <ChevronRight size={13} color="#6B7280" />}
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: repColor }}></span>
                                    {r.rep}
                                  </span>
                                </td>
                                <td className="mono">{r.deals.toLocaleString()}</td>
                                <td className="mono">{fmtMoney(r.amount)}</td>
                                <td className="mono text-[#1E7A3D]">{r.funded.toLocaleString()}</td>
                                <td className="mono">{fmtMoney(r.fundedAmount)}</td>
                                <td className="mono">{pct(r.conversionRate)}</td>
                                <td className="mono text-[#B3261E]">{r.declined.toLocaleString()}</td>
                                <td className="mono">{pct(r.declineRate)}</td>
                                <td className="mono">{r.cancelled.toLocaleString()}</td>
                                <td className="mono">{pct(r.cancelRate)}</td>
                              </tr>
                              {isOpen && (
                                <tr>
                                  <td colSpan={10} className="bg-[#FAFBFC]" style={{ padding: 0 }}>
                                    <SalesRepPanel
                                      rep={r.rep}
                                      color={repColor}
                                      kind={trendPeriod}
                                      onKindChange={setTrendPeriod}
                                      analysis={computeRepAnalysis(salesRepRows, r.rep, salesDateFrom, salesDateTo)}
                                      trend={buildTrend(salesRepRows.filter((x) => x.owner === r.rep), [r.rep], { kind: trendPeriod, range: trendRange, dateFrom: salesDateFrom, dateTo: salesDateTo, now: salesNow })}
                                      calls={rawCalls.length ? (() => {
                                        const t = callTotals(callRowsInRange.filter((x) => x.rep === r.rep));
                                        return { ...t, dialsPerDeal: r.deals ? t.dials / r.deals : null, dialsPerFunded: r.funded ? t.dials / r.funded : null };
                                      })() : null}
                                      callTrend={rawCalls.length ? buildCallsTrend(rawCalls.filter((x) => x.rep === r.rep), [r.rep], { kind: trendPeriod, range: trendRange, dateFrom: salesDateFrom, dateTo: salesDateTo, now: salesNow }) : null}
                                    />
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <h2 className="text-[13px] font-semibold text-[#1D2433] -mb-2 mt-2">Call activity</h2>
                {rawCalls.length === 0 ? (
                  <div className="bg-white border border-[#E4E7EC] rounded-lg p-4 text-[12px] text-[#8A93A3] text-center">
                    Call data isn't loaded yet. Run <span className="mono">rollUpCallsDaily</span> in the Apps Script, then reload this page.
                  </div>
                ) : callsByRep.length === 0 ? (
                  <div className="bg-white border border-[#E4E7EC] rounded-lg p-4 text-[13px] text-[#8A93A3] text-center">
                    No calls match the current reps and period.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <StatCard label="Outbound dials" value={callsSummary.dials.toLocaleString()} sub="Calls placed" />
                      <StatCard label="Answered" value={callsSummary.outAnswered.toLocaleString()} sub="Outbound calls picked up" tone="good" />
                      <StatCard label="Connect rate" value={callsSummary.connectRate === null ? "—" : `${(callsSummary.connectRate * 100).toFixed(1)}%`} sub="Answered ÷ dials" tone="good" />
                      <StatCard label="Inbound answered" value={callsSummary.inAnswered.toLocaleString()} />
                      <StatCard label="Inbound missed" value={callsSummary.inMissed.toLocaleString()} tone="bad" />
                      <StatCard label="Talk time" value={fmtMinutes(callsSummary.talkSeconds)} sub={`${fmtMinutes(callsSummary.avgTalkSeconds, 1)} per answered call`} tone="accent" />
                      <StatCard label="Dials per deal" value={fmtRatio(callsSummary.dialsPerDeal)} sub="Dials ÷ deals created" tooltip="Outbound dials in the period divided by deals created in the period." />
                      <StatCard label="Dials per funded deal" value={fmtRatio(callsSummary.dialsPerFunded)} sub="Dials ÷ deals funded" tooltip="Outbound dials in the period divided by deals funded in the period (by close date)." />
                    </div>

                    <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
                      <div className="px-4 py-3 border-b border-[#E4E7EC]">
                        <h2 className="text-[13px] font-semibold text-[#1D2433]">Call activity by rep</h2>
                        <p className="text-[12px] text-[#8A93A3] mt-0.5">Counted by Pacific calendar day. Answered means picked up, any length; talk time counts answered calls only.</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="kpi-table">
                          <thead>
                            <tr>
                              <th>Rep</th><th>Dials</th><th>Answered</th><th>Connect rate</th><th>Inbound answered</th><th>Inbound missed</th>
                              <th>Talk time</th><th>Avg call</th><th title="Dials divided by deals created">Dials / deal</th><th title="Dials divided by deals funded">Dials / funded</th>
                            </tr>
                          </thead>
                          <tbody>
                            {callsByRep.map((r) => (
                              <tr key={r.rep}>
                                <td className="font-medium">
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorForLender(r.rep, salesReps) }}></span>
                                    {r.rep}
                                  </span>
                                </td>
                                <td className="mono">{r.dials.toLocaleString()}</td>
                                <td className="mono text-[#1E7A3D]">{r.outAnswered.toLocaleString()}</td>
                                <td className="mono">{r.connectRate === null ? "—" : `${(r.connectRate * 100).toFixed(1)}%`}</td>
                                <td className="mono">{r.inAnswered.toLocaleString()}</td>
                                <td className="mono text-[#B3261E]">{r.inMissed.toLocaleString()}</td>
                                <td className="mono">{fmtMinutes(r.talkSeconds)}</td>
                                <td className="mono">{fmtMinutes(r.avgTalkSeconds, 1)}</td>
                                <td className="mono">{fmtRatio(r.dialsPerDeal)}</td>
                                <td className="mono">{fmtRatio(r.dialsPerFunded)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}

                <p className="text-[11px] text-[#AAB1BC] text-center max-w-2xl mx-auto">
                  Deals, amount, declined and cancelled count deals by created date. Funded counts deals by close date. Funded = currently at 85/185/90/190, declined = 99/199, cancelled = 98/198, based on each deal's current stage.
                  {(salesDateFrom || salesDateTo) && salesFundedNoClose > 0
                    ? ` ${salesFundedNoClose} funded deal${salesFundedNoClose === 1 ? " has" : "s have"} no close date and ${salesFundedNoClose === 1 ? "is" : "are"} left out while a period is set.`
                    : ""}
                </p>
              </>
            )}
          </>
        )}

        {/* ---------------- LENDER PERFORMANCE TAB ---------------- */}
        {activeTab === "lenders" && (
          <>
            {/* Lender Performance has its own minimal filter: date range on
                when each Funding_Source__c record was submitted, not the
                Opportunity's Created date used elsewhere. */}
            <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#6B7280] mr-1">
                <Filter size={13} /> Filters
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-[#8A93A3]">Submitted</span>
                <input type="date" value={lenderDateFrom} onChange={(e) => setLenderDateFrom(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5" />
                <span className="text-[12px] text-[#8A93A3]">to</span>
                <input type="date" value={lenderDateTo} onChange={(e) => setLenderDateTo(e.target.value)} className="text-[13px] border border-[#D8DCE3] rounded px-2 py-1.5" />
              </div>
              {(lenderDateFrom || lenderDateTo) && (
                <button
                  onClick={() => { setLenderDateFrom(""); setLenderDateTo(""); }}
                  className="flex items-center gap-1 text-[12px] text-[#B3261E] ml-1"
                >
                  <X size={12} /> Clear
                </button>
              )}
            </div>

            {lenderStats.length === 0 && (
              <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-6 text-center">
                <AlertCircle size={20} color="#B3261E" className="mx-auto mb-2" />
                <p className="text-[14px] font-medium text-[#1D2433]">No lender submission data loaded</p>
                <p className="text-[12px] text-[#8A93A3] mt-1 max-w-md mx-auto">
                  This tab reads the "funding_sources" sheet from your Salesforce sync. Make sure the Apps Script has run at least once since the Funding Source tracking was added, and try refreshing, or widen the date filter above.
                </p>
              </div>
            )}

            {lenderStats.length > 0 && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  <StatCard label="Total submitted" value={lenderSummary.totalSubmitted} icon={Users} />
                  <StatCard label="Approved" value={lenderSummary.totalApproved} tone="good" icon={TrendingUp} />
                  <StatCard label="Approval rate" value={lenderSummary.approvalRate === null ? "—" : `${(lenderSummary.approvalRate * 100).toFixed(1)}%`} tone="good" />
                  <StatCard label="Declined" value={lenderSummary.totalDeclined} tone="bad" icon={TrendingDown} />
                  <StatCard label="Decline rate" value={lenderSummary.declineRate === null ? "—" : `${(lenderSummary.declineRate * 100).toFixed(1)}%`} tone="bad" />
                  <StatCard
                    label="Syndication funded rate"
                    value={lenderSummary.syndicatedConversionRate === null ? "—" : `${(lenderSummary.syndicatedConversionRate * 100).toFixed(1)}%`}
                    sub={`${lenderSummary.syndicatedFundedCount} of ${lenderSummary.syndicatedSubmittedCount} submitted`}
                    tooltip="Of the syndicated (3-digit track) deals submitted to any lender, the share that reached 185 or 190 (Syndication-specific Funded/Closed-Won stages)."
                    tone="accent"
                  />
                </div>

                <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card p-4">
                  <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                    <h2 className="text-[13px] font-semibold text-[#1D2433]">Lender approval rates</h2>
                    <div className="inline-flex items-center border border-[#D8DCE3] rounded-lg overflow-hidden">
                      <button
                        onClick={() => setLenderChartMode("approved")}
                        className={`text-[12px] font-semibold px-4 py-1.5 transition-colors ${
                          lenderChartMode === "approved" ? "bg-[#1D4E89] text-white" : "bg-white text-[#4B5563] hover:bg-[#F6F7F9]"
                        }`}
                      >
                        Approval rate
                      </button>
                      <button
                        onClick={() => setLenderChartMode("volume")}
                        className={`text-[12px] font-semibold px-4 py-1.5 border-l border-[#D8DCE3] transition-colors ${
                          lenderChartMode === "volume" ? "bg-[#1E7A3D] text-white" : "bg-white text-[#4B5563] hover:bg-[#F6F7F9]"
                        }`}
                      >
                        Volume
                      </button>
                    </div>
                  </div>
                  <p className="text-[12px] text-[#8A93A3] mb-3">Same lender order in both views — hover a bar for the full name and stats.</p>
                  <div style={{ width: "100%", height: 300 }}>
                    <ResponsiveContainer>
                      <BarChart
                        data={lenderStats.map((r) => ({
                          name: initialsForLender(r.lender),
                          fullName: r.lender,
                          rate: r.rate !== null ? Number((r.rate * 100).toFixed(1)) : 0,
                          declineRate: r.declineRate !== null ? Number((r.declineRate * 100).toFixed(1)) : null,
                          submitted: r.submitted,
                          approved: r.approved,
                        }))}
                        margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                        barCategoryGap="30%"
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F3" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} interval={0} />
                        <YAxis
                          tick={{ fontSize: 11, fill: "#6B7280" }}
                          label={{ value: lenderChartMode === "volume" ? "deals submitted" : "% approved", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8A93A3" }}
                        />
                        <Tooltip content={<LenderChartTooltip />} />
                        <Bar dataKey={lenderChartMode === "volume" ? "submitted" : "rate"} radius={[4, 4, 0, 0]}>
                          {lenderStats.map((r, i) => (
                            <Cell key={i} fill={colorForLender(r.lender, lenderStats.map((x) => x.lender))} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white border border-[#E4E7EC] rounded-lg fintech-card overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#E4E7EC]">
                    <h2 className="text-[13px] font-semibold text-[#1D2433]">Lender Performance</h2>
                    <p className="text-[12px] text-[#8A93A3] mt-0.5">Deals submitted and approved per lender, from the funding_sources sync.</p>
                  </div>
                  <table className="kpi-table">
                    <thead>
                      <tr><th>Lender</th><th>Submitted</th><th>Approved</th><th>Declined</th><th>Pending</th><th>Approval rate</th></tr>
                    </thead>
                    <tbody>
                      {lenderStats.map((r) => (
                        <tr key={r.lender}>
                          <td className="font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorForLender(r.lender, lenderStats.map((x) => x.lender)) }}></span>
                              {r.lender}
                            </span>
                          </td>
                          <td className="mono">{r.submitted}</td>
                          <td className="mono text-[#1E7A3D]">{r.approved}</td>
                          <td className="mono text-[#B3261E]">{r.declined}</td>
                          <td className="mono">{r.pending}</td>
                          <td className="mono">{r.rate === null ? "—" : `${(r.rate * 100).toFixed(1)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-[11px] text-[#AAB1BC] text-center max-w-2xl mx-auto">
                  {lenderSummary.staleCount > 0
                    ? `${lenderSummary.staleCount} funding source record${lenderSummary.staleCount === 1 ? "" : "s"} still pending/awaiting info and not updated in over 7 days.`
                    : "No stale funding source records — everything pending has been touched within the last 7 days."}
                  {" "}Time-to-decision isn't shown yet — Salesforce doesn't currently track history on the submission Status field, only its current value, so there's no reliable timestamp for when a decision was made.
                </p>
              </>
            )}
          </>
        )}

        <p className="text-[11px] text-[#AAB1BC] text-center py-6">
          This site is the property of SLIM Capital, LLC and is intended solely for internal review and private use.
        </p>
      </div>
        </>
      )}
    </div>
  );
}
