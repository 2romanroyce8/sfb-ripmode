import { canView, sampleSeats } from "./executive-navigation";

export const types = ["Price exception", "Executive access request", "Payout", "Refund", "Offer or campaign", "Procedure change", "Policy decision", "Hiring decision"] as const;
export const statuses = ["Pending", "Approved", "Rejected", "Needs info", "Escalated", "Expired"] as const;
type ApprovalType = typeof types[number];
type Status = typeof statuses[number];
export type Action = "Approve" | "Reject" | "Request info" | "Escalate" | "Accept handoff";
export type Scope = "owned" | "submitted" | "sent";
export const deadline = "[Decision] Handoff deadline";

export const rules: Record<ApprovalType, string> = {
  "Price exception": "Owner depends on the size of the exception. [Decision] Approval limit and routing.",
  "Executive access request": "The CEO reviews access to named businesses and functions. Finance requires a separate explicit grant request.",
  Payout: "The CFO owns the payout. The preparer must be a different person from the approver.",
  Refund: "Explicit finance access is required. [Decision] Refund approval limit.",
  "Offer or campaign": "The CMO owns the decision.",
  "Procedure change": "The COO owns the decision.",
  "Policy decision": "The CEO owns the decision.",
  "Hiring decision": "An executive reviews requests above the hiring manager’s limit. [Decision] approval limit.",
};

type Entry = { actor: number; action: Action; when: string; reason: string; previousOwner: number; newOwner: number };
export type Approval = {
  id: string; title: string; type: ApprovalType; business: string; requester: number;
  applicantId?: string; owner: number; status: Status; notes: string; amount?: number; preparer?: number; overdue?: boolean;
  handoffs: { sender: number; recipient: number; acceptedAt?: string }[];
  history: Entry[];
};

export const initialApprovals: Approval[] = [
  { id: "1", title: "Website proposal discount", type: "Price exception", business: "bingled", requester: 1, owner: 0, status: "Pending", overdue: true, amount: 400, notes: "Review the requested discount on the sample website proposal." },
  { id: "2", title: "Executive workspace access", type: "Executive access request", business: "hq", requester: 5, owner: 0, status: "Pending", notes: "Requested scope is HQ Overview and Approvals. Finance would require a separate request." },
  { id: "3", title: "Client handoff policy", type: "Policy decision", business: "hq", requester: 0, owner: 0, status: "Pending", notes: "Confirm the policy for logging who accepts a client handoff." },
  { id: "4", title: "Commission payout", type: "Payout", business: "prints", requester: 1, preparer: 3, owner: 3, status: "Pending", amount: 750, notes: "The sample CFO prepared this payout. It requires a separate authorized approver." },
  { id: "5", title: "Website deposit refund", type: "Refund", business: "bingled", requester: 4, owner: 3, status: "Needs info", amount: 250, notes: "Confirm why the sample deposit should be refunded." },
  { id: "6", title: "Agency workshop campaign", type: "Offer or campaign", business: "etm", requester: 1, owner: 2, status: "Approved", notes: "Sample campaign promoting the agency workshop." },
  { id: "7", title: "Delivery checklist change", type: "Procedure change", business: "bingled", requester: 5, owner: 4, status: "Pending", notes: "Add a client sign-off step between QA and launch." },
  { id: "8", title: "Demo follow-up policy", type: "Policy decision", business: "botis", requester: 2, owner: 0, status: "Rejected", notes: "Proposed review process for demo follow-ups." },
  { id: "9", title: "Workshop pricing exception", type: "Price exception", business: "etm", requester: 2, owner: 1, status: "Expired", notes: "The sample workshop offer expired before a decision." },
  { id: "10", title: "New demo review procedure", type: "Procedure change", business: "botis", requester: 1, owner: 4, status: "Escalated", notes: "Review the proposed checklist for demo approvals.", handoffs: [{ sender: 5, recipient: 4 }] },
  { id: "sample-hiring-sample-applicant-11-1", applicantId: "sample-applicant-11", title: "Sample hiring decision · Sam Wells", type: "Hiring decision", business: "botis", requester: 1, owner: 4, status: "Pending", notes: "Sample request above the hiring manager’s limit. [Decision] approval limit." },
].map(row => ({ handoffs: [], history: [], ...row })) as Approval[];

export function hasScope(row: Approval, seat: number) {
  const grant = sampleSeats[seat]?.grant;
  const financial = row.type === "Payout" || row.type === "Refund";
  return canView(grant, "approvals") && grant.businesses.includes(row.business) && (!financial || grant.finance);
}

export function visibleApprovals(rows: Approval[], seat: number, scope: Scope) {
  return rows.filter(row => hasScope(row, seat) && (
    scope === "submitted" ? row.requester === seat :
    scope === "sent" ? row.handoffs.some(handoff => handoff.sender === seat) :
    row.owner === seat
  )).sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)));
}

export function blockedReason(row: Approval, seat: number, action: Action) {
  if (!hasScope(row, seat) || row.owner !== seat) return "Only the assigned owner can act.";
  if (["Approved", "Rejected", "Expired"].includes(row.status)) return "This request is closed.";
  const awaiting = row.status === "Escalated" && !row.handoffs.at(-1)?.acceptedAt;
  if (action === "Accept handoff") return awaiting ? "" : "There is no pending handoff.";
  if (action === "Approve" && row.requester === seat) return "You cannot approve your own request.";
  if (action === "Approve" && row.type === "Payout" && row.preparer === seat) return "You cannot approve a payout you prepared.";
  return awaiting ? "Accept the handoff before acting." : "";
}

export function act(row: Approval, seat: number, action: Action, reason: string, receiver: number | undefined, when: string): Approval {
  const blocked = blockedReason(row, seat, action);
  if (blocked) throw new Error(blocked);
  reason = reason.trim();
  if ((action === "Reject" || action === "Request info") && !reason) throw new Error("Enter a written reason.");
  let owner = row.owner;
  let handoffs = row.handoffs;
  const status: Record<Action, Status> = { Approve: "Approved", Reject: "Rejected", "Request info": "Needs info", Escalate: "Escalated", "Accept handoff": "Pending" };
  if (action === "Escalate") {
    if (receiver === undefined || receiver === seat || !hasScope(row, receiver)) throw new Error("Choose an eligible receiving seat.");
    owner = receiver;
    handoffs = [...handoffs, { sender: seat, recipient: receiver }];
  }
  if (action === "Accept handoff") {
    handoffs = handoffs.map((handoff, index) => index === handoffs.length - 1 ? { ...handoff, acceptedAt: when } : handoff);
  }
  return { ...row, owner, handoffs, status: status[action], overdue: row.overdue && !["Approve", "Reject"].includes(action),
    history: [...row.history, { actor: seat, action, when, reason, previousOwner: row.owner, newOwner: owner }] };
}
