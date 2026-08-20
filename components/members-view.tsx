"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Award, Mail, Phone, Search, UserPlus, Users } from "lucide-react";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, money, Notice, PageHeader, useNotice } from "@/components/ui";
import type { MemberRecord } from "@/lib/types";

export function MembersView() {
  const [members, setMembers] = useState<MemberRecord[]>([]); const [loading, setLoading] = useState(true); const [open, setOpen] = useState(false); const [search, setSearch] = useState(""); const [busy, setBusy] = useState(false); const { notice, show } = useNotice();
  async function load() { setLoading(true); try { setMembers(await apiRequest<MemberRecord[]>("/api/members")); } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load members.", "error"); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);
  const filtered = useMemo(() => members.filter((member) => `${member.name} ${member.phone} ${member.email} ${member.memberNo}`.toLowerCase().includes(search.toLowerCase())), [members, search]);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); const data = new FormData(event.currentTarget); try { await apiRequest("/api/members", { method: "POST", body: JSON.stringify({ name: data.get("name"), phone: data.get("phone"), email: data.get("email") }) }); show("Member added to the tea community."); setOpen(false); await load(); } catch (reason) { show(reason instanceof Error ? reason.message : "Could not add member.", "error"); } finally { setBusy(false); } }
  const totalSpend = members.reduce((sum, member) => sum + member.lifetimeSpend, 0);
  return <div className="page page-enter">
    <PageHeader eyebrow="COMMUNITY" title="Members" description="Know your regulars, reward each visit and keep a gentle service history." action={<AddButton onClick={() => setOpen(true)}>Add member</AddButton>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><Users /><span>Active members</span><strong>{members.length}</strong></article><article><Award /><span>Points in circulation</span><strong>{members.reduce((sum, member) => sum + member.points, 0).toLocaleString()}</strong></article><article><UserPlus /><span>Member lifetime sales</span><strong>{money.format(totalSpend)}</strong></article></section>
    <section className="panel resource-panel"><div className="resource-toolbar"><label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, phone or member number" /></label><span>{filtered.length} member{filtered.length === 1 ? "" : "s"}</span></div>
      {loading ? <LoadingPanel /> : filtered.length ? <div className="member-grid">{filtered.map((member) => <article className="member-card" key={member._id}><header><div className="member-avatar">{member.name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2)}</div><div><strong>{member.name}</strong><span>{member.memberNo}</span></div><b>{member.points} pts</b></header><div className="member-contact"><span><Phone size={14} />{member.phone}</span><span><Mail size={14} />{member.email || "No email"}</span></div><footer><span>Lifetime spend</span><strong>{money.format(member.lifetimeSpend)}</strong></footer></article>)}</div> : <EmptyState title="No members yet" detail="Add the first regular and their purchases will start earning points." action={<AddButton onClick={() => setOpen(true)}>Add member</AddButton>} />}
    </section>
    <Modal open={open} onClose={() => setOpen(false)} title="Add a member" kicker="TEA COMMUNITY"><form className="modal-form" onSubmit={create}><label className="field"><span>Full name</span><input name="name" required autoFocus /></label><div className="form-grid two"><label className="field"><span>Phone</span><input name="phone" required /></label><label className="field"><span>Email · optional</span><input name="email" type="email" /></label></div><footer><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Adding…" : "Add member"}</button></footer></form></Modal>
  </div>;
}
