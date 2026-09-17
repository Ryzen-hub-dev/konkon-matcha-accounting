# Operational exception reviews

The **Exception reviews** workspace gives Owner, Admin and Manager users one queue for operational events that deserve a human check. Accountants can read the queue but cannot assign, resolve or reopen items. Cashiers cannot access it.

## Rules

The current rules are deterministic and visible in the UI:

- a manual POS discount is flagged at 10% of subtotal and becomes high priority at 25%;
- cumulative refunds are flagged at 50% of the original receipt and become high priority at 90%;
- a negative manual stock adjustment or stocktake loss is flagged when at least five units or 10% of the relevant stock is missing, with high priority at 20 units or 25%;
- any register cash-count variance is flagged, with high priority when the variance reaches 5% of expected cash;
- the fifth failed sign-in in the existing ten-minute throttle window creates a high-priority security review.

These thresholds are review signals, not proof of fraud, loss or staff misconduct. The queue never changes a sale, refund, stock balance or journal entry.

## Workflow

1. Open **Exception reviews** and filter active or historical items by category.
2. **Assign to me** records who is investigating. A note is optional at this stage.
3. Open the source record and compare it with the physical, payment or approval evidence.
4. **Resolve** with a required explanation, or leave it active for further work.
5. Reopen a resolved item with a new explanation if later evidence changes the conclusion.

Every action uses a record version so simultaneous reviewers cannot silently overwrite one another. Resolution and reopening events are appended to history and audit logged.

Register variances are special: use **Open source** and approve the shift from **Counters**. This keeps the register state, Z report and exception record synchronized in one transaction. The generic queue intentionally cannot bypass that approval.

## Privacy and rollout

Only qualifying events created after this feature is deployed enter the queue. Existing financial and audit records are not rewritten. Repeated-login reviews store a one-way derived incident identifier; raw usernames/email addresses, IP addresses and attempted passwords are not copied into the review record.
