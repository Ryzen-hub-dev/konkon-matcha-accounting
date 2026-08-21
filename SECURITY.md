# Security policy

## Current controls

- Passwords use bcrypt with cost 12 and are never returned after creation/reset.
- Sessions are signed, HTTP-only, `SameSite=Lax`, HTTPS-only in production and expire after eight hours.
- A per-user session version revokes old tokens after password, role, disable, archive or ownership changes.
- Temporary passwords cannot access business APIs until the user changes the password.
- Mutations require both server-side RBAC and same-origin validation.
- Login attempts are throttled by hashed IP/identity key.
- Member identity numbers are not stored as plaintext; exact lookup uses a dedicated keyed HMAC and is rate-limited/audited.
- Mobile scanner bearer tokens are random, stored only as hashes, limited to 24 hours and revoked on system-mode rotation.
- Coupon and manual discount values are recomputed and authorized server-side inside the sale workflow.
- Financial deletion is implemented as archive/void/refund so audit references survive.
- Security response headers deny framing, MIME sniffing, foreign connections/forms/objects and unnecessary browser capabilities.

## Deployment responsibilities

1. Rotate every credential ever exposed outside the approved secret store.
2. Restrict the MongoDB Atlas database user to this database and the minimum required actions.
3. Configure Atlas network controls, continuous backup/PITR appropriate to the business, and test restores.
4. Use separate production, preview and development databases or collection prefixes.
5. Review Vercel and Atlas audit/runtime logs; Vercel Hobby runtime logs have limited retention.
6. Upgrade the hosting plan before commercial use and configure monitoring/alerting.
7. Run dependency, secret and application security scans in CI before each production deployment.
8. Commission an independent penetration test before storing real customer identity or financial data.

## Reporting a vulnerability

Do not open a public issue containing credentials, member data or an exploit. Contact the repository Owner privately with the affected route, reproduction steps and impact. Revoke compromised sessions/keys immediately and preserve audit evidence.

## Important limitation

No software can honestly guarantee “no vulnerabilities” or “anti-penetration.” These controls reduce known risk; they do not replace independent review, patch management, backups, least-privilege infrastructure and an incident-response process.
