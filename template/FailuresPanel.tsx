"use client";

import { useState } from "react";
import { canSeeFailure, handoffDeadline, kinds, listFailures, needsReview, queueStatuses, threshold, updateFailure, type Failure, type FailureAction } from "./failures";
import { sampleBusinesses, sampleSeats } from "./executive-navigation";

const ownerName = (owner: number | null) => owner === null ? "Unowned" : sampleSeats[owner].label;
const dueTime = (row: Failure) => row.kind === "Stalled handoff" ? handoffDeadline : threshold;

export function FailureTable({ rows, onOpen }: { rows: Failure[]; onOpen: (id: string) => void }) {
  if (!rows.length) return <p role="status">No sample items match this view.</p>;
  return <div className="table-wrap"><table>
    <thead><tr>{["Client or applicant", "Business", "Kind", "Stage", "Next action", "Owner", "Due time", "Blocked reason", "Source", "Status", "Age"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>
      <td><button className="btn" type="button" onClick={() => onOpen(row.id)}>{row.subject}</button></td>
      <td>{sampleBusinesses.find(business => business.id === row.business)?.name}</td>
      <td>{row.kind}</td><td>{row.stage}</td><td>{row.next}</td>
      <td>{row.owner === null ? <strong>Unowned</strong> : ownerName(row.owner)}</td>
      <td>{dueTime(row)}{row.overdue && " · Sample overdue"}</td><td>{row.reason || "—"}</td><td>{row.source}</td>
      <td>{row.status}{needsReview(row) && <strong> · Needs review</strong>}{row.event?.result === "Rejected" && " · Rejected"}</td><td>{row.age}h</td>
    </tr>)}</tbody>
  </table></div>;
}

export function FailuresPanel({ rows, seat, workspace, selectedId, onOpen, onUpdate }: {
  rows: Failure[]; seat: number; workspace?: string; selectedId: string;
  onOpen: (id: string) => void; onUpdate: (row: Failure) => void;
}) {
  const [business, setBusiness] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [unowned, setUnowned] = useState(false);
  const visible = listFailures(rows, seat, workspace);
  const filtered = visible.filter(row =>
    (!business || row.business === business) && (!kind || row.kind === kind) &&
    (!status || row.status === status) && (!owner || String(row.owner) === owner) &&
    (!overdue || row.overdue) && (!unowned || row.owner === null));
  const selected = filtered.find(row => row.id === selectedId);
  return <>
    <section className="sop-start">
      <header><h2>Sample failed and stalled work</h2></header>
      <p>{handoffDeadline} · {threshold}</p>
      <div className="toolbar">
        <label className="field">Business<select value={business} onChange={event => setBusiness(event.target.value)}><option value="">All in current workspace</option>{sampleBusinesses.filter(item => sampleSeats[seat].grant.businesses.includes(item.id) && (!workspace || workspace === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field">Kind<select value={kind} onChange={event => setKind(event.target.value)}><option value="">All kinds</option>{kinds.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field">Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{queueStatuses.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field">Owner<select value={owner} onChange={event => setOwner(event.target.value)}><option value="">All owners</option>{sampleSeats.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}</select></label>
        <label><input type="checkbox" checked={overdue} onChange={event => setOverdue(event.target.checked)} /> Overdue only</label>
        <label><input type="checkbox" checked={unowned} onChange={event => setUnowned(event.target.checked)} /> Unowned only</label>
      </div>
      <FailureTable rows={filtered} onOpen={onOpen} />
    </section>
    {selected && <FailureDetail key={selected.id} row={selected} seat={seat} onUpdate={onUpdate} onClose={() => onOpen("")} />}
  </>;
}

function FailureDetail({ row, seat, onUpdate, onClose }: {
  row: Failure; seat: number; onUpdate: (row: Failure) => void; onClose: () => void;
}) {
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState<typeof queueStatuses[number]>();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const latest = row.handoffs.at(-1);
  const event = row.event;

  function perform(action: FailureAction) {
    try {
      onUpdate(updateFailure(row, seat, action, reason, owner ? Number(owner) : undefined, status));
      setReason("");
      setError("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Sample action failed.");
    }
  }

  return <section className="sop-start" aria-labelledby="failure-detail">
    <header><h2 id="failure-detail">{row.subject}</h2><button type="button" className="btn" onClick={onClose}>Close details</button></header>
    <dl>
      <dt>Business</dt><dd>{sampleBusinesses.find(business => business.id === row.business)?.name}</dd>
      <dt>Stage</dt><dd>{row.stage}</dd>
      <dt>Next action</dt><dd>{row.next}</dd>
      <dt>Owner</dt><dd>{ownerName(row.owner)}</dd>
      <dt>Due time</dt><dd>{dueTime(row)}</dd>
      <dt>Blocked reason</dt><dd>{row.reason || "—"}</dd>
      <dt>Source</dt><dd>{row.source}</dd>
      <dt>What failed or stalled</dt><dd>{row.kind} · {row.status} · Opened {row.age}h ago in this sample</dd>
    </dl>
    {event && <div className="card">
      <h3>Sample automation event</h3>
      <dl><dt>Event source</dt><dd>{row.source}</dd><dt>Affected record</dt><dd>{event.record}</dd>
        <dt>Result</dt><dd>{event.result}{needsReview(row) && " · Needs review"}</dd>
        <dt>Retry count</dt><dd>{event.tries}</dd><dt>Last error</dt><dd>{event.lastError}</dd>
        <dt>Next retry time</dt><dd>{event.result === "Failed" && !needsReview(row) ? "[Decision] Retry schedule" : "None scheduled"}</dd></dl>
      <p>Replay is simulated. It creates no duplicate invites, projects or attribution.</p>
      {event.result === "Failed" && row.status !== "Done" && <button className="btn" type="button" onClick={() => perform("Replay now")}>Replay now</button>}
      {event.result !== "Closed" && row.status !== "Done" && <button className="btn" type="button" onClick={() => perform("Close event")}>Close event with reason</button>}
    </div>}
    <h3>Sample handoff tasks</h3>
    {row.handoffs.length ? <ul>{row.handoffs.map((item, index) => <li key={index}>
      {ownerName(item.sender)} → {ownerName(item.receiver)} · {item.acceptedAt ? `Accepted ${new Date(item.acceptedAt).toLocaleString()}` : "Awaiting acceptance"} · {handoffDeadline}
    </li>)}</ul> : <p>No handoff tasks.</p>}
    {latest?.receiver === seat && row.owner === seat && !latest.acceptedAt && <button className="btn" type="button" onClick={() => perform("Accept handoff")}>Accept handoff</button>}
    <div className="toolbar">
      <label className="field">Named owner seat<select value={owner} onChange={event => setOwner(event.target.value)}><option value="">Choose a seat</option>{sampleSeats.map((item, index) => canSeeFailure(row, index) && <option key={item.label} value={index}>{item.label}</option>)}</select></label>
      <label className="field">New status<select value={status ?? ""} onChange={event => setStatus(event.target.value as typeof status)}><option value="">Choose a status</option>{queueStatuses.filter(item => item !== "Done").map(item => <option key={item}>{item}</option>)}</select></label>
      <label className="field">Reason or completion note<textarea value={reason} onChange={event => setReason(event.target.value)} /></label>
    </div>
    <div className="toolbar">{(["Assign owner", "Change status", "Add blocked reason", "Escalate", "Mark done"] as const).map(action => <button className="btn" type="button" key={action} onClick={() => perform(action)}>{action === "Escalate" ? "Escalate to a seat" : action}</button>)}</div>
    {error && <p role="alert">{error}</p>}
    <h3>Sample history</h3>
    {row.history.length ? <ol>{row.history.map((entry, index) => <li key={index}>
      <strong>{entry.action}</strong> · {ownerName(entry.actor)} · <time dateTime={entry.when}>{new Date(entry.when).toLocaleString()}</time>
      <br />{ownerName(entry.previousOwner)} → {ownerName(entry.newOwner)} · {entry.reason || "No reason entered"}
    </li>)}</ol> : <p>No sample actions recorded.</p>}
  </section>;
}
