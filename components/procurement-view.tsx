"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Banknote,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Download,
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
import { csvCell, downloadReceiptFile } from "@/lib/receipt-export";
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
  batchTracked?: boolean;
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
type RequisitionLine = {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: number;
};
type PurchaseRequisition = {
  _id: string;
  requisitionNo: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  requiredDate: string;
  priority: "NORMAL" | "URGENT";
  justification: string;
  notes: string;
  items: RequisitionLine[];
  suggestedSupplierId?: string | null;
  suggestedSupplierCode?: string;
  suggestedSupplierName?: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED" | "CONVERTED";
  version: number;
  createdBy?: string;
  createdByName: string;
  createdAt: string;
  approvedByName?: string;
  rejectionReason?: string;
  cancellationReason?: string;
  convertedPurchaseOrderNo?: string;
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
  daysOverdue: number;
  bucket: "CURRENT" | "1_30" | "31_60" | "61_90" | "90_PLUS";
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
  aging: {
    asOf: string;
    openBillCount: number;
    totalBase: number;
    overdueBase: number;
    dueNext7DaysBase: number;
    buckets: Record<Bill["bucket"], { count: number; baseAmount: number }>;
  };
  supplierAging: Array<{
    supplierId: string;
    supplierName: string;
    billCount: number;
    totalBase: number;
    overdueBase: number;
    oldestDaysOverdue: number;
  }>;
};
type ExchangeData = {
  baseCurrency: string;
  rates: Array<{ quoteCurrency: string; rate: number }>;
};
type DraftLine = { productId: string; quantity: number; unitCost: number };
type RequisitionDraftLine = { productId: string; quantity: number };

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
  const [tab, setTab] = useState<"REQUISITIONS" | "ORDERS" | "SUPPLIERS" | "PAYABLES">("REQUISITIONS");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [requisitions, setRequisitions] = useState<PurchaseRequisition[]>([]);
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
    aging: {
      asOf: isoDate(profile.timeZone),
      openBillCount: 0,
      totalBase: 0,
      overdueBase: 0,
      dueNext7DaysBase: 0,
      buckets: {
        CURRENT: { count: 0, baseAmount: 0 },
        "1_30": { count: 0, baseAmount: 0 },
        "31_60": { count: 0, baseAmount: 0 },
        "61_90": { count: 0, baseAmount: 0 },
        "90_PLUS": { count: 0, baseAmount: 0 },
      },
    },
    supplierAging: [],
  });
  const [exchange, setExchange] = useState<ExchangeData>({
    baseCurrency: profile.currency,
    rates: [],
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [supplierOpen, setSupplierOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [requisitionOpen, setRequisitionOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [receiveOrder, setReceiveOrder] = useState<PurchaseOrder | null>(null);
  const [payBill, setPayBill] = useState<Bill | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [sourceRequisitionId, setSourceRequisitionId] = useState("");
  const [requisitionLocationId, setRequisitionLocationId] = useState("");
  const [requisitionSupplierId, setRequisitionSupplierId] = useState("");
  const [requisitionRequiredDate, setRequisitionRequiredDate] = useState(isoDate(profile.timeZone, 7));
  const [requisitionLines, setRequisitionLines] = useState<RequisitionDraftLine[]>([{ productId: "", quantity: 1 }]);
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
  const [receiveLots, setReceiveLots] = useState<Record<string, { lotNo: string; expiryDate: string }>>({});
  const { notice, show } = useNotice();

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const [supplierData, purchaseData, payableData, exchangeData, requisitionData] =
        await Promise.all([
          apiRequest<Supplier[]>(
            `/api/suppliers${canWrite ? "?includeArchived=1" : ""}`,
          ),
          apiRequest<PurchaseBundle>("/api/purchase-orders"),
          apiRequest<PayablesBundle>("/api/accounts-payable"),
          apiRequest<ExchangeData>("/api/exchange-rates"),
          apiRequest<PurchaseRequisition[]>("/api/purchase-requisitions"),
        ]);
      setSuppliers(supplierData);
      setPurchase(purchaseData);
      setPayables(payableData);
      setExchange(exchangeData);
      setRequisitions(requisitionData);
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
    setSourceRequisitionId("");
    setSupplierId(supplier?._id || "");
    setLocationId(purchase.locations[0]?._id || "");
    setExpectedDate(isoDate(profile.timeZone, supplier?.leadTimeDays || 7));
    setTaxRate(purchase.business.taxRate);
    setTaxMode(purchase.business.taxMode);
    setDraftLines([{ productId: "", quantity: 1, unitCost: 0 }]);
    setOrderOpen(true);
  }

  function beginRequisition() {
    setRequisitionLocationId(purchase.locations[0]?._id || "");
    setRequisitionSupplierId("");
    setRequisitionRequiredDate(isoDate(profile.timeZone, 7));
    setRequisitionLines([{ productId: "", quantity: 1 }]);
    setRequisitionOpen(true);
  }

  async function createRequisition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/purchase-requisitions", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          locationId: requisitionLocationId,
          suggestedSupplierId: requisitionSupplierId,
          requiredDate: requisitionRequiredDate,
          priority: data.get("priority"),
          justification: data.get("justification"),
          notes: data.get("notes"),
          items: requisitionLines,
        }),
      });
      show("Purchase requisition submitted for approval.");
      setRequisitionOpen(false);
      await load(false);
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not submit the purchase requisition.", "error");
    } finally { setBusy(false); }
  }

  async function requisitionAction(requisition: PurchaseRequisition, action: "APPROVE" | "REJECT" | "CANCEL") {
    const reason = action === "REJECT"
      ? window.prompt("Reason for rejecting this purchase requisition:")?.trim()
      : action === "CANCEL"
        ? window.prompt("Reason for cancelling this purchase requisition:")?.trim()
        : "";
    if ((action === "REJECT" || action === "CANCEL") && !reason) return;
    if (reason && reason.length < 3) {
      show("Please enter at least three characters of review evidence.", "error");
      return;
    }
    setBusy(true);
    try {
      await apiRequest("/api/purchase-requisitions", {
        method: "PATCH",
        body: JSON.stringify({ id: requisition._id, expectedVersion: requisition.version, action, ...(reason ? { reason } : {}) }),
      });
      show(action === "APPROVE" ? "Purchase requisition approved." : action === "REJECT" ? "Purchase requisition rejected with evidence." : "Purchase requisition cancelled.");
      await load(false);
    } catch (reasonValue) {
      show(reasonValue instanceof Error ? reasonValue.message : "Could not update the purchase requisition.", "error");
    } finally { setBusy(false); }
  }

  function beginOrderFromRequisition(requisition: PurchaseRequisition) {
    const supplier = activeSuppliers.find((item) => item._id === requisition.suggestedSupplierId) || activeSuppliers[0];
    setSourceRequisitionId(requisition._id);
    setSupplierId(supplier?._id || "");
    setLocationId(requisition.locationId);
    setExpectedDate(requisition.requiredDate.slice(0, 10) < isoDate(profile.timeZone) ? isoDate(profile.timeZone) : requisition.requiredDate.slice(0, 10));
    setTaxRate(purchase.business.taxRate);
    setTaxMode(purchase.business.taxMode);
    setDraftLines(requisition.items.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitCost: supplierCost(purchase.products.find((product) => product._id === line.productId), supplier),
    })));
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
          ...(sourceRequisitionId ? { sourceRequisitionId } : {}),
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
      setSourceRequisitionId("");
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
    action: "APPROVE" | "CANCEL" | "CLOSE_SHORT",
  ) {
    const reason =
      action === "CANCEL" || action === "CLOSE_SHORT"
        ? window.prompt(action === "CLOSE_SHORT"
            ? "Reason for closing the unreceived balance:"
            : "Reason for cancelling this purchase order:")?.trim()
        : "";
    if ((action === "CANCEL" || action === "CLOSE_SHORT") && !reason) return;
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
          : action === "CLOSE_SHORT"
            ? "Outstanding quantities closed with a permanent audit reason."
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
    setReceiveLots({});
  }

  async function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!receiveOrder) return;
    const lines = receiveOrder.items
      .map((line) => {
        const batchTracked = purchase.products.find((product) => product._id === line.productId)?.batchTracked;
        return {
          productId: line.productId,
          quantity: Number(receiveCounts[line.productId] || 0),
          ...(batchTracked ? { lotNo: receiveLots[line.productId]?.lotNo || "", expiryDate: receiveLots[line.productId]?.expiryDate || "" } : {}),
        };
      })
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

  function exportPayableAging() {
    const rows = [
      ["As of", "Bill", "Purchase order", "Supplier", "Supplier invoice", "Invoice date", "Due date", "Currency", "Original total", "Open balance", `Open balance (${profile.currency})`, "Days overdue", "Age bucket", "Status"],
      ...payables.bills
        .filter((bill) => bill.status !== "PAID" && Number(bill.baseBalance || 0) > 0)
        .map((bill) => [payables.aging.asOf, bill.billNo, bill.purchaseOrderNo, bill.supplierName, bill.supplierInvoiceNo, bill.invoiceDate.slice(0, 10), bill.dueDate.slice(0, 10), bill.currency, bill.total, bill.balance, bill.baseBalance, bill.daysOverdue, bill.bucket, bill.displayStatus]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    downloadReceiptFile(csv, "text/csv;charset=utf-8", `accounts-payable-aging-${payables.aging.asOf}.csv`);
  }

  return (
    <div className="page page-enter procurement-page">
      <PageHeader
        eyebrow="PURCHASE-TO-PAY"
        title="Purchasing & payables"
        description="Plan replenishment, approve commitments, receive stock and settle supplier bills without breaking the audit trail."
        action={
          canWrite ? (
            <div className="row-actions">
              <button className="button button-secondary" onClick={beginOrder}><FilePlus2 size={16} />New purchase order</button>
              <AddButton onClick={beginRequisition}>New requisition</AddButton>
            </div>
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
          className={tab === "REQUISITIONS" ? "active" : ""}
          onClick={() => setTab("REQUISITIONS")}
        >
          Requisitions
        </button>
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
      ) : tab === "REQUISITIONS" ? (
        <section className="panel procurement-ledger">
          <div className="panel-header">
            <div><span className="eyebrow">REQUEST TO BUY</span><h2>Purchase requisitions</h2></div>
            {canWrite ? <AddButton onClick={beginRequisition}>New requisition</AddButton> : null}
          </div>
          {requisitions.length ? <div className="requisition-list">
            {requisitions.map((requisition) => {
              const makerCanApprove = allowSelfApproval || !requisition.createdBy || requisition.createdBy !== currentUserId;
              return <article key={requisition._id} className={requisition.priority === "URGENT" && requisition.status === "SUBMITTED" ? "urgent" : ""}>
                <header>
                  <div className="requisition-stamp"><FilePlus2 /></div>
                  <span><strong>{requisition.requisitionNo}</strong><small>{requisition.createdByName} · {shortDate.format(new Date(requisition.createdAt))}</small></span>
                  <span><small>REQUIRED</small><strong>{dateOnly.format(new Date(requisition.requiredDate))}</strong></span>
                  <span><small>DESTINATION</small><strong>{requisition.locationCode} · {requisition.locationName}</strong></span>
                  <span><small>PRIORITY</small><strong>{requisition.priority}</strong></span>
                  <StatusPill value={requisition.status} />
                </header>
                <div className="requisition-body">
                  <div><span className="eyebrow">BUSINESS JUSTIFICATION</span><p>{requisition.justification}</p>{requisition.notes ? <small>{requisition.notes}</small> : null}</div>
                  <div className="requisition-items">{requisition.items.map((line) => <span key={line.productId}><strong>{line.sku} · {line.productName}</strong><b>{line.quantity} {line.unit}</b></span>)}</div>
                  <footer>
                    <span>{requisition.suggestedSupplierName ? `Suggested supplier · ${requisition.suggestedSupplierCode} · ${requisition.suggestedSupplierName}` : "Supplier to be selected during purchase-order preparation"}{requisition.convertedPurchaseOrderNo ? ` · Converted to ${requisition.convertedPurchaseOrderNo}` : ""}{requisition.rejectionReason ? ` · Rejected: ${requisition.rejectionReason}` : ""}{requisition.cancellationReason ? ` · Cancelled: ${requisition.cancellationReason}` : ""}</span>
                    <div className="row-actions">
                      {canWrite && requisition.status === "SUBMITTED" ? <button className="button button-quiet" disabled={busy} onClick={() => void requisitionAction(requisition, "CANCEL")}><XCircle size={14} />Cancel</button> : null}
                      {canApprove && makerCanApprove && requisition.status === "SUBMITTED" ? <><button className="button button-quiet" disabled={busy} onClick={() => void requisitionAction(requisition, "REJECT")}><XCircle size={14} />Reject</button><button className="button button-secondary" disabled={busy} onClick={() => void requisitionAction(requisition, "APPROVE")}><ClipboardCheck size={14} />Approve</button></> : null}
                      {canWrite && requisition.status === "APPROVED" ? <button className="button button-primary" disabled={busy} onClick={() => beginOrderFromRequisition(requisition)}><FilePlus2 size={14} />Create purchase order</button> : null}
                    </div>
                  </footer>
                </div>
              </article>;
            })}
          </div> : <EmptyState title="No purchase requisitions" detail="Submit an internal request for products before committing to a supplier purchase order." action={canWrite ? <AddButton onClick={beginRequisition}>New requisition</AddButton> : undefined} />}
        </section>
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
                          {canWrite && order.status === "PARTIALLY_RECEIVED" ? (
                            <button
                              className="button button-quiet"
                              onClick={() => void orderAction(order, "CLOSE_SHORT")}
                            >
                              <XCircle size={15} />
                              Close remainder
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
            <button className="button button-secondary" onClick={exportPayableAging} disabled={!payables.aging.openBillCount}>
              <Download size={15} />
              Export aging CSV
            </button>
          </div>
          <div className="payable-aging-summary" aria-label={`Accounts payable aging as of ${payables.aging.asOf}`}>
            {([
              ["CURRENT", "Current"],
              ["1_30", "1–30 days"],
              ["31_60", "31–60 days"],
              ["61_90", "61–90 days"],
              ["90_PLUS", "Over 90 days"],
            ] as const).map(([key, label]) => (
              <article key={key} className={key !== "CURRENT" && payables.aging.buckets[key].baseAmount ? "overdue" : ""}>
                <span>{label}</span>
                <strong>{money.format(payables.aging.buckets[key].baseAmount)}</strong>
                <small>{payables.aging.buckets[key].count} open bill{payables.aging.buckets[key].count === 1 ? "" : "s"}</small>
              </article>
            ))}
          </div>
          <div className="payable-aging-meta">
            <span>As of <strong>{payables.aging.asOf}</strong></span>
            <span>Due in the next 7 days <strong>{money.format(payables.aging.dueNext7DaysBase)}</strong></span>
            <span>Overdue exposure <strong>{money.format(payables.aging.overdueBase)}</strong></span>
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
                    {bill.daysOverdue > 0 ? <small>{bill.daysOverdue}d overdue</small> : null}
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
          {payables.supplierAging.length ? (
            <div className="supplier-aging-list">
              <span className="eyebrow">SUPPLIER EXPOSURE</span>
              {payables.supplierAging.slice(0, 8).map((supplier) => (
                <div key={supplier.supplierId}>
                  <span><strong>{supplier.supplierName}</strong><small>{supplier.billCount} open bill{supplier.billCount === 1 ? "" : "s"}{supplier.oldestDaysOverdue ? ` · oldest ${supplier.oldestDaysOverdue}d overdue` : ""}</small></span>
                  <span><small>Total</small><strong>{money.format(supplier.totalBase)}</strong></span>
                  <span className={supplier.overdueBase ? "danger-text" : ""}><small>Overdue</small><strong>{money.format(supplier.overdueBase)}</strong></span>
                </div>
              ))}
            </div>
          ) : null}
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
        open={requisitionOpen}
        onClose={() => setRequisitionOpen(false)}
        title="New purchase requisition"
        kicker="INTERNAL REQUEST · MAKER-CHECKER"
      >
        <form className="modal-form wide-form" onSubmit={createRequisition}>
          <div className="receipt-control-note">
            <ClipboardCheck />
            <span><strong>Request first, commit after approval</strong><small>The approved location, products and quantities are locked into the converted purchase order.</small></span>
          </div>
          <div className="form-grid three">
            <label className="field"><span>Receiving location</span><select value={requisitionLocationId} onChange={(event) => setRequisitionLocationId(event.target.value)} required><option value="">Choose location</option>{purchase.locations.map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label>
            <label className="field"><span>Suggested supplier · optional</span><select value={requisitionSupplierId} onChange={(event) => setRequisitionSupplierId(event.target.value)}><option value="">Select during purchase order</option>{activeSuppliers.map((supplier) => <option key={supplier._id} value={supplier._id}>{supplier.code} · {supplier.name}</option>)}</select></label>
            <label className="field"><span>Required date</span><input type="date" min={isoDate(profile.timeZone)} value={requisitionRequiredDate} onChange={(event) => setRequisitionRequiredDate(event.target.value)} required /></label>
          </div>
          <div className="form-grid two">
            <label className="field"><span>Priority</span><select name="priority" defaultValue="NORMAL"><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option></select></label>
            <label className="field"><span>Business justification</span><input name="justification" minLength={3} maxLength={500} required placeholder="Why these products are needed" /></label>
          </div>
          <div className="requisition-line-editor">
            <header><span>Product</span><span>Requested quantity</span><span /></header>
            {requisitionLines.map((line, index) => <div key={index}>
              <select value={line.productId} onChange={(event) => setRequisitionLines((current) => current.map((item, lineIndex) => lineIndex === index ? { ...item, productId: event.target.value } : item))} required><option value="">Choose product</option>{purchase.products.map((product) => <option key={product._id} value={product._id}>{product.sku} · {product.name} · stock {product.stock}</option>)}</select>
              <input type="number" min="1" max="1000000" step="1" value={line.quantity} onChange={(event) => setRequisitionLines((current) => current.map((item, lineIndex) => lineIndex === index ? { ...item, quantity: Number(event.target.value) } : item))} required />
              <button type="button" disabled={requisitionLines.length === 1} onClick={() => setRequisitionLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}><XCircle size={15} /></button>
            </div>)}
            <button type="button" className="add-line" onClick={() => setRequisitionLines((current) => [...current, { productId: "", quantity: 1 }])}><Plus size={15} />Add product</button>
          </div>
          <label className="field"><span>Request notes</span><textarea name="notes" rows={3} maxLength={500} placeholder="Specification, preferred pack size or operational context" /></label>
          <footer><button type="button" className="button button-secondary" onClick={() => setRequisitionOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy || !requisitionLocationId}>{busy ? "Submitting…" : "Submit for approval"}</button></footer>
        </form>
      </Modal>

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
          {sourceRequisitionId ? <div className="receipt-control-note"><ClipboardCheck /><span><strong>Converting an approved requisition</strong><small>Destination, products and quantities are locked. Select the supplier, confirm costs and create the purchase-order draft.</small></span></div> : null}
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
                  disabled={Boolean(sourceRequisitionId)}
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
            {!sourceRequisitionId ? (
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
            ) : null}
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
                  disabled={Boolean(sourceRequisitionId)}
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
                  disabled={Boolean(sourceRequisitionId)}
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
                  hidden={Boolean(sourceRequisitionId)}
                >
                  <XCircle size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="add-line"
              hidden={Boolean(sourceRequisitionId)}
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
              <span>Supplier lot</span>
              <span>Expiry</span>
            </header>
            {receiveOrder?.items.map((line) => {
              const outstanding =
                line.quantity - Number(line.receivedQuantity || 0);
              const batchTracked = purchase.products.find((product) => product._id === line.productId)?.batchTracked === true;
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
                  {batchTracked ? <input
                    aria-label={`${line.productName} supplier lot`}
                    value={receiveLots[line.productId]?.lotNo || ""}
                    onChange={(event) => setReceiveLots((current) => ({ ...current, [line.productId]: { lotNo: event.target.value, expiryDate: current[line.productId]?.expiryDate || "" } }))}
                    placeholder="Lot / batch no."
                    required={Number(receiveCounts[line.productId] || 0) > 0}
                    disabled={!outstanding}
                  /> : <small>Not tracked</small>}
                  {batchTracked ? <input
                    aria-label={`${line.productName} expiry date`}
                    type="date"
                    min={isoDate(profile.timeZone, 1)}
                    value={receiveLots[line.productId]?.expiryDate || ""}
                    onChange={(event) => setReceiveLots((current) => ({ ...current, [line.productId]: { lotNo: current[line.productId]?.lotNo || "", expiryDate: event.target.value } }))}
                    required={Number(receiveCounts[line.productId] || 0) > 0}
                    disabled={!outstanding}
                  /> : <small>—</small>}
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
