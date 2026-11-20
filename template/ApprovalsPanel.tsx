"use client";

import { useState } from "react";
import { act, blockedReason, deadline, hasScope, rules, statuses, types, visibleApprovals, type Action, type Approval, type Scope } from "./approvals";
import { sampleBusinesses, sampleSeats } from "./executive-navigation";

const seatName = (index: number) => sampleSeats[index].label;
const businessName = (id: string) => sampleBusinesses.find(business => business.id === id)?.name;
const amount = (row: Approval) => row.amount === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(row.amount);
const actions: Action[] = ["Approve", "Reject", "Request info", "Escalate"];

export function Approvals({ rows, seat, workspace, onUpdate }: {
  rows: Approval[]; seat: number; workspace?: string; onUpdate: (row: Approval) => void;
}) {
  const [scope, setScope] = useState<Scope>("owned");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [business, setBusiness] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const visible = visibleApprovals(rows, seat, scope).filter(row =>
    (!workspace || row.business === workspace) && (!business || row.business === business) &&
    (!status || row.status === status) && (!type || row.type === type));
  const selected = visible.find(row => row.id === selectedId);
  const grant = sampleSeats[seat].grant;

  return (
    <>
      <section className="sop-start" aria-labelledby="approval-list-title">
        <header><h2 id="approval-list-title">Sample approvals</h2></header>
        <p>Preview decisions for {seatName(seat)}. Changes last until the page reloads.</p>
        <div className="actions">
          <label className="field">Requests<select value={scope} onChange={event => setScope(event.target.value as Scope)}>
            <option value="owned">Owned by my seat</option><option value="submitted">Submitted by me</option><option value="sent">Escalated by me</option>
          </select></label>
          <label className="field">Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="field">Type<select value={type} onChange={event => setType(event.target.value)}><option value="">All types</option>{types.filter(value => grant.finance || (value !== "Payout" && value !== "Refund")).map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="field">Business<select value={business} onChange={event => setBusiness(event.target.value)}><option value="">All in current workspace</option>{sampleBusinesses.filter(item => grant.businesses.includes(item.id) && (!workspace || workspace === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {visible.length ? (
          <div className="table-wrap"><table>
            <thead><tr>{["Title", "Type", "Business", "Requested by", "Owner seat", "Amount", "Due time", "Status"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
            <tbody>{visible.map(row => <tr key={row.id}>
              <td><button className="btn" type="button" aria-expanded={selected?.id === row.id} onClick={() => setSelectedId(selected?.id === row.id ? "" : row.id)}>{row.title}</button></td>
              <td>{row.type}</td><td>{businessName(row.business)}</td><td>{seatName(row.requester)}</td><td>{seatName(row.owner)}</td><td>{amount(row)}</td>
              <td>{deadline}{row.overdue && <small> · Sample overdue</small>}</td><td>{row.status}</td>
            </tr>)}</tbody>
          </table></div>
        ) : <p role="status">No sample approvals match these filters.</p>}
      </section>
      {selected && <ApprovalDetail key={selected.id} row={selected} seat={seat} onClose={() => setSelectedId("")} onUpdate={onUpdate} />}
    </>
  );
}

function ApprovalDetail({ row, seat, onClose, onUpdate }: {
  row: Approval; seat: number; onClose: () => void; onUpdate: (row: Approval) => void;
}) {
  const [reason, setReason] = useState("");
  const [receiver, setReceiver] = useState("");
  const [error, setError] = useState("");
  const handoffs = row.handoffs.filter(item => item.sender === seat || item.recipient === seat || row.owner === seat);
  const blockedApproval = blockedReason(row, seat, "Approve");

  function perform(action: Action) {
    try {
      onUpdate(act(row, seat, action, reason, receiver === "" ? undefined : Number(receiver), new Date().toISOString()));
      setReason("");
      setReceiver("");
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "The sample action failed.");
    }
  }

  return (
    <section className="sop-start" aria-labelledby="approval-detail-title">
      <header><h2 id="approval-detail-title">{row.title}</h2><button className="btn" type="button" onClick={onClose}>Close details</button></header>
      <p>{row.type} · {businessName(row.business)} · {row.status}</p>
      <p>Requested by {seatName(row.requester)} · Owned by {seatName(row.owner)} · Amount {amount(row)}</p>
      {row.preparer !== undefined && <p>Prepared by {seatName(row.preparer)}</p>}
      <h3>Supporting notes</h3><p>{row.notes}</p>
      <h3>Sample rule</h3><p>{rules[row.type]}</p>
      <p>Due time and escalation deadline · {deadline}</p>
      {handoffs.length > 0 && <div><h3>Sample handoff tasks</h3><ul>{handoffs.map((item, index) => <li key={index}>{seatName(item.sender)} → {seatName(item.recipient)} · {item.acceptedAt ? `Accepted ${new Date(item.acceptedAt).toLocaleString()}` : "Awaiting acceptance"}</li>)}</ul></div>}
      {blockedApproval && <p>{blockedApproval}</p>}
      {!blockedReason(row, seat, "Accept handoff") && <button className="btn" type="button" onClick={() => perform("Accept handoff")}>Accept handoff</button>}
      {actions.some(action => !blockedReason(row, seat, action)) && (
        <>
          <label className="field">Reason (required to reject or request info)<textarea value={reason} onChange={event => setReason(event.target.value)} /></label>
          <label className="field">Receiving seat<select value={receiver} onChange={event => setReceiver(event.target.value)}>
            <option value="">Choose a seat</option>{sampleSeats.map((item, index) => index !== seat && hasScope(row, index) ? <option key={item.label} value={index}>{item.label}</option> : null)}
          </select></label>
        </>
      )}
      <div className="actions">{actions.map(action => <button className="btn" key={action} type="button" disabled={Boolean(blockedReason(row, seat, action))} onClick={() => perform(action)}>{action === "Escalate" ? "Escalate to another seat" : action}</button>)}</div>
      {error && <p role="alert">{error}</p>}
      <h3>Sample history</h3>
      {row.history.length ? <ol>{row.history.map((entry, index) => <li key={index}>
        <strong>{entry.action}</strong> · {seatName(entry.actor)} · <time dateTime={entry.when}>{new Date(entry.when).toLocaleString()}</time>
        <br />{seatName(entry.previousOwner)} → {seatName(entry.newOwner)} · {entry.reason || "No reason entered"}
      </li>)}</ol> : <p>No sample actions recorded.</p>}
    </section>
  );
}
