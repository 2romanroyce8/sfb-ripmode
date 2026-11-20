"use client";

import { useEffect, useState } from "react";
import { Bell, ChevronRight, LockKeyhole, LogOut, Menu, Moon, Sun, X } from "lucide-react";
import { Brand } from "../staff/OrbMark";
import { AccountMenu } from "../staff/AccountMenu";
import { branding } from "../staff/branding";
import type { SessionUser } from "../staff/types";
import { canView, executiveTabs, sampleBusinesses, sampleSeats, type ExecutiveTab } from "./executive-navigation";

import { Approvals } from "./ApprovalsPanel";
import { hasScope, initialApprovals, visibleApprovals } from "./approvals";

import { FailureTable, FailuresPanel } from "./FailuresPanel";
import { initialFailures, listFailures } from "./failures";
import { HiringPanel } from "./HiringPanel";
import { hiringCounts, initialApplicants, initialTraining, listApplicants, updateApplicant } from "./hiring";

const user: SessionUser = { id: "sample", name: "Sample executive", email: "sample@example.invalid", role: "staff", assignedBusinessIds: [] };

export default function ExecutivePage() {
  const [approvals, setApprovals] = useState(initialApprovals);
  const [applicants, setApplicants] = useState(initialApplicants);
  const [training, setTraining] = useState(initialTraining);
  const [failures, setFailures] = useState(initialFailures);
  const [failureId, setFailureId] = useState("");
  const [view, setView] = useState<ExecutiveTab>("overview");
  const [seatIndex, setSeatIndex] = useState(0);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const seat = sampleSeats[seatIndex];
  const assigned: readonly string[] = seat.grant.businesses;
  const businesses = sampleBusinesses.filter(business => assigned.includes(business.id));
  const workspace = businesses.find(business => business.id === workspaceId);
  const views = executiveTabs.filter(tab => tab.key === "finance" || canView(seat.grant, tab.key));
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [appearance, setAppearance] = useState<"dark" | "light">("dark");
  useEffect(() => {
    if (localStorage.getItem("sfb-dashboard-appearance") === "light") setAppearance("light");
  }, []);

  function toggleAppearance() {
    const next = appearance === "dark" ? "light" : "dark";
    setAppearance(next);
    localStorage.setItem("sfb-dashboard-appearance", next);
  }

  function onNavigate(next: ExecutiveTab) {
    setView(next);
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }

  const financeGranted = canView(seat.grant, "finance");
  const scopedBusinesses = workspace ? [workspace] : businesses;
  const visibleFailures = listFailures(failures, seatIndex, workspace?.id);
  const openApprovals = approvals.filter(row => !["Approved", "Rejected", "Expired"].includes(row.status));
  const decisions = visibleApprovals(openApprovals, seatIndex, "owned").filter(row => !workspace || row.business === workspace.id);
  const visibleApplicants = listApplicants(applicants, seatIndex, workspace?.id);
  const showHiring = canView(seat.grant, "hiring");
  const title = views.find(item => item.key === view)?.label;
  return (
    <div className={`shell ${menuOpen ? "shell--menu-open" : ""}`} data-appearance={appearance}>
      <a className="skip-link" href="#team-main">Skip to main content</a>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-badge"><span className="workspace-badge-icon">{branding.company[0]}</span><div><b>{branding.company}</b><small>{workspace?.name ?? "All assigned sample businesses"}</small></div><ChevronRight size={15} /></div>
        <p className="nav-label" id="team-nav-label">WORKSPACE</p>
        <nav className="nav" aria-labelledby="team-nav-label">
          {views.map(({key,label,icon:Icon}) => <button type="button" className="nav-link" key={key} aria-current={view === key ? "page" : undefined} onClick={() => onNavigate(key)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{key === "finance" && !canView(seat.grant, key) && <LockKeyhole size={14} aria-label="Locked" />}{view === key && <span className="nav-active-dot" />}</button>)}
        </nav>
        <div className="sidebar-foot">
          <div className="scope-card"><span className="scope-dot" /><div><b>{workspace ? 1 : businesses.length} assigned</b><small>Sample workspace</small></div></div>
          <div className="sidebar-profile"><span className="avatar">SE</span><div><b>{user.name}</b><small>{seat.label}</small></div><button className="icon-button" type="button" aria-label="Sign out" disabled><LogOut size={18} /></button></div>
        </div>
      </aside>
      {menuOpen && <button type="button" className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={21} /> : <Menu size={21} />}</button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><b>{title}</b></div>
          <div className="topbar-account">
            <button className="icon-button appearance-toggle" aria-label={appearance === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleAppearance}>{appearance === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
            <div className="account-menu"><button className="icon-button" aria-label="Notifications" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={18} /></button>{notifications && <div className="account-popover"><div className="account-popover-profile">No notifications yet.</div></div>}</div>
            <span className="role-chip">{seat.label}</span>
            <AccountMenu allowAdministration={false} user={user} businesses={businesses} workspaceId={workspace?.id} onWorkspace={setWorkspaceId} onAction={() => onNavigate("settings")} onLogout={() => onNavigate("overview")} />
          </div>
        </header>
        <main className="content" id="team-main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <span className="eyebrow">SAMPLE ROLE PREVIEW</span>
              <h1>{title}</h1>
            </div>
            <label>
              Preview executive seat
              <select value={seatIndex} onChange={event => {
                setSeatIndex(Number(event.target.value));
                setWorkspaceId(undefined);
                setFailureId("");
                const nextSeat = sampleSeats[Number(event.target.value)];
                if (!canView(nextSeat.grant, view) && view !== "finance") onNavigate("overview");
              }}>
                {sampleSeats.map((sample, index) => <option key={sample.label} value={index}>{sample.label}</option>)}
              </select>
            </label>
          </div>
          {view === "approvals" && canView(seat.grant, view) && <Approvals key={`${seatIndex}:${workspace?.id ?? ""}`} rows={approvals} seat={seatIndex} workspace={workspace?.id} onUpdate={row => setApprovals(current => current.map(item => item.id === row.id ? row : item))} />}
          {view === "failures" && canView(seat.grant, view) && <FailuresPanel
            key={`${seatIndex}:${workspace?.id ?? ""}`} rows={failures} seat={seatIndex} workspace={workspace?.id}
            selectedId={failureId} onOpen={setFailureId}
            onUpdate={row => setFailures(current => current.map(item => item.id === row.id ? row : item))}
          />}
          {view === "hiring" && showHiring && <HiringPanel
            key={`${seatIndex}:${workspace?.id ?? ""}`} rows={applicants} training={training} approvals={approvals}
            seat={seatIndex} workspace={workspace?.id} onAction={(id, action, input) => {
              const row = visibleApplicants.find(item => item.id === id);
              if (!row) throw new Error("This applicant is outside your current workspace.");
              const result = updateApplicant(row, approvals, seatIndex, action, input, new Date().toISOString());
              setApplicants(current => current.map(item => item.id === id ? result.applicant : item));
              const { approval, training: record } = result;
              if (approval) setApprovals(current => [...current, approval]);
              if (record) setTraining(current => current.some(item => item.id === record.id) ? current : [...current, record]);
            }}
          />}
          {view === "overview" && canView(seat.grant, "approvals") && <section className="sop-start">
            <header><h2>Sample decisions waiting on you</h2><button className="btn" type="button" onClick={() => onNavigate("approvals")}>Open Approvals</button></header>
            {decisions.length ? <div className="table-wrap"><table>
              <thead><tr><th>Decision</th><th>Business</th><th>Owner</th><th>Status</th></tr></thead>
              <tbody>{decisions.map(row => <tr key={row.id}><td>{row.title}</td><td>{sampleBusinesses.find(business => business.id === row.business)?.name}</td><td>{seat.label}</td><td>{row.status}</td></tr>)}</tbody>
            </table></div> : <p>No sample decisions waiting on this seat.</p>}
          </section>}
          {view === "overview" && canView(seat.grant, "failures") && <section className="sop-start">
            <header><h2>Sample failed and stalled work</h2><button className="btn" type="button" onClick={() => { setFailureId(""); onNavigate("failures"); }}>Open Failed and Stalled</button></header>
            <FailureTable rows={visibleFailures} onOpen={id => { setFailureId(id); onNavigate("failures"); }} />
          </section>}
          {(view === "overview" || view === "businesses") && canView(seat.grant, "businesses") && <section className="sop-start">
            <header><h2>Sample business scorecard</h2></header>
            <div className="table-wrap"><table>
              <thead><tr><th>Business</th><th>Busiest stage in open work</th><th>Overdue handoffs</th><th>Open approvals</th>{showHiring && <th>Sample applicants</th>}</tr></thead>
              <tbody>{scopedBusinesses.map(business => {
                const rows = visibleFailures.filter(row => row.business === business.id && row.status !== "Done");
                const stages = new Map<string, number>();
                for (const row of rows) stages.set(row.stage, (stages.get(row.stage) ?? 0) + 1);
                const busiest = Math.max(0, ...stages.values());
                const busiestStages = [...stages].filter(([, count]) => count === busiest).map(([stage]) => stage);
                return <tr key={business.id}><td>{business.name}</td><td>{busiestStages.join(", ") || "No open work"}</td><td>{rows.filter(row => row.overdue && row.kind === "Stalled handoff").length}</td><td>{openApprovals.filter(row => row.business === business.id && hasScope(row, seatIndex)).length}</td>{showHiring && <td>{hiringCounts(visibleApplicants, business.id).total}</td>}</tr>;
              })}</tbody>
            </table></div>
          </section>}
          {(view === "businesses" || view === "finance") && <section className="sop-start" aria-labelledby="sample-money-title">
            <header><h2 id="sample-money-title">Sample money activity</h2></header>
            {financeGranted ? <div className="table-wrap"><table>
              <thead><tr><th>Business</th><th>Open payouts</th><th>Open refunds</th><th>Open payment issues</th></tr></thead>
              <tbody>{scopedBusinesses.map(business => {
                const requests = openApprovals.filter(row => row.business === business.id && hasScope(row, seatIndex));
                const paymentIssues = visibleFailures.filter(row => row.business === business.id && row.payment && row.status !== "Done");
                return <tr key={business.id}><td>{business.name}</td>
                  <td>{requests.filter(row => row.type === "Payout").length}</td>
                  <td>{requests.filter(row => row.type === "Refund").length}</td>
                  <td>{paymentIssues.length}</td>
                </tr>;
              })}</tbody>
            </table></div> : <p>Finance is locked. Explicit finance access is required.</p>}
          </section>}
          {view === "overview" && (
            <section className="sop-start" aria-labelledby="executive-preview-title">
              <header><h2 id="executive-preview-title">Sample access</h2></header>
              <p>Role preview uses sample data and does not change real access.</p>
              <p>Assigned businesses: {businesses.map(business => business.name).join(", ")}</p>
              {financeGranted ? <p>Sample finance access granted.</p> : <p>Finance is locked. Explicit finance access is required.</p>}
              <ul>
                <li>Approval limits [Decision]</li>
                <li>Handoff deadlines [Decision]</li>
                <li>President and executive assignments [Decision]</li>
              </ul>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
