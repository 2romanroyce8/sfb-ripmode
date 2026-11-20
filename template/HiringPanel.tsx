"use client";

import { useState } from "react";
import type { Approval } from "./approvals";
import { sampleBusinesses, sampleSeats } from "./executive-navigation";
import { approvalLimit, decisionSeats, hiringApprovals, hiringCounts, hiringDue, hiringRoles, hiringStages, listApplicants, type Applicant, type HiringAction, type PaidTraining } from "./hiring";

const sampleOwnerNames = ["Robin Park", "Cameron Gray", "Devon West", "Jules Stone", "Reese Ford", "Shawn Dale"];
const ownerName = (owner: number | null) => owner === null ? "Unowned" : sampleOwnerNames[owner];

export function HiringPanel({ rows, training, approvals, seat, workspace, onAction }: {
  rows: Applicant[]; training: PaidTraining[]; approvals: Approval[]; seat: number; workspace?: string;
  onAction: (id: string, action: HiringAction, input: Parameters<typeof import("./hiring").updateApplicant>[4]) => void;
}) {
  const [business, setBusiness] = useState("");
  const [role, setRole] = useState("");
  const [stage, setStage] = useState("");
  const [owner, setOwner] = useState("");
  const [unowned, setUnowned] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const businesses = sampleBusinesses.filter(item => sampleSeats[seat].grant.businesses.includes(item.id) && (!workspace || workspace === item.id));
  const visible = listApplicants(rows, seat, workspace);
  const filtered = visible.filter(row => (!business || row.workspaceId === business) && (!role || row.role === role) &&
    (!stage || row.stage === stage) && (!owner || String(row.owner) === owner) && (!unowned || row.owner === null) && (!overdue || row.overdue));
  const selected = filtered.find(row => row.id === selectedId);

  return <>
    <section className="sop-start">
      <header><h2>Sample hiring pipeline</h2></header>
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Business</th>{hiringStages.map(item => <th scope="col" key={item}>{item}</th>)}<th scope="col">Total</th></tr></thead>
        <tbody>{[...businesses, { id: "", name: "All businesses in this view" }].map(item => {
          const counts = hiringCounts(visible, item.id);
          return <tr key={item.id}><th scope="row">{item.name}</th>{counts.stages.map((count, index) => <td key={hiringStages[index]}>{count}</td>)}<td>{counts.total}</td></tr>;
        })}</tbody>
      </table></div>
    </section>
    <section className="sop-start">
      <header><h2>Sample applicants</h2></header>
      <div className="toolbar">
        <label className="field">Business<select value={business} onChange={event => setBusiness(event.target.value)}><option value="">All businesses in this view</option>{businesses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field">Role<select value={role} onChange={event => setRole(event.target.value)}><option value="">All roles</option>{hiringRoles.map(item => <option key={item} value={item}>{item}{item === "Appointment Setter" && " · [Decision] still a role?"}</option>)}</select></label>
        <label className="field">Stage<select value={stage} onChange={event => setStage(event.target.value)}><option value="">All stages</option>{hiringStages.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field">Owner<select value={owner} onChange={event => setOwner(event.target.value)}><option value="">All owners</option>{sampleSeats.map((item, index) => <option key={item.label} value={index}>{ownerName(index)}</option>)}</select></label>
        <label><input type="checkbox" checked={unowned} onChange={event => setUnowned(event.target.checked)} /> Unowned only</label>
        <label><input type="checkbox" checked={overdue} onChange={event => setOverdue(event.target.checked)} /> Overdue only</label>
      </div>
      {filtered.length ? <div className="table-wrap"><table>
        <thead><tr>{["Applicant", "Business", "Role applied for", "Stage", "Next action", "Owner", "Due time", "Blocked reason", "Source", "Status", "Days in stage"].map(item => <th scope="col" key={item}>{item}</th>)}</tr></thead>
        <tbody>{filtered.map(row => <tr key={row.id}>
          <td><button type="button" className="btn" aria-expanded={selected?.id === row.id} onClick={() => setSelectedId(row.id)}>{row.name}</button></td>
          <td>{businesses.find(item => item.id === row.workspaceId)?.name}</td>
          <td>{row.role}{row.role === "Appointment Setter" && " · [Decision] still a role?"}</td>
          <td>{row.stage}</td><td>{row.next}</td><td>{row.owner === null ? <strong>Unowned</strong> : ownerName(row.owner)}</td>
          <td>{row.status === "Done" ? "—" : hiringDue}{row.overdue && " · Sample overdue"}</td><td>{row.blockedReason || "—"}</td>
          <td>{row.source}</td><td>{row.status}</td><td>{row.days}</td>
        </tr>)}</tbody>
      </table></div> : <p role="status">No sample applicants match these filters.</p>}
    </section>
    {selected && <ApplicantDetail key={selected.id} row={selected} training={training.find(item => item.applicantId === selected.id && item.workspaceId === selected.workspaceId)}
      approval={hiringApprovals(selected, approvals).at(-1)} seat={seat} onAction={onAction} onClose={() => setSelectedId("")} />}
  </>;
}

const actions: HiringAction[] = ["Assign owner", "Change stage", "Add blocked reason", "Request decision", "Mark hired", "Mark declined"];

function ApplicantDetail({ row, training, approval, seat, onAction, onClose }: {
  row: Applicant; training?: PaidTraining; approval?: Approval; seat: number;
  onAction: Parameters<typeof HiringPanel>[0]["onAction"]; onClose: () => void;
}) {
  const [action, setAction] = useState<HiringAction>("Assign owner");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const required = ["Add blocked reason", "Mark hired", "Mark declined"].includes(action);
  const owners = sampleSeats.flatMap((item, index) => listApplicants([row], index).length ? [{ index, label: `${ownerName(index)} · ${item.label}` }] : []);

  return <section className="sop-start" aria-labelledby="applicant-details">
    <header><h2 id="applicant-details">Sample applicant · {row.name}</h2><button type="button" className="btn" onClick={onClose}>Close details</button></header>
    <dl>
      <dt>Source</dt><dd>{row.source}</dd>
      <dt>Application answers</dt><dd>{row.answers}</dd>
      <dt>Interview notes</dt><dd>{row.interviewNotes ?? "No sample interview notes yet."}</dd>
      <dt>Pay terms and worker classification</dt><dd>[Decision]</dd>
      <dt>Hiring approval</dt><dd>{approvalLimit}{approval && ` · ${approval.status} in Approvals`}</dd>
    </dl>
    <div className="card"><h3>Scorecard</h3><p>[Decision] offer rubric</p><p>Scores are pending the rubric.</p></div>
    {training && <div className="card"><h3>Linked Paid Training record</h3><p>{training.status}</p><p>{training.id}</p></div>}
    {row.status !== "Done" && <form onSubmit={event => {
      event.preventDefault();
      try {
        onAction(row.id, action, {
          reason, selectedOwner: target ? Number(target) : undefined, receiver: target ? Number(target) : undefined,
          stage: hiringStages.find(item => item === target),
          escalation: confirmed ? (action === "Request decision" ? "above" : "within") : undefined,
        });
        setReason(""); setConfirmed(false); setError(""); setFeedback(`Sample action saved · ${action}`);
      } catch (problem) {
        setFeedback(""); setError(problem instanceof Error ? problem.message : "Sample action failed.");
      }
    }}>
      <div className="toolbar">
        <label className="field">Action<select value={action} onChange={event => {
          setAction(actions.find(item => item === event.target.value) ?? "Assign owner");
          setTarget(""); setConfirmed(false); setFeedback(""); setError("");
        }}>{actions.map(item => <option key={item}>{item}</option>)}</select></label>
        {action === "Assign owner" && <label className="field">New owner<select required value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose an owner</option>{owners.map(item => <option key={item.index} value={item.index}>{item.label}</option>)}</select></label>}
        {action === "Change stage" && <label className="field">New stage<select required value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose a stage</option>{hiringStages.slice(0, -2).map(item => <option key={item}>{item}</option>)}</select></label>}
        {action === "Request decision" && <label className="field">Receiving seat<select required value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose another executive</option>{decisionSeats(row, seat).map(index => <option key={index} value={index}>{sampleSeats[index].label}</option>)}</select></label>}
      </div>
      {(action === "Request decision" || (action === "Mark hired" && !approval)) && <label className="field"><span><input required type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> This sample decision is {action === "Request decision" ? "above" : "within"} the hiring manager’s limit.</span></label>}
      <label className="field">Reason or note{required ? " (required)" : " (optional)"}<textarea required={required} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button type="submit" className="btn">{action}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {feedback && <p role="status">{feedback}</p>}
    <h3>Sample history</h3>
    {row.history.length ? <div className="table-wrap"><table>
      <thead><tr>{["Who", "Action", "When", "Reason", "Previous owner", "New owner"].map(item => <th key={item} scope="col">{item}</th>)}</tr></thead>
      <tbody>{row.history.map((entry, index) => <tr key={index}><td>{ownerName(entry.actor)}</td><td>{entry.action}</td><td>{new Date(entry.when).toLocaleString()}</td><td>{entry.reason || "—"}</td><td>{ownerName(entry.previousOwner)}</td><td>{ownerName(entry.newOwner)}</td></tr>)}</tbody>
    </table></div> : <p>No sample actions yet.</p>}
  </section>;
}
