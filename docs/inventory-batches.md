# Batch and expiry control

Batch tracking is enabled one product at a time from **Batch & expiry**. A product must already use location inventory. This is a permanent operational control: once enabled, every quantity change must identify the affected lot.

## Activation

- Opening lots must reconcile exactly to each location balance and to the product's company total.
- More than one opening lot may be supplied for a location through the API; the workspace form provides one opening lot per stocked location for a fast migration.
- Activation is blocked while the product is part of an in-transit transfer.
- Empty products can be activated without an opening lot and begin tracking with their next receipt.
- A per-product warning window classifies live quantities as healthy, expiring or expired.

## Inventory chain

- Purchase receiving requires the supplier lot number and expiry date for tracked products. The goods receipt, supplier, location and lot are snapshotted together.
- POS consumes unexpired stock using first-expiry-first-out (FEFO). Expired quantities remain in accounting inventory but are excluded from the POS catalogue and cannot be sold.
- The receipt stores and displays the exact lot allocations used by the sale.
- Depleted lots remain searchable. **Trace** follows a product and normalized lot across goods receipts, sales, refunds, adjustments, disposals and transfers without exposing customer identity.
- Refunds restore the original sale allocation. A sale made before tracking was enabled is not assigned an invented lot; its return must first be identified through a controlled batch record.
- Transfer dispatch reserves exact source lots. Receipt recreates those lots at the destination; cancellation restores them to the source. Company stock and the general ledger do not change.
- Batch counts update the batch, location balance and company total in one transaction. Material losses still feed the exception-review rules.
- The controlled **Add discovered batch** action is available for genuine physical stock missing from the ledger. Normal supplier deliveries must use Purchasing.
- The freshness queue uses the last 30 days of net sold units at each location. It applies that daily rate to lots in FEFO order, estimates units that may remain at expiry, and may suggest a higher-demand destination. Forecasts are advisory: they never move stock or alter a purchase plan automatically.
- **Dispose & post journal** is the irreversible path for expired, damaged, recalled or quality-failed units. It reduces the batch, location and company totals together, keeps disposition evidence, and posts current weighted cost from Inventory to Inventory write-off. A physical count correction is not a disposal and remains a separate action.

## Integrity and retry behavior

Activation and every batch adjustment use client request IDs. Counts also require the displayed batch version, so a stale screen cannot overwrite a newer movement. Sale, refund, receipt and transfer batch changes run inside the same MongoDB transaction as their existing inventory and financial effects.

Batch identity is the normalized lot number plus expiry date within a product and location. Date-only expiry keys are evaluated in the workspace time zone; no browser or server time-zone conversion can silently move an expiry day.

Demand forecasts use recent history, not guaranteed future sales. This module provides internal traceability and expiry control. It is not a food-safety certification, supplier authenticity guarantee, recall authority submission or serial-number system.
