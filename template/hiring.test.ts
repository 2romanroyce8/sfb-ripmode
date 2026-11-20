import assert from "node:assert/strict";
import test from "node:test";
import { act } from "./approvals";
import { hiringCounts, hiringRoles, hiringStages, hiringStatuses, initialApplicants, initialTraining, listApplicants, updateApplicant } from "./hiring";

const when = "2026-11-13T12:00:00Z";

test("pipeline fixtures cover every stage, role and status across the five scoped businesses", () => {
  const rows = listApplicants(initialApplicants, 0);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].owner, null);
  const businesses = new Set(rows.map(row => row.workspaceId));
  assert.equal(businesses.size, 5);
  assert.equal([...businesses].reduce((count, business) => count + hiringCounts(rows, business).total, 0), rows.length);
  assert.equal(hiringCounts(rows).stages.length, hiringStages.length);
  assert(hiringCounts(rows).stages.every(Boolean));
  assert.deepEqual(new Set(rows.map(row => row.role)), new Set(hiringRoles));
  assert.deepEqual(new Set(rows.map(row => row.status)), new Set(hiringStatuses));
  assert.equal(listApplicants(rows, 1, "hq").length, 0);
  assert.equal(listApplicants(rows, 3).length, 0);
  assert.equal(initialTraining[0].applicantId, rows.find(row => row.stage === "Hired")?.id);
});

test("assignment and required notes respect scope and preserve the audit history", () => {
  const row = initialApplicants[0];
  assert.throws(() => updateApplicant(row, [], 1, "Assign owner", { reason: "", selectedOwner: 0 }, when), /outside/);
  assert.throws(() => updateApplicant(row, [], 0, "Assign owner", { reason: "", selectedOwner: 1 }, when), /assigned/);
  const { applicant } = updateApplicant(row, [], 0, "Assign owner", { reason: "Coverage", selectedOwner: 4 }, when);
  assert.deepEqual(applicant.history[0], { actor: 0, action: "Assign owner", when, reason: "Coverage", previousOwner: null, newOwner: 4 });
  for (const action of ["Mark hired", "Mark declined", "Add blocked reason"] as const) {
    assert.throws(() => updateApplicant(applicant, [], 0, action, { reason: " " }, when), /written/);
  }
});

test("above-limit decisions require another approver and produce one separate training record", () => {
  const row = initialApplicants.find(item => item.stage === "Decision")!;
  const result = updateApplicant(row, [], 0, "Request decision", { reason: "Review offer", receiver: 1, escalation: "above" }, when);
  const approval = result.approval!;
  assert.equal(approval.applicantId, row.id);
  assert.throws(() => act({ ...approval, owner: 0 }, 0, "Approve", "", undefined, when), /own request/);
  assert.throws(() => updateApplicant(result.applicant, [approval], 0, "Request decision", { reason: "", receiver: 1, escalation: "above" }, when), /already exists/);
  assert.throws(() => updateApplicant(result.applicant, [approval], 0, "Mark hired", { reason: "Hire" }, when), /approval/);
  const approved = act(approval, 1, "Approve", "", undefined, when);
  const hired = updateApplicant(result.applicant, [approved], 0, "Mark hired", { reason: "Approved offer" }, when);
  assert.equal(hired.applicant.stage, "Hired");
  assert.equal(hired.training?.status, "Not started");
  assert.equal(hired.training?.workspaceId, row.workspaceId);
  assert.equal(hired.training?.applicantId, row.id);
  assert.throws(() => updateApplicant(hired.applicant, [approved], 0, "Mark hired", { reason: "Retry" }, when), /closed/);
});
