"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Banknote,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Factory,
  FilePlus2,
  PackageCheck,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Truck,
  WalletCards,
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
import { dateKeyInTimeZone } from "@/lib/dates";
import {
  COUNTRY_PROFILES,
  CURRENCY_OPTIONS,
  currencyFractionDigits,
  roundCurrency,
} from "@/lib/international";

type Supplier = {
  _id: string;
  code: string;
  name: string;
  contactName: string;
  registrationNo: string;
  taxNo: string;
  email: string;
  phone: string;
  address: string;
  countryCode: string;
  currency: string;
  paymentTermsDays: number;
  leadTimeDays: number;
  minimumOrder: number;
  notes: string;
  active: boolean;
  openOrderCount: number;
  overdueOrderCount: number;
  outstandingBase: number;
  pulse: {
    score: number;
    risk: string;
    punctuality: number | null;
    averageLateDays: number;
  };
};
type Product = {
  _id: string;
  sku: string;
  name: string;
  unit: string;
  cost: number;
  stock: number;
  reorderLevel: number;
};
type Location = { _id: string; code: string; name: string; type: string };
type OrderLine = {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: number;
  receivedQuantity: number;
  unitCost: number;
  lineTotal: number;
};
type PurchaseOrder = {
  _id: string;
  purchaseOrderNo: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  locationName: string;
  expectedDate: string;
  items: OrderLine[];
  currency: string;
  baseCurrency: string;
  subtotal: number;
  tax: number;
  total: number;
  baseTotal: number;
  status: string;
  isOverdue?: boolean;
  createdAt: string;
  createdBy?: string;
};
type Suggestion = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  stock: number;
  reorderLevel: number;
  recent30DayUnits: number;
  inboundQuantity: number;
  suggestedQuantity: number;
  lastBaseCost: number;
  lastSupplierId?: string;
  lastSupplierName?: string;
};
type PurchaseBundle = {
  orders: PurchaseOrder[];
  products: Product[];
  locations: Location[];
  reorderSuggestions: Suggestion[];
  business: {
    currency: string;
    taxName: string;
    taxRate: number;
    taxMode: "EXCLUSIVE" | "INCLUSIVE";
    locale: string;
    timeZone: string;
  };
};
type Bill = {
  _id: string;
  billNo: string;
  supplierName: string;
  supplierInvoiceNo: string;
  purchaseOrderNo: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  baseCurrency: string;
  total: number;
  paidAmount: number;
  balance: number;
  baseBalance: number;
  status: string;
  displayStatus: string;
};
type Payment = {
  _id: string;
  paymentNo: string;
  supplierName: string;
  amount: number;
  currency: string;
  reference: string;
  paidAt: string;
};
type Account = { _id: string; code: string; name: string };
type PayablesBundle = {
  bills: Bill[];
  payments: Payment[];
  accounts: Account[];
};
type ExchangeData = {
  baseCurrency: string;
  rates: Array<{ quoteCurrency: string; rate: number }>;
};
type DraftLine = { productId: string; quantity: number; unitCost: number };

function isoDate(timeZone: string, days = 0) {
  return dateKeyInTimeZone(new Date(Date.now() + days * 86_400_000), timeZone);
}
function currencyFormatter(locale: string, currency: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency });
}
function currencyStep(currency: string) {
  return 1 / 10 ** currencyFractionDigits(currency);
}

export function ProcurementView({
  canWrite,
  canApprove,
  canPay,
  currentUserId,
  allowSelfApproval,
}: {
  canWrite: boolean;
  canApprove: boolean;
  canPay: boolean;
  currentUserId: string;
  allowSelfApproval: boolean;
}) {
  const { profile, money, shortDate } = useBusiness();
  const [tab, setTab] = useState<"ORDERS" | "SUPPLIERS" | "PAYABLES">("ORDERS");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchase, setPurchase] = useState<PurchaseBundle>({
    orders: [],
    products: [],
    locations: [],
    reorderSuggestions: [],
    business: {
      currency: profile.currency,
      taxName: profile.taxName,
      taxRate: profile.taxRate,
      taxMode: profile.taxMode,
      locale: profile.locale,
      timeZone: profile.timeZone,
    },
  });
  const [payables, setPayables] = useState<PayablesBundle>({
    bills: [],
    payments: [],
    accounts: [],
  });
  const [exchange, setExchange] = useState<ExchangeData>({
    baseCurrency: profile.currency,
    rates: [],
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [supplierOpen, setSupplierOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [receiveOrder, setReceiveOrder] = useState<PurchaseOrder | null>(null);
  const [payBill, setPayBill] = useState<Bill | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [expectedDate, setExpectedDate] = useState(
    isoDate(profile.timeZone, 7),
  );
  const [taxRate, setTaxRate] = useState(profile.taxRate);
  const [taxMode, setTaxMode] = useState<"EXCLUSIVE" | "INCLUSIVE">(
    profile.taxMode,
  );
  const [draftLines, setDraftLines] = useState<DraftLine[]>([
    { productId: "", quantity: 1, unitCost: 0 },
  ]);
  const [receiveCounts, setReceiveCounts] = useState<Record<string, string>>(
    {},
  );
  const { notice, show } = useNotice();

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const [supplierData, purchaseData, payableData, exchangeData] =
        await Promise.all([
          apiRequest<Supplier[]>(
            `/api/suppliers${canWrite ? "?includeArchived=1" : ""}`,
          ),
          apiRequest<PurchaseBundle>("/api/purchase-orders"),
          apiRequest<PayablesBundle>("/api/accounts-payable"),
          apiRequest<ExchangeData>("/api/exchange-rates"),
        ]);
      setSuppliers(supplierData);
      setPurchase(purchaseData);
      setPayables(payableData);
      setExchange(exchangeData);
      setSupplierId((current) =>
        supplierData.some(
          (supplier) => supplier._id === current && supplier.active !== false,
        )
          ? current
          : supplierData.find((supplier) => supplier.active !== false)?._id ||
            "",
      );
      setLocationId((current) =>
        purchaseData.locations.some((location) => location._id === current)
          ? current
          : purchaseData.locations[0]?._id || "",
      );
    } catch (reason) {
      show(
        reason instanceof Error ? reason.message : "Could not load purchasing.",
        "error",
      );
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const activeSuppliers = suppliers.filter(
    (supplier) => supplier.active !== false,
  );
  const selectedSupplier = activeSuppliers.find(
    (supplier) => supplier._id === supplierId,
  );
  function rateForSupplier(supplier?: Supplier) {
    return !supplier || supplier.currency === exchange.baseCurrency
      ? 1
      : exchange.rates.find((item) => item.quoteCurrency === supplier.currency)
          ?.rate || 0;
  }
  function supplierCost(
    product: Product | undefined,
    supplier = selectedSupplier,
  ) {
    const rate = rateForSupplier(supplier);
    return product && rate
      ? roundCurrency(
          product.cost * rate,
          supplier?.currency || exchange.baseCurrency,
        )
      : 0;
  }
  function chooseSupplier(id: string) {
    const supplier = activeSuppliers.find((item) => item._id === id);
    setSupplierId(id);
    if (supplier)
      setExpectedDate(isoDate(profile.timeZone, supplier.leadTimeDays));
    setDraftLines((current) =>
      current.map((line) => ({
        ...line,
        unitCost: supplierCost(
          purchase.products.find((product) => product._id === line.productId),
          supplier,
        ),
      })),
    );
  }
  const orderMoney = useMemo(
    () =>
      currencyFormatter(
        profile.locale,
        selectedSupplier?.currency || profile.currency,
      ),
    [profile.locale, profile.currency, selectedSupplier?.currency],
  );
  const dateOnly = useMemo(
    () =>
      new Intl.DateTimeFormat(profile.locale, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    [profile.locale],
  );
  const draftSubtotal = draftLines.reduce(
    (sum, line) =>
      sum + Number(line.quantity || 0) * Number(line.unitCost || 0),
    0,
  );
  const openOrders = purchase.orders.filter((order) =>
    ["DRAFT", "APPROVED", "PARTIALLY_RECEIVED"].includes(order.status),
  );
  const overdueOrders = purchase.orders.filter(
    (order) => order.isOverdue,
  ).length;
  const outstandingBase = payables.bills.reduce(
    (sum, bill) => sum + Number(bill.baseBalance || 0),
    0,
  );
  const overdueBills = payables.bills.filter(
    (bill) => bill.displayStatus === "OVERDUE",
  ).length;
  const atRiskSuppliers = activeSuppliers.filter(
    (supplier) => supplier.pulse.risk === "AT_RISK",
  ).length;
  const processCounts = {
    DRAFT: purchase.orders.filter((order) => order.status === "DRAFT").length,
    APPROVED: purchase.orders.filter((order) => order.status === "APPROVED")
      .length,
    RECEIVING: purchase.orders.filter(
      (order) => order.status === "PARTIALLY_RECEIVED",
    ).length,
    RECEIVED: purchase.orders.filter((order) => order.status === "RECEIVED")
      .length,
    PAID: payables.bills.filter((bill) => bill.status === "PAID").length,
  };

  function beginSupplier(supplier: Supplier | null = null) {
    setEditingSupplier(supplier);
    setSupplierOpen(true);
  }

  async function saveSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await apiRequest("/api/suppliers", {
        method: editingSupplier ? "PATCH" : "POST",
        body: JSON.stringify({
          ...data,
          ...(editingSupplier ? { id: editingSupplier._id } : {}),
        }),
      });
      show(editingSupplier ? "Supplier details updated." : "Supplier created.");
      setSupplierOpen(false);
      setEditingSupplier(null);
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not save the supplier.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function archiveSupplier(supplier: Supplier) {
    if (
      !window.confirm(
        `Archive ${supplier.name}? Historical orders and bills remain available.`,
      )
    )
      return;
    try {
      await apiRequest("/api/suppliers", {
        method: "DELETE",
        body: JSON.stringify({ id: supplier._id }),
      });
      show("Supplier archived with history preserved.");
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not archive the supplier.",
        "error",
      );
    }
  }

  async function restoreSupplier(supplier: Supplier) {
    try {
      await apiRequest("/api/suppliers", {
        method: "PATCH",
        body: JSON.stringify({ id: supplier._id, restore: true }),
      });
      show("Supplier restored.");
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not restore the supplier.",
        "error",
      );
    }
  }

  function beginOrder() {
    const supplier = activeSuppliers[0];
    setSupplierId(supplier?._id || "");
    setLocationId(purchase.locations[0]?._id || "");
    setExpectedDate(isoDate(profile.timeZone, supplier?.leadTimeDays || 7));
    setTaxRate(purchase.business.taxRate);
    setTaxMode(purchase.business.taxMode);
    setDraftLines([{ productId: "", quantity: 1, unitCost: 0 }]);
    setOrderOpen(true);
  }

  function updateDraftLine(index: number, patch: Partial<DraftLine>) {
    setDraftLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...patch } : line,
      ),
    );
  }

  function applySmartReorder() {
    if (!selectedSupplier)
      return show(
        "Choose a supplier before applying the replenishment plan.",
        "error",
      );
    if (!purchase.reorderSuggestions.length)
      return show("Every product is currently above its reorder threshold.");
    const rate =
      selectedSupplier.currency === exchange.baseCurrency
        ? 1
        : exchange.rates.find(
            (item) => item.quoteCurrency === selectedSupplier.currency,
          )?.rate || 0;
    if (!rate)
      return show(
        `Configure a ${exchange.baseCurrency}/${selectedSupplier.currency} exchange rate before using smart reorder.`,
        "error",
      );
    const preferred = purchase.reorderSuggestions.filter(
      (suggestion) =>
        !suggestion.lastSupplierId ||
        suggestion.lastSupplierId === selectedSupplier._id,
    );
    const source = preferred.length ? preferred : purchase.reorderSuggestions;
    const lines = source
      .map((suggestion) => ({
        productId: suggestion.productId,
        quantity: Math.max(
          0,
          Math.max(
            suggestion.reorderLevel * 2,
            Math.ceil(
              (suggestion.recent30DayUnits / 30) *
                selectedSupplier.leadTimeDays,
            ) + suggestion.reorderLevel,
          ) -
            suggestion.stock -
            suggestion.inboundQuantity,
        ),
        unitCost: roundCurrency(
          suggestion.lastBaseCost * rate,
          selectedSupplier.currency,
        ),
      }))
      .filter((line) => line.quantity > 0);
    if (!lines.length)
      return show(
        "Open purchase orders already cover this supplier's replenishment demand.",
      );
    setDraftLines(lines);
    setExpectedDate(isoDate(profile.timeZone, selectedSupplier.leadTimeDays));
    show(
      `${lines.length} low-stock product${lines.length === 1 ? "" : "s"} added after deducting open purchase quantities.`,
    );
  }

  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          supplierId,
          locationId,
          expectedDate,
          taxRate,
          taxMode,
          supplierReference: data.get("supplierReference"),
          notes: data.get("notes"),
          items: draftLines,
        }),
      });
      show("Purchase order draft created.");
      setOrderOpen(false);
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not create the purchase order.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function orderAction(
    order: PurchaseOrder,
    action: "APPROVE" | "CANCEL",
  ) {
    const reason =
      action === "CANCEL"
        ? window.prompt("Reason for cancelling this purchase order:")?.trim()
        : "";
    if (action === "CANCEL" && !reason) return;
    try {
      await apiRequest("/api/purchase-orders", {
        method: "PATCH",
        body: JSON.stringify({
          id: order._id,
          action,
          ...(reason ? { reason } : {}),
        }),
      });
      show(
        action === "APPROVE"
          ? "Purchase order approved for receiving."
          : "Purchase order cancelled.",
      );
      await load(false);
    } catch (reasonValue) {
      show(
        reasonValue instanceof Error
          ? reasonValue.message
          : "Could not update the purchase order.",
        "error",
      );
    }
  }

  function beginReceive(order: PurchaseOrder) {
    setReceiveOrder(order);
    setReceiveCounts({});
  }

  async function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!receiveOrder) return;
    const lines = receiveOrder.items
      .map((line) => ({
        productId: line.productId,
        quantity: Number(receiveCounts[line.productId] || 0),
      }))
      .filter((line) => line.quantity > 0);
    if (!lines.length)
      return show("Enter at least one received quantity.", "error");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/purchase-orders", {
        method: "PATCH",
        body: JSON.stringify({
          id: receiveOrder._id,
          action: "RECEIVE",
          clientRequestId: crypto.randomUUID(),
          supplierInvoiceNo: data.get("supplierInvoiceNo"),
          invoiceDate: data.get("invoiceDate"),
          receivedAt: data.get("receivedAt"),
          notes: data.get("notes"),
          lines,
        }),
      });
      show(
        "Goods received, stock updated and supplier bill posted in one transaction.",
      );
      setReceiveOrder(null);
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not post the delivery.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payBill) return;
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/accounts-payable", {
        method: "PATCH",
        body: JSON.stringify({
          id: payBill._id,
          clientRequestId: crypto.randomUUID(),
          amount: data.get("amount"),
          paymentAccountCode: data.get("paymentAccountCode"),
          reference: data.get("reference"),
          paidAt: data.get("paidAt"),
          notes: data.get("notes"),
        }),
      });
      show(
        "Supplier payment posted with any exchange difference balanced automatically.",
      );
      setPayBill(null);
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not post the supplier payment.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-enter procurement-page">
      <PageHeader
        eyebrow="PURCHASE-TO-PAY"
        title="Purchasing & payables"
        description="Plan replenishment, approve commitments, receive stock and settle supplier bills without breaking the audit trail."
        action={
          canWrite ? (
            <AddButton onClick={beginOrder}>New purchase order</AddButton>
          ) : undefined
        }
      />
      {notice ? <Notice {...notice} /> : null}
      <section
        className="procurement-rail"
        aria-label="Purchase-to-pay workflow"
      >
        {(
          [
            ["DRAFT", "Plan"],
            ["APPROVED", "Approve"],
            ["RECEIVING", "Receive"],
            ["RECEIVED", "Bill"],
            ["PAID", "Pay"],
          ] as const
        ).map(([key, label], index) => (
          <div key={key} className={processCounts[key] ? "active" : ""}>
            <i>{index + 1}</i>
            <span>
              {label}
              <small>
                {processCounts[key]} record{processCounts[key] === 1 ? "" : "s"}
              </small>
            </span>
            {index < 4 ? <ChevronRight /> : null}
          </div>
        ))}
      </section>
      <section className="procurement-pulse">
        <article>
          <PackageCheck />
          <span>Open commitments</span>
          <strong>{openOrders.length}</strong>
          <small>{overdueOrders} past expected date</small>
        </article>
        <article className={outstandingBase ? "attention" : ""}>
          <WalletCards />
          <span>Accounts payable</span>
          <strong>{money.format(outstandingBase)}</strong>
          <small>
            {overdueBills} overdue bill{overdueBills === 1 ? "" : "s"}
          </small>
        </article>
        <article>
          <Sparkles />
          <span>Replenishment queue</span>
          <strong>{purchase.reorderSuggestions.length}</strong>
          <small>Demand + reorder threshold</small>
        </article>
        <article className={atRiskSuppliers ? "risk" : ""}>
          <Factory />
          <span>Supply Pulse</span>
          <strong>{atRiskSuppliers || "Clear"}</strong>
          <small>
            {atRiskSuppliers ? "suppliers need review" : "no supplier at risk"}
          </small>
        </article>
      </section>
      <div className="procurement-tabs" role="tablist">
        <button
          className={tab === "ORDERS" ? "active" : ""}
          onClick={() => setTab("ORDERS")}
        >
          Purchase orders
        </button>
        <button
          className={tab === "SUPPLIERS" ? "active" : ""}
          onClick={() => setTab("SUPPLIERS")}
        >
          Suppliers
        </button>
        <button
          className={tab === "PAYABLES" ? "active" : ""}
          onClick={() => setTab("PAYABLES")}
        >
          Bills & payments
        </button>
      </div>

      {loading ? (
        <LoadingPanel label="Opening the purchase ledger…" />
      ) : tab === "ORDERS" ? (
        <section className="panel procurement-ledger">
          <div className="panel-header">
            <div>
              <span className="eyebrow">COMMITMENTS</span>
              <h2>Purchase orders</h2>
            </div>
            {purchase.reorderSuggestions.length && canWrite ? (
              <button className="button button-secondary" onClick={beginOrder}>
                <Sparkles size={16} />
                Use replenishment plan
              </button>
            ) : null}
          </div>
          {purchase.orders.length ? (
            <div className="purchase-order-list">
              {purchase.orders.map((order) => {
                const received = order.items.reduce(
                  (sum, line) => sum + Number(line.receivedQuantity || 0),
                  0,
                );
                const ordered = order.items.reduce(
                  (sum, line) => sum + Number(line.quantity),
                  0,
                );
                const makerCanApprove =
                  allowSelfApproval ||
                  !order.createdBy ||
                  order.createdBy !== currentUserId;
                return (
                  <details
                    key={order._id}
                    className={order.isOverdue ? "overdue" : ""}
                  >
                    <summary>
                      <div className="po-stamp">
                        <PackageCheck />
                      </div>
                      <div>
                        <strong>{order.purchaseOrderNo}</strong>
                        <small>
                          {order.supplierCode} · {order.supplierName}
                        </small>
                      </div>
                      <div>
                        <span>DESTINATION</span>
                        <strong>{order.locationName}</strong>
                        <small>
                          Expected{" "}
                          {dateOnly.format(new Date(order.expectedDate))}
                        </small>
                      </div>
                      <div className="po-progress">
                        <span>
                          <i
                            style={{
                              width: `${ordered ? Math.round((received / ordered) * 100) : 0}%`,
                            }}
                          />
                        </span>
                        <small>
                          {received} / {ordered} units received
                        </small>
                      </div>
                      <strong>
                        {currencyFormatter(
                          profile.locale,
                          order.currency,
                        ).format(order.total)}
                      </strong>
                      <StatusPill
                        value={order.isOverdue ? "OVERDUE" : order.status}
                      />
                      <ChevronRight />
                    </summary>
                    <div className="po-detail">
                      <div className="po-lines">
                        <header>
                          <span>Product</span>
                          <span>Ordered</span>
                          <span>Received</span>
                          <span>Unit cost</span>
                          <span>Line total</span>
                        </header>
                        {order.items.map((line) => (
                          <div key={line.productId}>
                            <span>
                              <strong>{line.productName}</strong>
                              <small>{line.sku}</small>
                            </span>
                            <b>
                              {line.quantity} {line.unit}
                            </b>
                            <b>
                              {line.receivedQuantity || 0} {line.unit}
                            </b>
                            <span>
                              {currencyFormatter(
                                profile.locale,
                                order.currency,
                              ).format(line.unitCost)}
                            </span>
                            <strong>
                              {currencyFormatter(
                                profile.locale,
                                order.currency,
                              ).format(line.lineTotal)}
                            </strong>
                          </div>
                        ))}
                      </div>
                      <footer>
                        <span>
                          Created {shortDate.format(new Date(order.createdAt))}{" "}
                          · Base commitment {money.format(order.baseTotal)}
                        </span>
                        <div>
                          {canWrite &&
                          ["DRAFT", "APPROVED"].includes(order.status) ? (
                            <button
                              className="button button-quiet"
                              onClick={() => void orderAction(order, "CANCEL")}
                            >
                              <XCircle size={15} />
                              Cancel order
                            </button>
                          ) : null}
                          {canApprove &&
                          makerCanApprove &&
                          order.status === "DRAFT" ? (
                            <button
                              className="button button-secondary"
                              onClick={() => void orderAction(order, "APPROVE")}
                            >
                              <ClipboardCheck size={15} />
                              Approve
                            </button>
                          ) : null}
                          {canWrite &&
                          ["APPROVED", "PARTIALLY_RECEIVED"].includes(
                            order.status,
                          ) ? (
                            <button
                              className="button button-primary"
                              onClick={() => beginReceive(order)}
                            >
                              <Truck size={15} />
                              Receive delivery
                            </button>
                          ) : null}
                        </div>
                      </footer>
                    </div>
                  </details>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No purchase orders"
              detail="Create a supplier and draft the first replenishment commitment."
              action={
                canWrite ? (
                  <AddButton onClick={beginOrder}>New purchase order</AddButton>
                ) : undefined
              }
            />
          )}
        </section>
      ) : tab === "SUPPLIERS" ? (
        <section className="panel procurement-ledger">
          <div className="panel-header">
            <div>
              <span className="eyebrow">SOURCE NETWORK</span>
              <h2>Suppliers</h2>
            </div>
            {canWrite ? (
              <AddButton onClick={() => beginSupplier()}>
                New supplier
              </AddButton>
            ) : null}
          </div>
          {suppliers.length ? (
            <div className="supplier-grid">
              {suppliers.map((supplier) => (
                <article
                  key={supplier._id}
                  className={`${supplier.active === false ? "archived" : ""} pulse-${supplier.pulse.risk.toLowerCase()}`}
                >
                  <header>
                    <div className="supplier-mark">
                      <Factory />
                    </div>
                    <span>
                      <strong>{supplier.name}</strong>
                      <small>
                        {supplier.code} ·{" "}
                        {COUNTRY_PROFILES.find(
                          (country) => country.code === supplier.countryCode,
                        )?.name || supplier.countryCode}
                      </small>
                    </span>
                    <StatusPill
                      value={
                        supplier.active === false
                          ? "ARCHIVED"
                          : supplier.pulse.risk
                      }
                    />
                  </header>
                  <div className="supplier-score">
                    <strong>{supplier.pulse.score}</strong>
                    <span>
                      SUPPLY PULSE
                      <small>
                        {supplier.pulse.punctuality === null
                          ? "No receipts yet"
                          : `${supplier.pulse.punctuality}% on time · ${supplier.pulse.averageLateDays} avg late days`}
                      </small>
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>Terms</dt>
                      <dd>{supplier.paymentTermsDays} days</dd>
                    </div>
                    <div>
                      <dt>Lead time</dt>
                      <dd>{supplier.leadTimeDays} days</dd>
                    </div>
                    <div>
                      <dt>Open POs</dt>
                      <dd>{supplier.openOrderCount}</dd>
                    </div>
                    <div>
                      <dt>Outstanding</dt>
                      <dd>{money.format(supplier.outstandingBase)}</dd>
                    </div>
                  </dl>
                  <footer>
                    <span>
                      {supplier.contactName ||
                        supplier.email ||
                        supplier.phone ||
                        "No contact recorded"}
                    </span>
                    {canWrite ? (
                      <div>
                        {supplier.active === false ? (
                          <button
                            className="icon-button"
                            title="Restore supplier"
                            onClick={() => void restoreSupplier(supplier)}
                          >
                            <RotateCcw size={15} />
                          </button>
                        ) : (
                          <>
                            <button
                              className="icon-button"
                              title="Edit supplier"
                              onClick={() => beginSupplier(supplier)}
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              className="icon-button danger"
                              title="Archive supplier"
                              onClick={() => void archiveSupplier(supplier)}
                            >
                              <Archive size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No suppliers"
              detail="Add a supplier before drafting purchase orders."
              action={
                canWrite ? (
                  <AddButton onClick={() => beginSupplier()}>
                    New supplier
                  </AddButton>
                ) : undefined
              }
            />
          )}
        </section>
      ) : (
        <section className="panel procurement-ledger">
          <div className="panel-header">
            <div>
              <span className="eyebrow">ACCOUNTS PAYABLE</span>
              <h2>Supplier bills</h2>
            </div>
            <span className="panel-note">
              BASE OUTSTANDING · {money.format(outstandingBase)}
            </span>
          </div>
          {payables.bills.length ? (
            <div className="payable-list">
              <div className="data-list-head">
                <span>Bill</span>
                <span>Supplier / invoice</span>
                <span>Due</span>
                <span>Total</span>
                <span>Balance</span>
                <span>Status / action</span>
              </div>
              {payables.bills.map((bill) => (
                <div
                  className={`data-row ${bill.displayStatus === "OVERDUE" ? "overdue" : ""}`}
                  key={bill._id}
                >
                  <div>
                    <strong>{bill.billNo}</strong>
                    <small>{bill.purchaseOrderNo}</small>
                  </div>
                  <div>
                    <strong>{bill.supplierName}</strong>
                    <small>{bill.supplierInvoiceNo}</small>
                  </div>
                  <span>{dateOnly.format(new Date(bill.dueDate))}</span>
                  <strong>
                    {currencyFormatter(profile.locale, bill.currency).format(
                      bill.total,
                    )}
                  </strong>
                  <div>
                    <strong>
                      {currencyFormatter(profile.locale, bill.currency).format(
                        bill.balance,
                      )}
                    </strong>
                    <small>{money.format(bill.baseBalance)} base</small>
                  </div>
                  <div className="payable-action">
                    <StatusPill value={bill.displayStatus} />
                    {canPay && bill.status !== "PAID" ? (
                      <button
                        className="button button-secondary"
                        onClick={() => setPayBill(bill)}
                      >
                        <Banknote size={14} />
                        Pay
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No supplier bills"
              detail="Bills are created automatically when an approved purchase order is received."
            />
          )}
          {payables.payments.length ? (
            <div className="recent-supplier-payments">
              <span className="eyebrow">RECENT PAYMENTS</span>
              {payables.payments.slice(0, 8).map((payment) => (
                <div key={payment._id}>
                  <CheckCircle2 />
                  <span>
                    <strong>
                      {payment.paymentNo} · {payment.supplierName}
                    </strong>
                    <small>
                      {payment.reference} ·{" "}
                      {dateOnly.format(new Date(payment.paidAt))}
                    </small>
                  </span>
                  <b>
                    {currencyFormatter(profile.locale, payment.currency).format(
                      payment.amount,
                    )}
                  </b>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      )}

      <Modal
        open={supplierOpen}
        onClose={() => {
          setSupplierOpen(false);
          setEditingSupplier(null);
        }}
        title={
          editingSupplier ? `Edit ${editingSupplier.name}` : "New supplier"
        }
        kicker="SUPPLIER MASTER"
      >
        <form
          className="modal-form wide-form"
          onSubmit={saveSupplier}
          key={editingSupplier?._id || "new-supplier"}
        >
          <div className="form-grid three">
            <label className="field">
              <span>Supplier code</span>
              <input
                name="code"
                defaultValue={editingSupplier?.code}
                pattern="[A-Za-z0-9_-]+"
                required
                autoFocus
              />
            </label>
            <label className="field">
              <span>Supplier name</span>
              <input
                name="name"
                defaultValue={editingSupplier?.name}
                required
              />
            </label>
            <label className="field">
              <span>Contact person</span>
              <input
                name="contactName"
                defaultValue={editingSupplier?.contactName}
              />
            </label>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Registration no.</span>
              <input
                name="registrationNo"
                defaultValue={editingSupplier?.registrationNo}
              />
            </label>
            <label className="field">
              <span>Tax no.</span>
              <input name="taxNo" defaultValue={editingSupplier?.taxNo} />
            </label>
            <label className="field">
              <span>Country</span>
              <select
                name="countryCode"
                defaultValue={
                  editingSupplier?.countryCode || profile.countryCode
                }
              >
                {COUNTRY_PROFILES.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Email</span>
              <input
                name="email"
                type="email"
                defaultValue={editingSupplier?.email}
              />
            </label>
            <label className="field">
              <span>Phone</span>
              <input name="phone" defaultValue={editingSupplier?.phone} />
            </label>
            <label className="field">
              <span>Supplier currency</span>
              <select
                name="currency"
                defaultValue={editingSupplier?.currency || profile.currency}
              >
                {CURRENCY_OPTIONS.map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Address</span>
            <textarea
              name="address"
              rows={2}
              defaultValue={editingSupplier?.address}
            />
          </label>
          <div className="form-grid three">
            <label className="field">
              <span>Payment terms · days</span>
              <input
                name="paymentTermsDays"
                type="number"
                min="0"
                max="365"
                defaultValue={editingSupplier?.paymentTermsDays ?? 30}
                required
              />
            </label>
            <label className="field">
              <span>Lead time · days</span>
              <input
                name="leadTimeDays"
                type="number"
                min="0"
                max="365"
                defaultValue={editingSupplier?.leadTimeDays ?? 7}
                required
              />
            </label>
            <label className="field">
              <span>Minimum order</span>
              <input
                name="minimumOrder"
                type="number"
                min="0"
                step="0.01"
                defaultValue={editingSupplier?.minimumOrder ?? 0}
                required
              />
            </label>
          </div>
          <label className="field">
            <span>Internal notes</span>
            <textarea
              name="notes"
              rows={3}
              defaultValue={editingSupplier?.notes}
            />
          </label>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setSupplierOpen(false);
                setEditingSupplier(null);
              }}
            >
              Cancel
            </button>
            <button className="button button-primary" disabled={busy}>
              {busy
                ? "Saving…"
                : editingSupplier
                  ? "Save supplier"
                  : "Create supplier"}
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        title="Draft purchase order"
        kicker="CONTROLLED COMMITMENT"
      >
        <form className="modal-form wide-form" onSubmit={createOrder}>
          <div className="purchase-draft-top">
            <div className="form-grid three">
              <label className="field">
                <span>Supplier</span>
                <select
                  value={supplierId}
                  onChange={(event) => chooseSupplier(event.target.value)}
                  required
                >
                  <option value="">Choose supplier</option>
                  {activeSuppliers.map((supplier) => (
                    <option key={supplier._id} value={supplier._id}>
                      {supplier.code} · {supplier.name} · {supplier.currency}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Receiving location</span>
                <select
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                  required
                >
                  <option value="">Choose location</option>
                  {purchase.locations.map((location) => (
                    <option key={location._id} value={location._id}>
                      {location.code} · {location.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Expected date</span>
                <input
                  type="date"
                  min={isoDate(profile.timeZone)}
                  value={expectedDate}
                  onChange={(event) => setExpectedDate(event.target.value)}
                  required
                />
              </label>
            </div>
            <button
              type="button"
              className="smart-reorder-button"
              onClick={applySmartReorder}
            >
              <Sparkles />
              <span>
                <strong>Build from replenishment queue</strong>
                <small>
                  {purchase.reorderSuggestions.length} low-stock recommendations
                  use recent 30-day demand
                </small>
              </span>
            </button>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Supplier reference</span>
              <input
                name="supplierReference"
                placeholder="Quotation or contract"
              />
            </label>
            <label className="field">
              <span>{purchase.business.taxName} rate</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={taxRate}
                onChange={(event) => setTaxRate(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Tax mode</span>
              <select
                value={taxMode}
                onChange={(event) =>
                  setTaxMode(event.target.value as "EXCLUSIVE" | "INCLUSIVE")
                }
              >
                <option value="EXCLUSIVE">Added to supplier prices</option>
                <option value="INCLUSIVE">Included in supplier prices</option>
              </select>
            </label>
          </div>
          <div className="purchase-line-editor">
            <header>
              <span>Product</span>
              <span>Quantity</span>
              <span>Unit cost · {selectedSupplier?.currency || "—"}</span>
              <span>Line total</span>
              <span />
            </header>
            {draftLines.map((line, index) => (
              <div key={index}>
                <select
                  value={line.productId}
                  onChange={(event) => {
                    const product = purchase.products.find(
                      (item) => item._id === event.target.value,
                    );
                    updateDraftLine(index, {
                      productId: event.target.value,
                      unitCost: supplierCost(product),
                    });
                  }}
                  required
                >
                  <option value="">Choose product</option>
                  {purchase.products.map((product) => (
                    <option key={product._id} value={product._id}>
                      {product.sku} · {product.name} · stock {product.stock}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={line.quantity}
                  onChange={(event) =>
                    updateDraftLine(index, {
                      quantity: Number(event.target.value),
                    })
                  }
                  required
                />
                <input
                  type="number"
                  min={currencyStep(
                    selectedSupplier?.currency || profile.currency,
                  )}
                  step={currencyStep(
                    selectedSupplier?.currency || profile.currency,
                  )}
                  value={line.unitCost || ""}
                  onChange={(event) =>
                    updateDraftLine(index, {
                      unitCost: Number(event.target.value),
                    })
                  }
                  required
                />
                <strong>
                  {orderMoney.format(
                    Number(line.quantity || 0) * Number(line.unitCost || 0),
                  )}
                </strong>
                <button
                  type="button"
                  disabled={draftLines.length === 1}
                  onClick={() =>
                    setDraftLines((current) =>
                      current.filter((_, lineIndex) => lineIndex !== index),
                    )
                  }
                >
                  <XCircle size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="add-line"
              onClick={() =>
                setDraftLines((current) => [
                  ...current,
                  { productId: "", quantity: 1, unitCost: 0 },
                ])
              }
            >
              <Plus size={15} />
              Add product
            </button>
          </div>
          <label className="field">
            <span>Internal purchasing notes</span>
            <textarea name="notes" rows={3} />
          </label>
          <div className="purchase-draft-total">
            <span>Supplier subtotal · tax is calculated on save</span>
            <strong>{orderMoney.format(draftSubtotal)}</strong>
          </div>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setOrderOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !supplierId || !locationId || !draftSubtotal}
            >
              <FilePlus2 size={16} />
              {busy ? "Creating…" : "Create draft"}
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={Boolean(receiveOrder)}
        onClose={() => setReceiveOrder(null)}
        title={`Receive ${receiveOrder?.purchaseOrderNo || "order"}`}
        kicker="GOODS RECEIPT + AP"
      >
        <form className="modal-form wide-form" onSubmit={receive}>
          <div className="receipt-control-note">
            <Truck />
            <span>
              <strong>Only enter quantities physically received</strong>
              <small>
                Posting updates stock, weighted cost, supplier performance, the
                AP bill and general ledger together.
              </small>
            </span>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Supplier invoice no.</span>
              <input name="supplierInvoiceNo" required autoFocus />
            </label>
            <label className="field">
              <span>Supplier invoice date</span>
              <input
                name="invoiceDate"
                type="date"
                defaultValue={isoDate(profile.timeZone)}
                required
              />
            </label>
            <label className="field">
              <span>Received date</span>
              <input
                name="receivedAt"
                type="date"
                defaultValue={isoDate(profile.timeZone)}
                required
              />
            </label>
          </div>
          <div className="receive-lines">
            <header>
              <span>Product</span>
              <span>Ordered</span>
              <span>Already received</span>
              <span>Receive now</span>
            </header>
            {receiveOrder?.items.map((line) => {
              const outstanding =
                line.quantity - Number(line.receivedQuantity || 0);
              return (
                <label key={line.productId}>
                  <span>
                    <strong>{line.productName}</strong>
                    <small>{line.sku}</small>
                  </span>
                  <b>
                    {line.quantity} {line.unit}
                  </b>
                  <b>
                    {line.receivedQuantity || 0} {line.unit}
                  </b>
                  <input
                    aria-label={`${line.productName} received quantity`}
                    type="number"
                    min="0"
                    max={outstanding}
                    step="1"
                    value={receiveCounts[line.productId] || ""}
                    onChange={(event) =>
                      setReceiveCounts((current) => ({
                        ...current,
                        [line.productId]: event.target.value,
                      }))
                    }
                    placeholder={`0 / ${outstanding}`}
                    disabled={!outstanding}
                  />
                </label>
              );
            })}
          </div>
          <label className="field">
            <span>Receiving note</span>
            <textarea
              name="notes"
              rows={2}
              placeholder="Carton condition, delivery docket or discrepancy"
            />
          </label>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setReceiveOrder(null)}
            >
              Cancel
            </button>
            <button className="button button-primary" disabled={busy}>
              {busy ? "Posting receipt…" : "Post goods receipt"}
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={Boolean(payBill)}
        onClose={() => setPayBill(null)}
        title={`Pay ${payBill?.billNo || "supplier bill"}`}
        kicker="AP SETTLEMENT"
      >
        <form className="modal-form" onSubmit={pay}>
          <div className="payable-proof">
            <WalletCards />
            <span>
              <strong>{payBill?.supplierName}</strong>
              <small>
                {payBill?.supplierInvoiceNo} · balance{" "}
                {payBill
                  ? currencyFormatter(profile.locale, payBill.currency).format(
                      payBill.balance,
                    )
                  : ""}
              </small>
            </span>
          </div>
          <label className="field">
            <span>Payment amount · {payBill?.currency}</span>
            <input
              name="amount"
              type="number"
              min={currencyStep(payBill?.currency || profile.currency)}
              max={payBill?.balance}
              step={currencyStep(payBill?.currency || profile.currency)}
              defaultValue={payBill?.balance}
              required
            />
          </label>
          <label className="field">
            <span>Pay from</span>
            <select name="paymentAccountCode" required>
              <option value="">Choose cash or bank account</option>
              {payables.accounts.map((account) => (
                <option key={account._id} value={account.code}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid two">
            <label className="field">
              <span>Payment reference</span>
              <input
                name="reference"
                required
                placeholder="Bank transaction no."
              />
            </label>
            <label className="field">
              <span>Payment date</span>
              <input
                name="paidAt"
                type="date"
                defaultValue={isoDate(profile.timeZone)}
                required
              />
            </label>
          </div>
          <label className="field">
            <span>Payment note</span>
            <textarea name="notes" rows={2} />
          </label>
          <p className="form-hint">
            Foreign-currency bills use the active rate at payment time. Any
            difference from the receipt rate is posted automatically to exchange
            gain or loss.
          </p>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setPayBill(null)}
            >
              Cancel
            </button>
            <button className="button button-primary" disabled={busy}>
              <Banknote size={16} />
              {busy ? "Posting payment…" : "Post payment"}
            </button>
          </footer>
        </form>
      </Modal>
    </div>
  );
}
