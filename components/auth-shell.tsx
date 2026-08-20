import { ReactNode } from "react";
import { Leaf, Sparkles } from "lucide-react";

export function AuthShell({ children }: { children: ReactNode }) {
  return <main className="auth-shell">
    <section className="auth-visual" aria-hidden="true">
      <div className="auth-brand"><span className="brand-mark"><Leaf size={20} /></span><strong>KŌN-KŌN MATCHĀ</strong><small>ACCOUNTING ROOM</small></div>
      <div className="bowl-scene">
        <div className="steam steam-one" /><div className="steam steam-two" />
        <div className="matcha-bowl"><div className="matcha-surface"><i /><i /><i /></div></div>
        <div className="whisk"><span /><span /><span /><span /><span /><span /></div>
      </div>
      <blockquote><Sparkles size={17} /><p>Clear books.<br />Quiet mind.</p><footer>毎日の帳簿 · DAILY LEDGER</footer></blockquote>
      <div className="visual-ribbon">FRESHLY WHISKED NUMBERS · SINGAPORE ·</div>
    </section>
    <section className="auth-panel">{children}<footer>Protected workspace · SGD ledger · Singapore time</footer></section>
  </main>;
}
