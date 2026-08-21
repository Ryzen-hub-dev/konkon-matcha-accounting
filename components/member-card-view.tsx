"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer, Sprout } from "lucide-react";
import { Barcode39 } from "@/components/barcode-39";
import { apiRequest, LoadingPanel, Notice } from "@/components/ui";
import type { MemberRecord } from "@/lib/types";

export function MemberCardView({ memberId }: { memberId: string }) {
  const [member, setMember] = useState<MemberRecord | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest<MemberRecord>(`/api/members?id=${memberId}`).then(setMember).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load the member card.")); }, [memberId]);
  return <main className="member-card-page"><nav className="document-toolbar no-print"><Link className="button button-secondary" href="/members"><ArrowLeft size={16} />Members</Link><button className="button button-primary" onClick={() => window.print()} disabled={!member}><Printer size={16} />Print card</button></nav>{error ? <Notice message={error} tone="error" /> : !member ? <LoadingPanel label="Preparing the member card…" /> : <section className="printable-member-card"><header><span className="member-card-logo"><Sprout />KŌN-KŌN</span><small>MATCHĀ COMMUNITY</small></header><div className="member-card-name"><span>MEMBER</span><h1>{member.name}</h1><p>{member.memberNo}</p></div><div className="member-card-barcode"><Barcode39 value={member.memberCardCode} height={62} /><strong>{member.memberCardCode}</strong></div><footer><span>Scan at the counter to identify this member.</span><b>抹茶</b></footer></section>}</main>;
}
