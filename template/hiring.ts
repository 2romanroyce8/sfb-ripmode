import { hasScope, type Approval } from "./approvals";
import { canView, sampleSeats } from "./executive-navigation";

export const hiringStages = ["Received", "Screened", "Shortlisted", "Interview", "Scorecard", "Decision", "Hired", "Declined"] as const;
export const hiringRoles = ["Appointment Setter", "DM Setter", "Sales Rep", "Closer"] as const;
export const hiringStatuses = ["Not started", "In progress", "Waiting on applicant", "Waiting on teammate", "Blocked", "Done"] as const;
export const hiringDue = "[Decision] Hiring due time";
export const approvalLimit = "[Decision] approval limit";

type Stage = typeof hiringStages[number];
export type HiringAction = "Assign owner" | "Change stage" | "Add blocked reason" | "Request decision" | "Mark hired" | "Mark declined";
type Entry = { actor: number; action: HiringAction; when: string; reason: string; previousOwner: number | null; newOwner: number | null };

export type Applicant = {
  id: string;
  workspaceId: string;
  name: string;
  role: typeof hiringRoles[number];
  stage: Stage;
  status: typeof hiringStatuses[number];
  next: string;
  owner: number | null;
  blockedReason: string;
  source: string;
  days: number;
  overdue: boolean;
  answers: string;
  interviewNotes?: string;
  history: Entry[];
};

export type PaidTraining = { id: string; applicantId: string; workspaceId: string; status: "Not started" };
const nextActions: Record<Stage, string> = {
  Received: "Review the application",
  Screened: "Review for the shortlist",
  Shortlisted: "Arrange the interview",
  Interview: "Record the interview notes",
  Scorecard: "Review the scorecard",
  Decision: "Review the hiring decision",
  Hired: "Hand off to paid training",
  Declined: "No further action",
};

const samples: [string, string, Applicant["role"], Stage, Applicant["status"], number | null, string, number][] = [
  ["Avery Reed", "hq", "DM Setter", "Received", "Not started", null, "Careers form", 2],
  ["Jordan Pike", "hq", "Sales Rep", "Screened", "In progress", 4, "Careers form", 1],
  ["Casey Bell", "prints", "Appointment Setter", "Shortlisted", "Waiting on applicant", 1, "Referral", 3],
  ["Morgan Ellis", "prints", "Closer", "Interview", "In progress", 1, "Careers form", 2],
  ["Drew Lane", "prints", "DM Setter", "Hired", "Done", 1, "Referral", 0],
  ["Riley Page", "etm", "Sales Rep", "Scorecard", "Waiting on teammate", 4, "Careers form", 2],
  ["Jamie Cole", "etm", "Closer", "Decision", "In progress", 1, "Referral", 1],
  ["Quinn Hart", "bingled", "DM Setter", "Declined", "Done", 4, "Careers form", 0],
  ["Taylor Hayes", "bingled", "Appointment Setter", "Received", "Not started", 4, "Careers form", 1],
  ["Blake Shaw", "bingled", "Sales Rep", "Interview", "Blocked", 4, "Referral", 5],
  ["Sam Wells", "botis", "Closer", "Decision", "Waiting on teammate", 1, "Careers form", 3],
  ["Alex Rowan", "botis", "DM Setter", "Screened", "In progress", 4, "Careers form", 1],
];

export const initialApplicants: Applicant[] = samples.map(([name, workspaceId, role, stage, status, owner, source, days], index) => ({
  id: `sample-applicant-${index + 1}`, name, workspaceId, role, stage, status, owner, source, days,
  next: nextActions[stage], overdue: status === "Blocked",
  blockedReason: status === "Blocked" ? "Waiting for interview availability." : "",
  answers: "I keep follow-up notes and record the next action after each conversation.",
  interviewNotes: ["Scorecard", "Decision", "Hired", "Declined"].includes(stage) ? "Interview completed. Notes are available for the hiring decision." : undefined,
  history: [],
}));

function trainingFor(row: Applicant): PaidTraining {
  return { id: `sample-training-${row.id}`, applicantId: row.id, workspaceId: row.workspaceId, status: "Not started" };
}
export const initialTraining = initialApplicants.filter(row => row.stage === "Hired").map(trainingFor);

function canSee(row: Applicant, seat: number) {
  const grant = sampleSeats[seat]?.grant;
  return canView(grant, "hiring") && grant.businesses.includes(row.workspaceId);
}

export function listApplicants(rows: Applicant[], seat: number, workspaceId?: string) {
  return rows.filter(row => canSee(row, seat) && (!workspaceId || row.workspaceId === workspaceId))
    .sort((a, b) => Number(b.owner === null) - Number(a.owner === null));
}

export function hiringCounts(rows: Applicant[], workspaceId?: string) {
  const scoped = rows.filter(row => !workspaceId || row.workspaceId === workspaceId);
  return { total: scoped.length, stages: hiringStages.map(stage => scoped.filter(row => row.stage === stage).length) };
}

export function hiringApprovals(row: Applicant, approvals: Approval[]) {
  return approvals.filter(item => item.type === "Hiring decision" && item.business === row.workspaceId && item.applicantId === row.id);
}

export function decisionSeats(row: Applicant, requester: number) {
  return sampleSeats.flatMap((seat, index) => index !== requester &&
    canView(seat.grant, "approvals") && seat.grant.businesses.includes(row.workspaceId) ? [index] : []);
}

export function updateApplicant(
  row: Applicant, approvals: Approval[], seat: number, action: HiringAction,
  input: { reason: string; selectedOwner?: number; stage?: Stage; receiver?: number; escalation?: "above" | "within" },
  when: string,
): { applicant: Applicant; approval?: Approval; training?: PaidTraining } {
  if (!canSee(row, seat)) throw new Error("This applicant is outside your assigned businesses.");
  if (row.status === "Done") throw new Error("This application is closed.");
  const reason = input.reason.trim();
  if (["Add blocked reason", "Mark hired", "Mark declined"].includes(action) && !reason) throw new Error("Enter a written reason or note.");
  const previousDecisions = hiringApprovals(row, approvals);
  const decision = previousDecisions.at(-1);
  const pending = decision && !["Approved", "Rejected", "Expired"].includes(decision.status);
  const applicant = { ...row };
  let approval: Approval | undefined;
  let training: PaidTraining | undefined;

  switch (action) {
    case "Assign owner":
      if (input.selectedOwner === undefined || !canSee(row, input.selectedOwner)) throw new Error("Choose an owner assigned to this business.");
      applicant.owner = input.selectedOwner;
      break;
    case "Change stage":
      if (pending || decision?.status === "Approved") throw new Error("This applicant has an active or approved decision request.");
      if (!input.stage || !hiringStages.includes(input.stage) || ["Hired", "Declined"].includes(input.stage)) throw new Error("Choose an active stage.");
      applicant.stage = input.stage;
      applicant.status = input.stage === "Received" ? "Not started" : "In progress";
      break;
    case "Add blocked reason":
      applicant.status = "Blocked";
      applicant.blockedReason = reason;
      break;
    case "Request decision":
      if (row.owner === null) throw new Error("Assign an owner first.");
      if (row.stage !== "Decision") throw new Error("Move the applicant to Decision first.");
      if (pending || decision?.status === "Approved") throw new Error("A decision request already exists.");
      if (input.escalation !== "above") throw new Error("Confirm this sample request is above the hiring manager’s limit.");
      if (input.receiver === undefined || !decisionSeats(row, seat).includes(input.receiver)) throw new Error("Choose another eligible executive seat.");
      approval = {
        id: `sample-hiring-${row.id}-${previousDecisions.length + 1}`, applicantId: row.id,
        title: `Sample hiring decision · ${row.name}`, type: "Hiring decision", business: row.workspaceId,
        requester: seat, owner: input.receiver, status: "Pending", notes: reason || "Review this sample hiring decision.",
        handoffs: [], history: [],
      };
      if (!hasScope(approval, input.receiver)) throw new Error("That seat cannot view the approval.");
      applicant.status = "Waiting on teammate";
      break;
    case "Mark hired":
      if (row.owner === null) throw new Error("Assign an owner first.");
      if (row.stage !== "Decision") throw new Error("Move the applicant to Decision first.");
      if (decision ? decision.status !== "Approved" : input.escalation !== "within") throw new Error("Confirm the decision is within the hiring manager’s limit or obtain executive approval.");
      applicant.stage = "Hired";
      applicant.status = "Done";
      training = trainingFor(row);
      break;
    case "Mark declined":
      if (row.owner === null) throw new Error("Assign an owner first.");
      if (pending) throw new Error("Resolve the pending approval first.");
      applicant.stage = "Declined";
      applicant.status = "Done";
      break;
  }

  if (applicant.stage !== row.stage) {
    applicant.days = 0;
    applicant.overdue = false;
  }
  if (applicant.status !== "Blocked") applicant.blockedReason = "";
  applicant.next = applicant.status === "Waiting on teammate" && approval ? "Wait for executive approval" : nextActions[applicant.stage];
  if (action === "Assign owner" || action === "Add blocked reason") applicant.next = row.next;
  applicant.history = [...row.history, { actor: seat, action, when, reason, previousOwner: row.owner, newOwner: applicant.owner }];
  return { applicant, approval, training };
}
