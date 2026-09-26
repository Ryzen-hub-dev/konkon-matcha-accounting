import { ReactNode } from "react";
import { Leaf, Sparkles } from "lucide-react";

export function AuthShell({ children, businessName = "Kōn-Kōn Matchā", logoDataUrl = "" }: { children: ReactNode; businessName?: string; logoDataUrl?: string }) {
  return <main className="auth-shell">
    <section className="auth-visual" aria-hidden="true">
      <div className="auth-brand"><span className="brand-mark">{logoDataUrl ? <img src={logoDataUrl} alt={`${businessName} logo`} /> : <Leaf size={20} />}</span><strong>{businessName}</strong><small>ACCOUNTING ROOM</small></div>
      <div className="bowl-scene">
        <div className="steam steam-one" /><div className="steam steam-two" />
        <div className="matcha-bowl"><div className="matcha-surface"><i /><i /><i /></div></div>
        <div className="whisk"><span /><span /><span /><span /><span /><span /></div>
      </div>
      <blockquote><Sparkles size={17} /><p>Clear books.<br />Quiet mind.</p><footer>毎日の帳簿 · DAILY LEDGER</footer></blockquote>
      <div className="visual-ribbon">FRESHLY WHISKED NUMBERS · {businessName.toUpperCase()} ·</div>
    </section>
    <section className="auth-panel">{children}<footer>Protected workspace · Your country, currency and time zone</footer></section>
  </main>;
}
