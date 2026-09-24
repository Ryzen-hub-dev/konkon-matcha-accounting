"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  Eye,
  MapPin,
  PackageCheck,
  Pencil,
  Printer,
  Search,
  Send,
  Truck,
  XCircle,
} from "lucide-react";
import { useBusiness } from "@/components/business-context";
import {
  AddButton,
  apiRequest,
  EmptyState,
  LoadingPanel,
  Modal,
  Notice,
  PageHeader,
  StatusPill,
  useNotice,
} from "@/components/ui";
import {
  dateKeyInTimeZone,
  formatCalendarDate,
  shiftDateKey,
} from "@/lib/dates";

type QuotationChoice = {
  _id: string;
  quotationNo: string;
  status: string;
  effectiveStatus: string;
  customerName: string;
  validUntil: string;
  deliveryOrderId?: string;
  deliveryOrderNo?: string;
  convertedInvoiceNo?: string;
};
type DeliveryItem = { description: string; quantity: number };
type CarrierEvent = {
  event: string;
  status: string;
  providerTimestamp: string;
  receivedAt: string;
  rts: boolean;
};
type DeliveryOrder = {
  _id: string;
  deliveryOrderNo: string;
  sourceQuoteId: string;
  sourceQuoteNo: string;
  sourceInvoiceId?: string;
  sourceInvoiceNo?: string;
  memberNo?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerReference: string;
  deliveryAddress: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  carrierCode: string;
  carrier: string;
  deliveryAddress1: string;
  deliveryAddress2: string;
  deliveryArea: string;
  deliveryCity: string;
  deliveryState: string;
  deliveryCountryCode: string;
  deliveryPostcode: string;
  serviceLevel: string;
  pickupRequired: boolean;
  parcelWeight: number;
  trackingReference: string;
  instructions: string;
  scheduledDate: string;
  items: DeliveryItem[];
  status: string;
  effectiveStatus: string;
  createdAt: string;
  updatedAt: string;
  dispatchNote?: string;
  deliveryNote?: string;
  receivedBy?: string;
  carrierStatus?: string;
  carrierEvent?: string;
  carrierEventAt?: string;
  waybillReady?: boolean;
  carrierEvents?: CarrierEvent[];
  businessSnapshot: {
    businessName?: string;
    legalEntityName?: string;
    registrationNo?: string;
    email?: string;
    phone?: string;
    address?: string;
    locale?: string;
    timeZone?: string;
  };
};
type ShippingProvider = {
  id: string;
  name: string;
  trackingUrl: string;
  developerUrl: string;
  connection: string;
  capabilities: string[];
  note: string;
};
type DeliveryAction = "DISPATCH" | "DELIVER" | "CANCEL";
type CreationDraft = {
  sourceQuoteId: string;
  scheduledDate: string;
  clientRequestId: string;
};

export function DeliveryOrdersView({ canWrite }: { canWrite: boolean }) {
  const { profile } = useBusiness();
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [quotations, setQuotations] = useState<QuotationChoice[]>([]);
  const [providers, setProviders] = useState<ShippingProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [creation, setCreation] = useState<CreationDraft | null>(null);
  const [editor, setEditor] = useState<DeliveryOrder | null>(null);
  const [booking, setBooking] = useState<DeliveryOrder | null>(null);
  const [viewing, setViewing] = useState<DeliveryOrder | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);
  const [pending, setPending] = useState<{
    order: DeliveryOrder;
    action: DeliveryAction;
  } | null>(null);
  const [note, setNote] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  const { notice, show } = useNotice();
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);

  async function load() {
    setLoading(true);
    try {
      const [orderData, quoteData, providerData] = await Promise.all([
        apiRequest<DeliveryOrder[]>("/api/delivery-orders"),
        apiRequest<QuotationChoice[]>("/api/quotations"),
        apiRequest<ShippingProvider[]>("/api/shipping/providers"),
      ]);
      setOrders(orderData);
      setQuotations(quoteData);
      setProviders(providerData);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not load delivery orders.",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }
  async function openOrder(order: DeliveryOrder) {
    setViewing(order);
    setViewingLoading(true);
    try {
      const detail = await apiRequest<DeliveryOrder>(
        `/api/delivery-orders?id=${order._id}`,
      );
      setViewing((current) => (current?._id === detail._id ? detail : current));
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not load the carrier event history.",
        "error",
      );
    } finally {
      setViewingLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const eligibleQuotes = quotations.filter(
    (quotation) =>
      ["ACCEPTED", "CONVERTED"].includes(quotation.status) &&
      !quotation.deliveryOrderId,
  );
  function beginCreate() {
    setCreation({
      sourceQuoteId: eligibleQuotes[0]?._id || "",
      scheduledDate: shiftDateKey(today, 1),
      clientRequestId: crypto.randomUUID(),
    });
  }
  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!creation || busy) return;
    setBusy(true);
    try {
      const order = await apiRequest<DeliveryOrder>("/api/delivery-orders", {
        method: "POST",
        body: JSON.stringify(creation),
      });
      show(
        `${order.deliveryOrderNo} created from ${order.sourceQuoteNo}. Complete the delivery details before dispatch.`,
      );
      setCreation(null);
      if (order.status === "DRAFT") setEditor(order);
      else setViewing(order);
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not create the delivery order.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  function beginAction(order: DeliveryOrder, action: DeliveryAction) {
    setNote("");
    setReceivedBy("");
    setPending({ order, action });
  }
  async function confirmAction() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const updated = await apiRequest<DeliveryOrder>("/api/delivery-orders", {
        method: "PATCH",
        body: JSON.stringify({
          id: pending.order._id,
          action: pending.action,
          expectedUpdatedAt: pending.order.updatedAt,
          note,
          receivedBy,
        }),
      });
      show(
        pending.action === "DISPATCH"
          ? "Dispatch recorded. Inventory was not changed."
          : pending.action === "DELIVER"
            ? "Delivery completion recorded as an internal operational event."
            : "Delivery order cancelled.",
      );
      setPending(null);
      await load();
      if (viewing?._id === updated._id) void openOrder(updated);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not update the delivery order.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  async function bookNinjaVan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !booking) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const deliveryAddress = [
        form.get("address1"),
        form.get("address2"),
        form.get("area"),
        form.get("city"),
        form.get("state"),
        form.get("postcode"),
        form.get("country"),
      ]
        .filter(Boolean)
        .join(", ");
      const saved = await apiRequest<DeliveryOrder>("/api/delivery-orders", {
        method: "PATCH",
        body: JSON.stringify({
          action: "EDIT_DRAFT",
          id: booking._id,
          expectedUpdatedAt: booking.updatedAt,
          scheduledDate: booking.scheduledDate.slice(0, 10),
          deliveryAddress,
          contactName: form.get("contactName"),
          contactPhone: form.get("contactPhone"),
          contactEmail: form.get("contactEmail"),
          deliveryAddress1: form.get("address1"),
          deliveryAddress2: form.get("address2"),
          deliveryArea: form.get("area"),
          deliveryCity: form.get("city"),
          deliveryState: form.get("state"),
          deliveryCountryCode: form.get("country"),
          deliveryPostcode: form.get("postcode"),
          serviceLevel: form.get("serviceLevel"),
          pickupRequired: form.get("pickupRequired") === "on",
          parcelWeight: form.get("parcelWeight"),
          carrierCode: "NINJA_VAN",
          carrier: "Ninja Van",
          trackingReference: "",
          instructions: form.get("instructions"),
        }),
      });
      const updated = await apiRequest<DeliveryOrder>(
        "/api/shipping/ninja-van/orders",
        {
          method: "POST",
          body: JSON.stringify({
            id: saved._id,
            expectedUpdatedAt: saved.updatedAt,
          }),
        },
      );
      show(
        `Ninja Van accepted the shipment. Tracking: ${updated.trackingReference}`,
      );
      setBooking(null);
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not book the Ninja Van shipment.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  const needle = search.trim().toLocaleLowerCase();
  const visible = orders.filter(
    (order) =>
      (filter === "ALL" || order.effectiveStatus === filter) &&
      [
        order.deliveryOrderNo,
        order.sourceQuoteNo,
        order.customerName,
        order.trackingReference,
        order.deliveryAddress,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
  );
  const active = orders.filter((order) =>
    ["DRAFT", "DISPATCHED", "OVERDUE"].includes(order.effectiveStatus),
  );
  const dueNow = active.filter(
    (order) => order.scheduledDate.slice(0, 10) <= today,
  ).length;
  const createdDate = new Intl.DateTimeFormat(profile.locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: profile.timeZone,
  });

  return (
    <div className="page page-enter delivery-order-page">
      <PageHeader
        eyebrow="CUSTOMER FULFILMENT"
        title="Delivery orders"
        description="Turn accepted quotations into controlled dispatch records without confusing delivery status with stock, payment or customer proof."
        action={
          canWrite ? (
            <AddButton onClick={beginCreate}>New delivery order</AddButton>
          ) : undefined
        }
      />
      {notice ? <Notice {...notice} /> : null}
      <section className="mini-stat-row quotation-stats">
        <article>
          <PackageCheck />
          <span>Open deliveries</span>
          <strong>{active.length}</strong>
        </article>
        <article>
          <Clock3 />
          <span>Due or overdue</span>
          <strong>{dueNow}</strong>
        </article>
        <article>
          <CheckCircle2 />
          <span>Delivered</span>
          <strong>
            {orders.filter((order) => order.status === "DELIVERED").length}
          </strong>
        </article>
      </section>
      <section className="panel quotation-policy">
        <Truck />
        <div>
          <strong>
            Delivery status is operational evidence, not a stock ledger or
            customer signature.
          </strong>
          <p>
            Dispatching does not deduct inventory. “Delivered” records what an
            operator entered; attach external proof outside this first-stage
            workflow when required.
          </p>
        </div>
      </section>
      <section
        className="panel shipping-provider-strip"
        aria-label="Courier compatibility"
      >
        <div>
          <span className="eyebrow">VERIFIED CONNECTION PATHS</span>
          <strong>Courier handoff without invented endpoints</strong>
        </div>
        {providers
          .filter((provider) => provider.id !== "OTHER")
          .map((provider) => (
            <a
              key={provider.id}
              href={provider.developerUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span>{provider.name}</span>
              <small>{connectionLabel(provider.connection)}</small>
              <ExternalLink size={13} />
            </a>
          ))}
      </section>
      <section className="panel resource-panel quotation-register">
        <div className="quotation-toolbar">
          <label className="field">
            <span>
              <Search size={14} />
              Search delivery orders
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Delivery, quotation, customer or tracking"
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              {[
                "ALL",
                "DRAFT",
                "DISPATCHED",
                "OVERDUE",
                "DELIVERED",
                "CANCELLED",
              ].map((value) => (
                <option key={value} value={value}>
                  {value === "ALL" ? "All statuses" : value}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button button-secondary"
            disabled={loading}
            onClick={load}
          >
            Refresh
          </button>
        </div>
        {loading ? (
          <LoadingPanel label="Preparing delivery orders…" />
        ) : visible.length ? (
          <div className="data-list delivery-order-list">
            <div className="data-list-head">
              <span>Delivery order</span>
              <span>Customer</span>
              <span>Destination</span>
              <span>Scheduled</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            {visible.map((order) => (
              <div className="data-row" key={order._id}>
                <div>
                  <strong>{order.deliveryOrderNo}</strong>
                  <small>
                    {order.sourceQuoteNo} ·{" "}
                    {createdDate.format(new Date(order.createdAt))}
                  </small>
                </div>
                <div>
                  <strong>{order.customerName}</strong>
                  <small>
                    {order.contactPhone ||
                      order.customerReference ||
                      "No delivery contact"}
                  </small>
                </div>
                <div className="delivery-order-address">
                  <strong>{order.deliveryAddress || "Address required"}</strong>
                  <small>
                    {order.trackingReference
                      ? `${order.carrier || "Carrier"} · ${order.trackingReference}`
                      : order.carrier || "No carrier assigned"}
                  </small>
                </div>
                <div>
                  <strong>
                    {formatCalendarDate(order.scheduledDate, profile.locale)}
                  </strong>
                  <small>
                    {order.effectiveStatus === "OVERDUE"
                      ? "Action overdue"
                      : "Saved calendar date"}
                  </small>
                </div>
                <StatusPill value={order.effectiveStatus} />
                <div className="row-actions">
                  <button
                    className="button button-quiet"
                    onClick={() => void openOrder(order)}
                  >
                    <Eye size={14} />
                    View
                  </button>
                  {trackingPortal(order, providers) ? (
                    <a
                      className="button button-quiet"
                      href={trackingPortal(order, providers)}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open the official portal for ${order.trackingReference}`}
                    >
                      <ExternalLink size={14} />
                      Track
                    </a>
                  ) : null}
                  {order.carrierCode === "NINJA_VAN" &&
                  order.trackingReference ? (
                    <a
                      className="button button-quiet"
                      href={`/api/shipping/ninja-van/waybill?deliveryOrderId=${order._id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Printer size={14} />
                      Waybill
                    </a>
                  ) : null}
                  {canWrite && order.status === "DRAFT" ? (
                    <>
                      <button
                        className="button button-quiet"
                        onClick={() => setEditor(order)}
                      >
                        <Pencil size={14} />
                        Edit
                      </button>
                      {!order.trackingReference ? (
                        <button
                          className="button button-primary"
                          disabled={busy}
                          onClick={() => setBooking(order)}
                        >
                          <Truck size={14} />
                          Book Ninja Van
                        </button>
                      ) : null}
                      <button
                        className="button button-primary"
                        onClick={() => beginAction(order, "DISPATCH")}
                      >
                        <Send size={14} />
                        Dispatch
                      </button>
                    </>
                  ) : null}
                  {canWrite && order.status === "DISPATCHED" ? (
                    <button
                      className="button button-primary"
                      onClick={() => beginAction(order, "DELIVER")}
                    >
                      <CheckCircle2 size={14} />
                      Delivered
                    </button>
                  ) : null}
                  {canWrite &&
                  ["DRAFT", "DISPATCHED"].includes(order.status) ? (
                    <button
                      className="button button-quiet"
                      onClick={() => beginAction(order, "CANCEL")}
                    >
                      <XCircle size={14} />
                      Cancel
                    </button>
                  ) : null}
                  {order.sourceInvoiceId ? (
                    <Link
                      className="button button-secondary"
                      href={`/invoices/${order.sourceInvoiceId}`}
                    >
                      {order.sourceInvoiceNo}
                    </Link>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              orders.length
                ? "No matching delivery order"
                : "No delivery orders yet"
            }
            detail={
              orders.length
                ? "Change the search or status filter."
                : eligibleQuotes.length
                  ? "Create the first delivery order from an accepted quotation."
                  : "Accept a quotation before creating a delivery order."
            }
            action={
              canWrite && eligibleQuotes.length ? (
                <AddButton onClick={beginCreate}>New delivery order</AddButton>
              ) : undefined
            }
          />
        )}
      </section>

      <Modal
        open={Boolean(creation)}
        onClose={() => {
          if (!busy) setCreation(null);
        }}
        title="New delivery order"
        kicker="FROM ACCEPTED QUOTATION"
      >
        {creation ? (
          <form className="modal-form" onSubmit={createOrder}>
            <p className="form-hint">
              One complete delivery order can be created for each accepted
              quotation. The quotation items are copied on the server.
            </p>
            <label className="field">
              <span>Source quotation</span>
              <select
                value={creation.sourceQuoteId}
                onChange={(event) =>
                  setCreation({
                    ...creation,
                    sourceQuoteId: event.target.value,
                  })
                }
                required
              >
                <option value="">Choose an accepted quotation</option>
                {eligibleQuotes.map((quotation) => (
                  <option key={quotation._id} value={quotation._id}>
                    {quotation.quotationNo} · {quotation.customerName}
                    {quotation.convertedInvoiceNo
                      ? ` · ${quotation.convertedInvoiceNo}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Scheduled delivery date</span>
              <input
                type="date"
                value={creation.scheduledDate}
                onChange={(event) =>
                  setCreation({
                    ...creation,
                    scheduledDate: event.target.value,
                  })
                }
                required
              />
            </label>
            {!eligibleQuotes.length ? (
              <p className="invoice-form-error">
                There is no accepted quotation without a delivery order.
              </p>
            ) : null}
            <footer>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => setCreation(null)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || !creation.sourceQuoteId}
              >
                {busy ? "Creating…" : "Create draft"}
              </button>
            </footer>
          </form>
        ) : null}
      </Modal>

      {editor ? (
        <DeliveryOrderEditor
          source={editor}
          providers={providers}
          onClose={() => setEditor(null)}
          onSaved={(order) => {
            show(`${order.deliveryOrderNo} saved.`);
            setEditor(null);
            void load();
          }}
        />
      ) : null}

      <Modal
        open={Boolean(booking)}
        onClose={() => {
          if (!busy) setBooking(null);
        }}
        title="Book Ninja Van"
        kicker={booking?.deliveryOrderNo}
      >
        {booking ? (
          <form className="modal-form wide-form" onSubmit={bookNinjaVan}>
            <p className="form-hint">
              This sends a real order to the connected Ninja Van environment.
              Sandbox orders are tests; production access requires Ninja Van
              approval.
            </p>
            <fieldset disabled={busy}>
              <div className="form-grid three">
                <label className="field">
                  <span>Recipient name</span>
                  <input
                    name="contactName"
                    defaultValue={booking.contactName}
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </label>
                <label className="field">
                  <span>Recipient phone</span>
                  <input
                    name="contactPhone"
                    defaultValue={booking.contactPhone}
                    minLength={6}
                    maxLength={40}
                    required
                  />
                </label>
                <label className="field">
                  <span>Recipient email · optional</span>
                  <input
                    name="contactEmail"
                    type="email"
                    defaultValue={booking.contactEmail}
                    maxLength={160}
                  />
                </label>
              </div>
              <div className="form-grid two">
                <label className="field">
                  <span>Address line 1</span>
                  <input
                    name="address1"
                    defaultValue={
                      booking.deliveryAddress1 || booking.deliveryAddress
                    }
                    minLength={3}
                    maxLength={120}
                    required
                  />
                </label>
                <label className="field">
                  <span>Address line 2 · optional</span>
                  <input
                    name="address2"
                    defaultValue={booking.deliveryAddress2}
                    maxLength={120}
                  />
                </label>
                <label className="field">
                  <span>Area · optional</span>
                  <input
                    name="area"
                    defaultValue={booking.deliveryArea}
                    maxLength={80}
                  />
                </label>
                <label className="field">
                  <span>City · optional</span>
                  <input
                    name="city"
                    defaultValue={booking.deliveryCity}
                    maxLength={80}
                  />
                </label>
                <label className="field">
                  <span>State · optional</span>
                  <input
                    name="state"
                    defaultValue={booking.deliveryState}
                    maxLength={80}
                  />
                </label>
                <label className="field">
                  <span>Postcode</span>
                  <input
                    name="postcode"
                    defaultValue={booking.deliveryPostcode}
                    minLength={2}
                    maxLength={20}
                    required
                  />
                </label>
              </div>
              <div className="form-grid three">
                <label className="field">
                  <span>Destination country</span>
                  <input
                    name="country"
                    defaultValue={
                      booking.deliveryCountryCode || profile.countryCode
                    }
                    pattern="[A-Za-z]{2}"
                    maxLength={2}
                    required
                  />
                </label>
                <label className="field">
                  <span>Service level</span>
                  <select
                    name="serviceLevel"
                    defaultValue={booking.serviceLevel || "Standard"}
                  >
                    {["Standard", "Express", "Sameday", "Nextday"].map(
                      (level) => (
                        <option key={level}>{level}</option>
                      ),
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>Parcel weight · kg</span>
                  <input
                    name="parcelWeight"
                    type="number"
                    min="0.001"
                    max="1000"
                    step="0.001"
                    defaultValue={booking.parcelWeight || 1}
                    required
                  />
                </label>
              </div>
              <label className="check-row compact">
                <input
                  name="pickupRequired"
                  type="checkbox"
                  defaultChecked={booking.pickupRequired ?? true}
                />
                <span>
                  Request pickup using the shipper account's configured pickup
                  address
                </span>
              </label>
              <label className="field">
                <span>Delivery instructions · optional</span>
                <textarea
                  name="instructions"
                  defaultValue={booking.instructions}
                  maxLength={500}
                  rows={3}
                />
              </label>
            </fieldset>
            <footer>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => setBooking(null)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                <Truck size={15} />
                {busy ? "Booking…" : "Send order to Ninja Van"}
              </button>
            </footer>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pending)}
        onClose={() => {
          if (!busy) setPending(null);
        }}
        title={actionTitle(pending?.action)}
        kicker={pending?.order.deliveryOrderNo}
      >
        {pending ? (
          <div className="modal-form quotation-action-form">
            <p className="form-hint">{actionHelp(pending.action)}</p>
            {pending.action === "DELIVER" ? (
              <label className="field">
                <span>Received by · operator record</span>
                <input
                  value={receivedBy}
                  onChange={(event) => setReceivedBy(event.target.value)}
                  minLength={2}
                  maxLength={120}
                  required
                />
              </label>
            ) : null}
            <label className="field">
              <span>
                {pending.action === "CANCEL"
                  ? "Cancellation reason"
                  : "Operational note"}
              </span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                minLength={3}
                maxLength={300}
                rows={3}
                required
              />
            </label>
            <footer>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                Back
              </button>
              <button
                className="button button-primary"
                disabled={
                  busy ||
                  note.trim().length < 3 ||
                  (pending.action === "DELIVER" && receivedBy.trim().length < 2)
                }
                onClick={confirmAction}
              >
                {busy ? "Saving…" : "Confirm"}
              </button>
            </footer>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={
          viewing
            ? `Delivery order ${viewing.deliveryOrderNo}`
            : "Delivery order"
        }
        kicker={viewing?.effectiveStatus}
      >
        {viewing ? (
          <DeliveryOrderDocument
            order={viewing}
            eventsLoading={viewingLoading}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function actionTitle(action?: DeliveryAction) {
  return action === "DISPATCH"
    ? "Record dispatch?"
    : action === "DELIVER"
      ? "Record delivery completion?"
      : "Cancel delivery order?";
}
function actionHelp(action: DeliveryAction) {
  if (action === "DISPATCH")
    return "This locks the delivery details and records dispatch. It does not deduct stock or prove that a carrier received the goods.";
  if (action === "DELIVER")
    return "Record only information actually reported to the operator. This is not an electronic signature or independent proof of receipt.";
  return "The delivery order remains in history and cannot be reopened. Its source quotation remains unchanged.";
}

function connectionLabel(connection: string) {
  if (connection === "PUBLIC_DOCUMENTATION") return "Public API docs";
  if (connection === "ACCOUNT_SUBSCRIPTION") return "Account subscription";
  if (connection === "PARTNER_ONBOARDING") return "Partner onboarding";
  return "Manual reference";
}

function trackingPortal(order: DeliveryOrder, providers: ShippingProvider[]) {
  if (!order.trackingReference) return "";
  return (
    providers.find((provider) => provider.id === order.carrierCode)
      ?.trackingUrl || ""
  );
}

function DeliveryOrderEditor({
  source,
  providers,
  onClose,
  onSaved,
}: {
  source: DeliveryOrder;
  providers: ShippingProvider[];
  onClose: () => void;
  onSaved: (order: DeliveryOrder) => void;
}) {
  const [fields, setFields] = useState({
    scheduledDate: source.scheduledDate.slice(0, 10),
    deliveryAddress: source.deliveryAddress || "",
    contactName: source.contactName || "",
    contactPhone: source.contactPhone || "",
    contactEmail: source.contactEmail || "",
    deliveryAddress1: source.deliveryAddress1 || source.deliveryAddress || "",
    deliveryAddress2: source.deliveryAddress2 || "",
    deliveryArea: source.deliveryArea || "",
    deliveryCity: source.deliveryCity || "",
    deliveryState: source.deliveryState || "",
    deliveryCountryCode: source.deliveryCountryCode || "SG",
    deliveryPostcode: source.deliveryPostcode || "",
    serviceLevel: source.serviceLevel || "Standard",
    pickupRequired: source.pickupRequired ?? true,
    parcelWeight: source.parcelWeight || 1,
    carrierCode: source.carrierCode || "OTHER",
    carrier: source.carrier || "",
    trackingReference: source.trackingReference || "",
    instructions: source.instructions || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const order = await apiRequest<DeliveryOrder>("/api/delivery-orders", {
        method: "PATCH",
        body: JSON.stringify({
          action: "EDIT_DRAFT",
          id: source._id,
          expectedUpdatedAt: source.updatedAt,
          ...fields,
        }),
      });
      onSaved(order);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save the delivery order.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Delivery details"
      kicker={`${source.deliveryOrderNo} · ${source.sourceQuoteNo}`}
    >
      <form
        className="modal-form wide-form delivery-order-editor"
        onSubmit={save}
      >
        {error ? (
          <div className="invoice-form-error" role="alert">
            {error}
          </div>
        ) : null}
        <fieldset disabled={busy}>
          <div className="form-grid two">
            <label className="field">
              <span>Scheduled delivery date</span>
              <input
                type="date"
                value={fields.scheduledDate}
                onChange={(event) =>
                  setFields({ ...fields, scheduledDate: event.target.value })
                }
                required
              />
            </label>
            <label className="field">
              <span>Delivery contact</span>
              <input
                value={fields.contactName}
                onChange={(event) =>
                  setFields({ ...fields, contactName: event.target.value })
                }
                minLength={2}
                maxLength={120}
                required
              />
            </label>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>Contact phone · optional</span>
              <input
                value={fields.contactPhone}
                onChange={(event) =>
                  setFields({ ...fields, contactPhone: event.target.value })
                }
                maxLength={40}
              />
            </label>
            <label className="field">
              <span>Carrier</span>
              <select
                value={fields.carrierCode}
                onChange={(event) => {
                  const provider = providers.find(
                    (item) => item.id === event.target.value,
                  );
                  setFields({
                    ...fields,
                    carrierCode: event.target.value,
                    carrier:
                      provider?.id === "OTHER" ? "" : provider?.name || "",
                  });
                }}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {fields.carrierCode === "OTHER" ? (
            <label className="field">
              <span>Manual carrier name · optional</span>
              <input
                value={fields.carrier}
                onChange={(event) =>
                  setFields({ ...fields, carrier: event.target.value })
                }
                maxLength={80}
              />
            </label>
          ) : (
            <p className="form-hint">
              {
                providers.find((provider) => provider.id === fields.carrierCode)
                  ?.note
              }
            </p>
          )}
          <label className="field">
            <span>Delivery address</span>
            <textarea
              value={fields.deliveryAddress}
              onChange={(event) =>
                setFields({ ...fields, deliveryAddress: event.target.value })
              }
              minLength={5}
              maxLength={300}
              rows={3}
              required
            />
          </label>
          <label className="field">
            <span>Tracking or dispatch reference · optional</span>
            <input
              value={fields.trackingReference}
              onChange={(event) =>
                setFields({ ...fields, trackingReference: event.target.value })
              }
              maxLength={100}
            />
          </label>
          <label className="field">
            <span>Delivery instructions · optional</span>
            <textarea
              value={fields.instructions}
              onChange={(event) =>
                setFields({ ...fields, instructions: event.target.value })
              }
              maxLength={500}
              rows={3}
            />
          </label>
        </fieldset>
        <footer>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            <MapPin size={15} />
            {busy ? "Saving…" : "Save delivery details"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function DeliveryOrderDocument({
  order,
  eventsLoading,
}: {
  order: DeliveryOrder;
  eventsLoading: boolean;
}) {
  const carrierDate = new Intl.DateTimeFormat(
    order.businessSnapshot.locale || "en-MY",
    {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: order.businessSnapshot.timeZone || "UTC",
    },
  );
  return (
    <div className="quotation-document delivery-order-document">
      <header>
        <div>
          <span>DELIVERY ORDER</span>
          <strong>{order.businessSnapshot.businessName}</strong>
          <small>{order.businessSnapshot.address}</small>
        </div>
        <div>
          <b>{order.deliveryOrderNo}</b>
          <small>Source {order.sourceQuoteNo}</small>
          <StatusPill value={order.effectiveStatus} />
        </div>
      </header>
      <section>
        <div>
          <small>DELIVER TO</small>
          <strong>{order.customerName}</strong>
          <span>
            {[order.contactName, order.contactPhone, order.deliveryAddress]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <button
          className="button button-secondary quotation-print"
          onClick={() => window.print()}
        >
          <Printer size={14} />
          Print
        </button>
      </section>
      <dl className="delivery-order-document-meta">
        <div>
          <dt>Scheduled</dt>
          <dd>
            {formatCalendarDate(
              order.scheduledDate,
              order.businessSnapshot.locale || "en-MY",
            )}
          </dd>
        </div>
        <div>
          <dt>Carrier</dt>
          <dd>{order.carrier || "Not assigned"}</dd>
        </div>
        <div>
          <dt>Tracking reference</dt>
          <dd>{order.trackingReference || "Not recorded"}</dd>
        </div>
      </dl>
      {order.carrierCode === "NINJA_VAN" && order.trackingReference ? (
        <section
          className="carrier-event-panel"
          aria-label="Ninja Van event history"
        >
          <header>
            <div>
              <small>SIGNED CARRIER FEED</small>
              <strong>
                {order.carrierEvent ||
                  order.carrierStatus ||
                  "Waiting for Ninja Van"}
              </strong>
              <span>{order.trackingReference}</span>
            </div>
            {order.waybillReady ? <b>Waybill ready</b> : null}
          </header>
          {eventsLoading && !order.carrierEvents ? (
            <p className="carrier-event-empty">
              Loading verified carrier events…
            </p>
          ) : order.carrierEvents?.length ? (
            <ol className="carrier-event-timeline">
              {order.carrierEvents.map((event, index) => (
                <li key={`${event.providerTimestamp}-${index}`}>
                  <i aria-hidden="true" />
                  <div>
                    <strong>{event.event || event.status}</strong>
                    <span>
                      {event.status}
                      {event.rts ? " · Return-to-sender leg" : ""}
                    </span>
                  </div>
                  <time dateTime={event.providerTimestamp}>
                    {carrierDate.format(new Date(event.providerTimestamp))}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="carrier-event-empty">
              No signed Ninja Van event has arrived yet.
            </p>
          )}
          <footer>
            Events passed Ninja Van HMAC verification. They remain
            carrier-reported operational evidence, not an independent customer
            signature.
          </footer>
        </section>
      ) : null}
      <div className="report-table-wrap">
        <table className="report-table quotation-document-table">
          <thead>
            <tr>
              <th>Description</th>
              <th className="number">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, index) => (
              <tr key={index}>
                <td>{item.description}</td>
                <td className="number">{item.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {order.instructions ? (
        <aside>
          <small>DELIVERY INSTRUCTIONS</small>
          <p>{order.instructions}</p>
        </aside>
      ) : null}
      {order.status === "DELIVERED" ? (
        <aside>
          <small>OPERATOR DELIVERY RECORD</small>
          <p>
            Received by: {order.receivedBy}
            <br />
            {order.deliveryNote}
          </p>
        </aside>
      ) : null}
      <footer>
        This document records an operational delivery workflow. It is not an
        invoice, payment receipt, inventory movement, electronic signature or
        independent proof of customer receipt.
      </footer>
    </div>
  );
}
