import { Building2, CircleAlert, ClipboardCheck, History, LayoutDashboard, Settings2, ShieldCheck, Users, Wallet } from "lucide-react";

export const executiveTabs = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "approvals", label: "Approvals", icon: ClipboardCheck },
  { key: "failures", label: "Failed and Stalled", icon: CircleAlert },
  { key: "businesses", label: "Businesses", icon: Building2 },
  { key: "finance", label: "Finance", icon: Wallet },
  { key: "hiring", label: "Hiring", icon: Users },
  { key: "permissions", label: "Permissions", icon: ShieldCheck },
  { key: "audit", label: "Audit Log", icon: History },
  { key: "settings", label: "Settings", icon: Settings2 },
] as const;

export type ExecutiveTab = typeof executiveTabs[number]["key"];

type SampleGrant = {
  businesses: readonly string[];
  functions: readonly ExecutiveTab[];
  finance: boolean;
};

export const sampleBusinesses = [
  { id: "hq", name: "Six Figure Blueprints HQ" },
  { id: "prints", name: "SFB Prints" },
  { id: "etm", name: "ETMHere" },
  { id: "bingled", name: "BingledCo" },
  { id: "botis", name: "BOTISAI" },
];

export const sampleSeats = [
  { label: "Founder & CEO", grant: { businesses: ["hq", "prints", "etm", "bingled", "botis"], functions: ["overview", "approvals", "failures", "businesses", "hiring", "permissions", "audit", "settings"], finance: false } },
  { label: "President / Business lead", grant: { businesses: ["prints", "etm", "bingled", "botis"], functions: ["overview", "approvals", "failures", "businesses", "hiring", "settings"], finance: false } },
  { label: "CMO", grant: { businesses: ["prints", "etm", "bingled", "botis"], functions: ["overview", "approvals", "failures", "businesses", "settings"], finance: false } },
  { label: "CFO", grant: { businesses: ["hq", "prints", "bingled"], functions: ["overview", "approvals", "failures", "businesses", "finance", "audit", "settings"], finance: true } },
  { label: "COO", grant: { businesses: ["hq", "prints", "etm", "bingled", "botis"], functions: ["overview", "approvals", "failures", "businesses", "hiring", "settings"], finance: false } },
  { label: "CTO", grant: { businesses: ["hq", "prints", "etm", "bingled", "botis"], functions: ["overview", "approvals", "failures", "businesses", "permissions", "audit", "settings"], finance: false } },
] satisfies { label: string; grant: SampleGrant }[];

export function canView(grant: SampleGrant | undefined, tab: ExecutiveTab) {
  return Boolean(grant?.businesses.length && grant.functions.includes(tab) && (tab !== "finance" || grant.finance));
}
