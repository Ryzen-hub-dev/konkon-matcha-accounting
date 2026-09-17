# Location inventory and stock transfers

The **Stock transfers** workspace introduces physical location control without guessing where existing inventory is held.

## Activate a product

Existing products begin as legacy global stock. Before the first transfer, choose **Allocate** and distribute the product's current company total across every active location. The entered quantities must equal the existing total exactly. This is a one-time classification only: it does not add stock, change inventory value or create an accounting journal.

After activation:

- POS availability follows the selected counter's location;
- refunds return units to the original sale location;
- approved purchase receipts add units to the purchase-order location;
- manual adjustments require a location;
- stocktakes count one location at a time and update the company total by the posted variance.

## Transfer lifecycle

1. **Dispatch** chooses a source, a different destination and one or more available quantities. Source balances fall immediately and the units become in transit.
2. **Receive** confirms the complete shipment at the snapshotted destination. All lines enter destination stock together.
3. **Cancel** is available only while in transit and requires an explanation. All lines return to source stock together.

Transfers are atomic and whole-shipment in this release; partial receiving, damaged-in-transit claims and intercompany ownership transfers are not represented. A normal internal transfer does not change company total stock, weighted cost or the general ledger.

Activation and dispatch use stable request IDs so retrying the same network request cannot create duplicate records. Receive and cancel use an optimistic version so two operators cannot complete the same transfer differently. Locations with positive balances or in-transit links cannot be archived.
