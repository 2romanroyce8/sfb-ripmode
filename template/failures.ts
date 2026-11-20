import { canView, sampleSeats } from "./executive-navigation";

export const queueStatuses = ["Not started", "In progress", "Waiting on client", "Waiting on teammate", "Blocked", "Done"] as const;
export const kinds = ["Stalled handoff", "Overdue task", "Failed automation event", "Failed payment or delivery step", "Missing join link", "Ambiguous report match", "Unassigned lead"] as const;
export const threshold = "[Decision] Overdue threshold";
export const handoffDeadline = "[Decision] Handoff deadline";

type Status = typeof queueStatuses[number];
type Kind = typeof kinds[number];
type Event = { record: string; result: "Failed" | "Rejected" | "Closed"; tries: number; lastError: string };
export type FailureAction = "Assign owner" | "Change status" | "Add blocked reason" | "Escalate" | "Accept handoff" | "Mark done" | "Replay now" | "Close event";
type Entry = { actor: number; action: FailureAction; when: string; reason: string; previousOwner: number | null; newOwner: number | null };

export type Failure = {
  id: string; subject: string; business: string; kind: Kind; stage: string; next: string;
  owner: number | null; reason: string; source: string; status: Status; age: number;
  overdue?: boolean; payment?: boolean; event?: Event;
  history: Entry[];
  handoffs: { sender: number; receiver: number; acceptedAt?: string }[];
};

const fixtures: Omit<Failure, "history" | "handoffs">[] = [
  { id: "lead", subject: "Cedar Roofing", business: "prints", kind: "Unassigned lead", stage: "New", next: "Assign a lead owner", owner: null, reason: "", source: "Website inquiry", status: "Not started", age: 5 },
  { id: "review", subject: "Northline Dental", business: "bingled", kind: "Failed automation event", stage: "Onboarding", next: "Review the failed event", owner: 5, reason: "Project creation failed", source: "Project provisioning", status: "Blocked", age: 32, event: { record: "Sample project B-102", result: "Failed", tries: 5, lastError: "Project store unavailable" } },
  { id: "rejected", subject: "Harbor Fitness", business: "botis", kind: "Failed automation event", stage: "Demo", next: "Review webhook rejection", owner: 5, reason: "Signature did not match", source: "Campaign webhook", status: "Blocked", age: 18, event: { record: "Sample event A-201", result: "Rejected", tries: 0, lastError: "Invalid signature" } },
  { id: "payment", subject: "Alder Studio", business: "hq", kind: "Failed payment or delivery step", stage: "Payment collection", next: "Review collection failure", owner: 3, reason: "Sample payment declined", source: "Billing event", status: "Blocked", age: 20, payment: true },
  { id: "handoff", subject: "Maya Chen", business: "etm", kind: "Stalled handoff", stage: "Applied", next: "Confirm applicant handoff", owner: 4, reason: "", source: "Membership intake", status: "Waiting on teammate", age: 42, overdue: true },
  { id: "task", subject: "Oak & Stone", business: "prints", kind: "Overdue task", stage: "Proposal", next: "Send proposal for review", owner: 1, reason: "", source: "Sales queue", status: "In progress", age: 23, overdue: true },
  { id: "delivery", subject: "Summit Design", business: "bingled", kind: "Failed payment or delivery step", stage: "QA", next: "Request approval of new build", owner: 4, reason: "", source: "QA checklist", status: "Waiting on client", age: 27 },
  { id: "meet", subject: "Meadow Health", business: "botis", kind: "Missing join link", stage: "Demo", next: "Confirm the meeting link", owner: 1, reason: "", source: "Calendar", status: "Not started", age: 10 },
  { id: "report", subject: "Drew Rivera", business: "hq", kind: "Ambiguous report match", stage: "Interview", next: "Match report to applicant", owner: 4, reason: "", source: "Interview notes", status: "In progress", age: 14 },
  { id: "resolved", subject: "Lakeside Electric", business: "prints", kind: "Missing join link", stage: "Booked", next: "Link confirmed", owner: 1, reason: "", source: "Calendar", status: "Done", age: 50 },
  { id: "retry", subject: "Jordan Ellis", business: "etm", kind: "Failed automation event", stage: "Member intake", next: "Replay the invite event", owner: 5, reason: "Invite request timed out", source: "Member onboarding", status: "Blocked", age: 12, event: { record: "Sample application E-88", result: "Failed", tries: 4, lastError: "Invite service timeout" } },
  { id: "notes", subject: "Vista Home", business: "bingled", kind: "Ambiguous report match", stage: "Discovery", next: "Confirm which meeting the report belongs to", owner: 4, reason: "", source: "Call notes", status: "Waiting on teammate", age: 15 },
];

export const initialFailures: Failure[] = fixtures.map(row => ({ ...row, history: [], handoffs: [] }));
export const needsReview = (row: Failure) => Boolean(row.event?.result === "Failed" && row.event.tries >= 5);

export function canSeeFailure(row: Failure, seat: number, workspace?: string) {
  const grant = sampleSeats[seat]?.grant;
  return canView(grant, "failures") && grant.businesses.includes(row.business) &&
    (!row.payment || grant.finance) && (!workspace || row.business === workspace);
}

export function listFailures(rows: Failure[], seat: number, workspace?: string) {
  return rows.filter(row => canSeeFailure(row, seat, workspace)).sort((a, b) =>
    Number(b.owner === null) - Number(a.owner === null) ||
    Number(needsReview(b)) - Number(needsReview(a)) ||
    Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)) || b.age - a.age);
}

export function updateFailure(row: Failure, seat: number, action: FailureAction, reason: string, owner?: number, status?: Status): Failure {
  if (!canSeeFailure(row, seat)) throw new Error("This item is outside your sample grants.");
  reason = reason.trim();
  const next = { ...row };
  const when = new Date().toISOString();

  switch (action) {
    case "Assign owner":
    case "Escalate":
      if (owner === undefined || !canSeeFailure(row, owner) || (action === "Escalate" && (owner === seat || owner === row.owner))) {
        throw new Error("Choose an eligible receiving seat.");
      }
      next.owner = owner;
      if (action === "Escalate") next.handoffs = [...row.handoffs, { sender: seat, receiver: owner }];
      break;
    case "Accept handoff": {
      const handoff = row.handoffs.at(-1);
      if (!handoff || handoff.acceptedAt || handoff.receiver !== seat || row.owner !== seat) throw new Error("Only the receiving owner can accept.");
      next.handoffs = [...row.handoffs.slice(0, -1), { ...handoff, acceptedAt: when }];
      break;
    }
    case "Change status":
      if (!status || !queueStatuses.includes(status) || status === "Done") throw new Error("Choose a status or use Mark done.");
      if (status === "Blocked" && !reason) throw new Error("Enter a written blocked reason.");
      next.status = status;
      if (status === "Blocked") next.reason = reason;
      break;
    case "Add blocked reason":
      if (!reason) throw new Error("Enter a written blocked reason.");
      next.reason = reason;
      break;
    case "Replay now":
      if (row.event?.result !== "Failed" || row.status === "Done") throw new Error("This event cannot be replayed.");
      next.event = { ...row.event, tries: row.event.tries + 1 };
      reason = reason || "Simulated retry failed with the same error.";
      break;
    case "Close event":
    case "Mark done":
      if (!reason) throw new Error("Enter a short completion note.");
      if (row.owner === null) throw new Error("Assign an owner before closing this item.");
      if (action === "Close event" && (!row.event || row.event.result === "Closed")) throw new Error("There is no open event.");
      next.status = "Done";
      next.overdue = false;
      if (row.event) next.event = { ...row.event, result: row.event.result === "Rejected" ? "Rejected" : "Closed" };
      break;
  }

  return { ...next, history: [...row.history, { actor: seat, action, when, reason, previousOwner: row.owner, newOwner: next.owner }] };
}
