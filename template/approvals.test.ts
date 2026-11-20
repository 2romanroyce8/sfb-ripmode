import assert from "node:assert/strict";
import test from "node:test";
import { act, initialApprovals, statuses, types, visibleApprovals } from "./approvals";

const row = (id: string) => initialApprovals.find(item => item.id === id)!;
const now = "2026-11-13T12:00:00.000Z";

test("sample data covers five businesses, every status and every type", () => {
  assert.equal(new Set(initialApprovals.map(item => item.business)).size, 5);
  assert.deepEqual(new Set(initialApprovals.map(item => item.status)), new Set(statuses));
  assert.deepEqual(new Set(initialApprovals.map(item => item.type)), new Set(types));
});

test("owned queue sorts overdue first and submitted queue is requester-scoped", () => {
  assert.equal(visibleApprovals(initialApprovals, 0, "owned")[0].id, "1");
  assert.ok(visibleApprovals(initialApprovals, 0, "owned").every(item => item.owner === 0));
  assert.ok(visibleApprovals(initialApprovals, 1, "submitted").every(item => item.requester === 1));
});

test("business and finance grants filter all scopes", () => {
  const restricted = { ...row("2"), owner: 1, requester: 1 };
  assert.equal(visibleApprovals([restricted], 1, "owned").length, 0);
  assert.equal(visibleApprovals([restricted], 1, "submitted").length, 0);
  for (const scope of ["owned", "submitted", "sent"] as const) {
    const payout = { ...row("4"), owner: 1, handoffs: [{ sender: 1, recipient: 3 }] };
    assert.equal(visibleApprovals([payout], 1, scope).length, 0);
  }
  assert.ok(visibleApprovals(initialApprovals, 3, "owned").some(item => item.type === "Refund"));
});

test("approval blocks the requester, payout preparer and any nonowner", () => {
  assert.throws(() => act(row("3"), 0, "Approve", "", undefined, now), /own request/);
  assert.throws(() => act(row("4"), 3, "Approve", "", undefined, now), /prepared/);
  assert.throws(() => act(row("1"), 5, "Approve", "", undefined, now), /assigned owner/);
});

test("written reasons are required and each action adds one history entry", () => {
  for (const action of ["Reject", "Request info"] as const) {
    assert.throws(() => act(row("1"), 0, action, " ", undefined, now), /written reason/);
    const changed = act(row("1"), 0, action, " Confirm scope ", undefined, now);
    assert.deepEqual(changed.history, [{ actor: 0, action, when: now, reason: "Confirm scope", previousOwner: 0, newOwner: 0 }]);
  }
  assert.equal(act(row("1"), 0, "Approve", "", undefined, now).status, "Approved");
});

test("escalation changes owner and sender can see acceptance", () => {
  assert.throws(() => act(row("2"), 0, "Escalate", "", 1, now), /eligible/);
  assert.throws(() => act(row("4"), 3, "Escalate", "", 0, now), /eligible/);
  const escalated = act(row("1"), 0, "Escalate", "", 4, now);
  assert.equal(escalated.owner, 4);
  assert.equal(escalated.history[0].newOwner, 4);
  assert.equal(visibleApprovals([escalated], 0, "owned").length, 0);
  assert.equal(visibleApprovals([escalated], 4, "owned").length, 1);
  assert.throws(() => act(escalated, 4, "Approve", "", undefined, now), /Accept the handoff/);
  const accepted = act(escalated, 4, "Accept handoff", "", undefined, now);
  assert.equal(visibleApprovals([accepted], 0, "sent")[0].handoffs[0].acceptedAt, now);
  assert.equal(accepted.history.length, 2);
});
