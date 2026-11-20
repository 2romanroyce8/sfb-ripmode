import assert from "node:assert/strict";
import test from "node:test";
import { initialFailures, kinds, listFailures, needsReview, queueStatuses, updateFailure } from "./failures";

const item = (id: string) => initialFailures.find(row => row.id === id)!;

test("fixtures and triage ordering", () => {
  assert.ok(initialFailures.length >= 12);
  assert.equal(new Set(initialFailures.map(row => row.business)).size, 5);
  assert.deepEqual(new Set(initialFailures.map(row => row.kind)), new Set(kinds));
  assert.deepEqual(new Set(initialFailures.map(row => row.status)), new Set(queueStatuses));
  assert.deepEqual(listFailures(initialFailures, 0).slice(0, 4).map(row => row.id), ["lead", "review", "handoff", "task"]);
});

test("visibility respects separate business and finance grants", () => {
  assert.ok(!listFailures(initialFailures, 0).includes(item("payment")));
  assert.ok(listFailures(initialFailures, 3).includes(item("payment")));
  assert.ok(!listFailures(initialFailures, 1).some(row => row.business === "hq"));
  assert.ok(listFailures(initialFailures, 0, "prints").every(row => row.business === "prints"));
});

test("rejected events cannot replay and the fifth failure goes to review", () => {
  assert.throws(() => updateFailure(item("rejected"), 0, "Replay now", ""), /cannot be replayed/);
  const retry = updateFailure(item("retry"), 0, "Replay now", "");
  assert.equal(retry.event?.tries, 5);
  assert.equal(needsReview(retry), true);
  assert.equal(retry.history.length, 1);
  assert.throws(() => updateFailure(retry, 0, "Close event", ""), /completion note/);
  assert.equal(updateFailure(retry, 0, "Close event", "Reviewed").event?.result, "Closed");
});

test("handoff acceptance and reassignment preserve history", () => {
  const sent = updateFailure(item("handoff"), 0, "Escalate", "Please review", 5);
  assert.equal(sent.owner, 5);
  assert.equal(sent.handoffs[0].sender, 0);
  assert.throws(() => updateFailure(sent, 4, "Accept handoff", ""), /receiving owner/);
  const accepted = updateFailure(sent, 5, "Accept handoff", "");
  assert.ok(accepted.handoffs[0].acceptedAt);
  const assigned = updateFailure(accepted, 0, "Assign owner", "", 4);
  assert.deepEqual(assigned.history.slice(0, 2), accepted.history);
  assert.equal(assigned.history[2].previousOwner, 5);
  assert.equal(assigned.history[2].newOwner, 4);
});

test("blocked and done require notes, and an unowned item cannot be closed", () => {
  assert.throws(() => updateFailure(item("task"), 0, "Change status", "", undefined, "Blocked"), /blocked reason/);
  assert.throws(() => updateFailure(item("task"), 0, "Mark done", ""), /completion note/);
  assert.throws(() => updateFailure(item("lead"), 0, "Mark done", "Resolved"), /Assign an owner/);
  assert.equal(updateFailure(item("task"), 0, "Mark done", "Resolved").status, "Done");
});
