# Kōn-Kōn Matchā Ledger

A Vercel-ready accounting, member and point-of-sale workspace for Kōn-Kōn Matchā Singapore. The current web application lives alongside the preserved legacy WPF/PHP prototype.

## What is included

- Matcha-branded responsive dashboard with reduced-motion support.
- Secure first-run Owner setup and password login.
- Server-enforced roles: Owner, Admin, Manager, Accountant and Cashier.
- Owner/Admin account generation, enable/disable controls and audit history.
- Member CRM with points and lifetime-spend tracking.
- POS cart, Cash/Card/PayNow tenders, discounts, receipt printing and server-calculated totals.
- Transactional stock deduction, stock movements and low-stock indicators.
- Automatic double-entry posting for POS sales and paid invoices.
- Manual balanced journal entries and a seeded chart of accounts.
- Draft/sent/paid/void invoices with workspace tax calculation.
- Sales, margin, tender, inventory-value and receivable reports.
- MongoDB connection pooling sized for serverless workloads.

## Local development

1. Install Node.js 20.9 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and supply new credentials.
4. Run `npm run dev`.
5. Open `http://localhost:3000/setup` once to create the Owner.

Never commit `.env.local`. Credentials previously pasted into chat or logs must be rotated before use.

## Quality checks

```text
npm run typecheck
npm test
npm run build
```

## Deployment

See [docs/deployment-vercel.md](docs/deployment-vercel.md). The code is resource-conscious enough for Vercel Hobby during personal testing, but Vercel's Hobby terms limit it to non-commercial use. A real Kōn-Kōn business deployment should use Vercel Pro.

## Legacy prototype

The `MatchaAccounting/`, `api/`, `deploy/` and `sql/` folders are the original WPF/PHP prototype and have not been deleted. The production web application uses the root Next.js project, `app/`, `components/` and `lib/`.
