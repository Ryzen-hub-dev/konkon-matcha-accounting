# Register shifts and daily close

## Lifecycle

Each active counter can have at most one `OPEN` shift. The opening operator records the physical starting float for every configured settlement currency. While open, new sales and refunds snapshot the shift, counter and location.

Closing is a blind count. The operator enters physical cash without seeing the calculated expectation. The server then creates the shift summary:

- gross and net sales in the ledger currency;
- refunds in the ledger currency;
- sales/refunds/net by payment method;
- opening float, cash sales, cash refunds, expected cash, counted cash and variance by physical currency.

A balanced shift becomes `CLOSED`. A Cashier variance becomes `PENDING_REVIEW` and blocks the counter from reopening. A Manager, Admin or Owner must record an explanation to approve and lock the Z report. Review never edits the counted values.

## X and Z reports

- X report: a live, non-final summary available to staff with receipt-management authority while the shift is open.
- Z report: the immutable summary created by closing. It retains the operator, closer, optional reviewer, timestamps, notes and multi-currency cash results.

## Permissions

- Staff with `pos.sell` can open a shift and close a shift they opened.
- Manager, Admin and Owner roles can close another operator's shift and review a variance through their existing `receipts.manage` permission.
- Counter Manager bindings continue to apply: a bound counter rejects a different Manager, while Owner and Admin retain control.

## Safe rollout

Existing counters remain in legacy mode until their first shift opens. After that first opening, the counter is permanently controlled: sales and refunds require an open shift. This avoids locking an existing deployment immediately after the software upgrade while preventing gaps after operations adopt daily close.

## Concurrency and retries

Opening and closing requests carry unique request IDs. Repeating a request returns the existing result instead of creating another shift or close. Sales, refunds and closing all update the open shift inside their MongoDB transactions, so a checkout/close race cannot silently omit activity from the Z report.
