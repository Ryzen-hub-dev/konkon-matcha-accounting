import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  MessageCircle,
  PackageSearch,
} from "lucide-react";
import styles from "./index.module.css";
import { CinematicIndexHero } from "@/components/cinematic-index-hero";

const author = process.env.NEXT_PUBLIC_PRODUCT_AUTHOR?.trim() || "Ryzen Hub Dev";
const client = process.env.NEXT_PUBLIC_PRODUCT_CLIENT?.trim() || "Kōn-Kōn Matchā";

export const metadata: Metadata = {
  title: "Connected commerce and accounting",
  description:
    "A professional operations platform connecting online orders, POS, inventory, fulfilment and accounting.",
  authors: [{ name: author, url: "https://github.com/Ryzen-hub-dev" }],
  creator: author,
  robots: { index: true, follow: true },
};

const capabilities = [
  {
    icon: PackageSearch,
    label: "Commerce",
    title: "Requests become controlled orders",
    copy: "Publish selected inventory, review customer details, agree pricing and manage controlled-goods checks before payment.",
  },
  {
    icon: MessageCircle,
    label: "Customer route",
    title: "One private conversation",
    copy: "Offers, protected files, payment instructions, invoices, receipts and delivery updates stay in one secure order link.",
  },
  {
    icon: BarChart3,
    label: "Finance",
    title: "Operations meet the ledger",
    copy: "POS, purchasing, receivables, journals, budgets and reports share controlled business evidence instead of duplicate truth.",
  },
] as const;

const route = [
  ["01", "Customer request", "Products, address and controlled-item answers"],
  ["02", "Team review", "Availability, quantity, discount and private chat"],
  ["03", "Verified documents", "Real invoice or completed POS receipt"],
  ["04", "Tracked fulfilment", "Manual updates or connected carrier reference"],
] as const;

export default function IndexPage() {
  return (
    <main className={styles.home}>
      <a className={styles.skip} href="#content">Skip to content</a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Ledger home">
          <span>KK</span><strong>Kōn-Kōn Ledger</strong>
        </Link>
        <nav aria-label="Main navigation">
          <a href="#platform">Platform</a><a href="#workflow">Order route</a><a href="#author">About</a>
        </nav>
        <div className={styles.headerActions}>
          <Link href="/shop">Online store</Link>
          <Link href="/login" className={styles.primaryLink}>Open workspace <ArrowRight size={15} /></Link>
        </div>
      </header>

      <CinematicIndexHero />

      <section className={styles.logoStrip} aria-label="Platform areas">
        <span>ONLINE ORDERS</span><i /><span>POINT OF SALE</span><i /><span>INVENTORY</span><i /><span>ACCOUNTING</span><i /><span>FULFILMENT</span>
      </section>

      <section className={styles.platform} id="platform">
        <header>
          <p className={styles.eyebrow}>ONE OPERATIONAL SYSTEM</p>
          <h2>Move work forward without breaking the trail.</h2>
          <p>Designed for daily operators and financial control, with clear boundaries between a request, a payment instruction and verified settlement.</p>
        </header>
        <div className={styles.capabilityGrid}>
          {capabilities.map(({ icon: Icon, label, title, copy }, index) => (
            <article key={title}>
              <div><span>0{index + 1}</span><Icon /></div><small>{label}</small><h3>{title}</h3><p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.workflow} id="workflow">
        <div className={styles.workflowIntro}>
          <p className={styles.eyebrow}>CONNECTED ORDER ROUTE</p>
          <h2>From “I’m interested” to “It’s delivered.”</h2>
          <p>Every customer receives one private link. Staff retain control over pricing, discounts, documents, sensitive-item steps and shipping updates.</p>
          <Link href="/shop">Start with the storefront <ArrowRight size={16} /></Link>
        </div>
        <div className={styles.routeList}>
          {route.map(([number, title, copy]) => (
            <article key={number}><span>{number}</span><div><h3>{title}</h3><p>{copy}</p></div><ArrowRight /></article>
          ))}
        </div>
      </section>

      <section className={styles.author} id="author">
        <div className={styles.authorMark}>RH</div>
        <div>
          <p className={styles.eyebrow}>PRODUCT & AUTHOR</p>
          <h2>Built for {client}.<br />Created by {author}.</h2>
          <p>This product is actively engineered as an accountable business system. Features are documented by their real operating boundary—not by promises a connector or authority has not confirmed.</p>
        </div>
        <a href="https://github.com/Ryzen-hub-dev/konkon-matcha-accounting" target="_blank" rel="noreferrer">View project source <ArrowRight size={16} /></a>
      </section>

      <footer className={styles.footer}>
        <Link href="/" className={styles.brand}><span>KK</span><strong>Kōn-Kōn Ledger</strong></Link>
        <p>Commerce, operations and accounting in one controlled workspace.</p>
        <span>© 2026 {author}</span>
      </footer>
    </main>
  );
}
