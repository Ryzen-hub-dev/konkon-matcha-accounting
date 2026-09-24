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
import { EInvoiceGenerator } from "@/components/e-invoice-generator";
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
import { calculateTaxTotals } from "@/lib/tax";
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
  taxRate: number;
  taxMode: "EXCLUSIVE" | "INCLUSIVE";
  total: number;
  baseTotal: number;
  status: string;
  isOverdue?: boolean;
  createdAt: string;
  createdBy?: string;
};
type PurchaseMatchException = {
  _id: string;
  purchaseOrderId: string;
  purchaseOrderNo: string;
  supplierInvoiceNo: string;
  currency: string;
  expectedTotal: number;
  expectedTax: number;
  invoiceTotal: number;
  invoiceTax: number;
  totalVariance: number;
  taxVariance: number;
  requestNote: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED";
  version: number;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  reviewNote?: string;
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
  status:
    | "SUBMITTED"
    | "APPROVED"
    | "SOURCING"
    | "REJECTED"
    | "CANCELLED"
    | "CONVERTED";
  version: number;
  createdBy?: string;
  createdByName: string;
  createdAt: string;
  approvedByName?: string;
  rejectionReason?: string;
  cancellationReason?: string;
  sourceRfqNo?: string;
  convertedPurchaseOrderNo?: string;
};
type SupplierQuote = {
  _id: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  currency: string;
  supplierReference: string;
  expectedDeliveryDate: string;
  notes: string;
  items: Array<RequisitionLine & { unitCost: number; lineTotal: number }>;
  subtotal: number;
  baseCurrency: string;
  baseSubtotal: number;
  recordedByName: string;
  recordedAt: string;
};
type RequestForQuotation = {
  _id: string;
  rfqNo: string;
  sourceRequisitionId: string;
  sourceRequisitionNo: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  requiredDate: string;
  justification: string;
  items: RequisitionLine[];
  invitedSuppliers: Array<{
    supplierId: string;
    supplierCode: string;
    supplierName: string;
    currency: string;
  }>;
  responseDueDate: string;
  notes: string;
  quotes: SupplierQuote[];
  status: "OPEN" | "AWARDED" | "CANCELLED" | "CONVERTED";
  version: number;
  createdBy?: string;
  createdByName: string;
  createdAt: string;
  winningQuoteId?: string;
  awardReason?: string;
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
  matchExceptions: PurchaseMatchException[];
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
  goodsReceiptId: string;
  receiptNo?: string;
  billType?: "PURCHASE_RECEIPT" | "LANDED_COST";
  billNo: string;
  supplierId: string;
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
  creditedAmount?: number;
  status: string;
  displayStatus: string;
  daysOverdue: number;
  bucket: "CURRENT" | "1_30" | "31_60" | "61_90" | "90_PLUS";
  updatedAt: string;
};
type PurchaseReturnLine = {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: number;
  returnedQuantity: number;
  returnableQuantity: number;
  availableStock: number;
  batchTracked: boolean;
  lotNo?: string;
  expiryDate?: string;
};
type PurchaseReturnDetail = {
  bill: Bill;
  receipt: {
    _id: string;
    receiptNo: string;
    receivedAt: string;
    locationName: string;
    items: PurchaseReturnLine[];
  };
  returns: Array<{
    _id: string;
    returnNo: string;
    supplierCreditNo: string;
    supplierTotal: number;
    returnedAt: string;
  }>;
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
  const [tab, setTab] = useState<
    "REQUISITIONS" | "RFQS" | "ORDERS" | "SUPPLIERS" | "PAYABLES"
  >("REQUISITIONS");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [requisitions, setRequisitions] = useState<PurchaseRequisition[]>([]);
  const [rfqs, setRfqs] = useState<RequestForQuotation[]>([]);
  const [purchase, setPurchase] = useState<PurchaseBundle>({
    orders: [],
    matchExceptions: [],
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
  const [rfqOpen, setRfqOpen] = useState(false);
  const [rfqSource, setRfqSource] = useState<PurchaseRequisition | null>(null);
  const [rfqSupplierIds, setRfqSupplierIds] = useState<string[]>([]);
  const [rfqResponseDueDate, setRfqResponseDueDate] = useState(
    isoDate(profile.timeZone, 3),
  );
  const [quoteRfq, setQuoteRfq] = useState<RequestForQuotation | null>(null);
  const [quoteSupplierId, setQuoteSupplierId] = useState("");
  const [quoteExpectedDate, setQuoteExpectedDate] = useState(
    isoDate(profile.timeZone, 7),
  );
  const [quoteLines, setQuoteLines] = useState<
    Array<{ productId: string; unitCost: number }>
  >([]);
  const [orderOpen, setOrderOpen] = useState(false);
  const [receiveOrder, setReceiveOrder] = useState<PurchaseOrder | null>(null);
  const [payBill, setPayBill] = useState<Bill | null>(null);
  const [landedCostBill, setLandedCostBill] = useState<Bill | null>(null);
  const [landedCostSupplierId, setLandedCostSupplierId] = useState("");
  const [returnDetail, setReturnDetail] = useState<PurchaseReturnDetail | null>(
    null,
  );
  const [returnCounts, setReturnCounts] = useState<Record<string, string>>({});
  const [returnLoading, setReturnLoading] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [sourceRequisitionId, setSourceRequisitionId] = useState("");
  const [sourceRfqId, setSourceRfqId] = useState("");
  const [requisitionLocationId, setRequisitionLocationId] = useState("");
  const [requisitionSupplierId, setRequisitionSupplierId] = useState("");
  const [requisitionRequiredDate, setRequisitionRequiredDate] = useState(
    isoDate(profile.timeZone, 7),
  );
  const [requisitionLines, setRequisitionLines] = useState<
    RequisitionDraftLine[]
  >([{ productId: "", quantity: 1 }]);
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
  const [receiveLots, setReceiveLots] = useState<
    Record<string, { lotNo: string; expiryDate: string }>
  >({});
  const { notice, show } = useNotice();

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const [
        supplierData,
        purchaseData,
        payableData,
        exchangeData,
        requisitionData,
        rfqData,
      ] = await Promise.all([
        apiRequest<Supplier[]>(
          `/api/suppliers${canWrite ? "?includeArchived=1" : ""}`,
        ),
        apiRequest<PurchaseBundle>("/api/purchase-orders"),
        apiRequest<PayablesBundle>("/api/accounts-payable"),
        apiRequest<ExchangeData>("/api/exchange-rates"),
        apiRequest<PurchaseRequisition[]>("/api/purchase-requisitions"),
        apiRequest<RequestForQuotation[]>("/api/request-for-quotations"),
      ]);
      setSuppliers(supplierData);
      setPurchase(purchaseData);
      setPayables(payableData);
      setExchange(exchangeData);
      setRequisitions(requisitionData);
      setRfqs(rfqData);
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
  const selectedQuoteSupplier = activeSuppliers.find(
    (supplier) => supplier._id === quoteSupplierId,
  );
  const selectedLandedCostSupplier = activeSuppliers.find(
    (supplier) => supplier._id === landedCostSupplierId,
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
  const receiveExpected = useMemo(() => {
    if (!receiveOrder) return { netSales: 0, tax: 0, total: 0 };
    const subtotal = roundCurrency(
      receiveOrder.items.reduce(
        (sum, line) =>
          sum +
          Number(receiveCounts[line.productId] || 0) *
            Number(line.unitCost || 0),
        0,
      ),
      receiveOrder.currency,
    );
    return calculateTaxTotals(
      subtotal,
      0,
      Number(receiveOrder.taxRate || 0),
      receiveOrder.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE",
      receiveOrder.currency,
    );
  }, [receiveOrder, receiveCounts]);
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
    setSourceRfqId("");
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
      show(
        reason instanceof Error
          ? reason.message
          : "Could not submit the purchase requisition.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function requisitionAction(
    requisition: PurchaseRequisition,
    action: "APPROVE" | "REJECT" | "CANCEL",
  ) {
    const reason =
      action === "REJECT"
        ? window
            .prompt("Reason for rejecting this purchase requisition:")
            ?.trim()
        : action === "CANCEL"
          ? window
              .prompt("Reason for cancelling this purchase requisition:")
              ?.trim()
          : "";
    if ((action === "REJECT" || action === "CANCEL") && !reason) return;
    if (reason && reason.length < 3) {
      show(
        "Please enter at least three characters of review evidence.",
        "error",
      );
      return;
    }
    setBusy(true);
    try {
      await apiRequest("/api/purchase-requisitions", {
        method: "PATCH",
        body: JSON.stringify({
          id: requisition._id,
          expectedVersion: requisition.version,
          action,
          ...(reason ? { reason } : {}),
        }),
      });
      show(
        action === "APPROVE"
          ? "Purchase requisition approved."
          : action === "REJECT"
            ? "Purchase requisition rejected with evidence."
            : "Purchase requisition cancelled.",
      );
      await load(false);
    } catch (reasonValue) {
      show(
        reasonValue instanceof Error
          ? reasonValue.message
          : "Could not update the purchase requisition.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function beginOrderFromRequisition(requisition: PurchaseRequisition) {
    const supplier =
      activeSuppliers.find(
        (item) => item._id === requisition.suggestedSupplierId,
      ) || activeSuppliers[0];
    setSourceRequisitionId(requisition._id);
    setSourceRfqId("");
    setSupplierId(supplier?._id || "");
    setLocationId(requisition.locationId);
    setExpectedDate(
      requisition.requiredDate.slice(0, 10) < isoDate(profile.timeZone)
        ? isoDate(profile.timeZone)
        : requisition.requiredDate.slice(0, 10),
    );
    setTaxRate(purchase.business.taxRate);
    setTaxMode(purchase.business.taxMode);
    setDraftLines(
      requisition.items.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitCost: supplierCost(
          purchase.products.find((product) => product._id === line.productId),
          supplier,
        ),
      })),
    );
    setOrderOpen(true);
  }

  function beginRfq(requisition: PurchaseRequisition) {
    if (activeSuppliers.length < 2)
      return show(
        "Create at least two active suppliers before opening an RFQ.",
        "error",
      );
    const preferred = activeSuppliers.find(
      (supplier) => supplier._id === requisition.suggestedSupplierId,
    );
    const selected = [
      preferred,
      ...activeSuppliers.filter((supplier) => supplier._id !== preferred?._id),
    ]
      .filter(Boolean)
      .slice(0, 2) as Supplier[];
    const suggestedDeadline = isoDate(profile.timeZone, 3);
    const requiredDate = requisition.requiredDate.slice(0, 10);
    setRfqSource(requisition);
    setRfqSupplierIds(selected.map((supplier) => supplier._id));
    setRfqResponseDueDate(
      suggestedDeadline < requiredDate ? suggestedDeadline : requiredDate,
    );
    setRfqOpen(true);
  }

  function toggleRfqSupplier(id: string) {
    setRfqSupplierIds((current) =>
      current.includes(id)
        ? current.filter((supplierId) => supplierId !== id)
        : [...current, id],
    );
  }

  async function createRfq(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rfqSource) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/request-for-quotations", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          sourceRequisitionId: rfqSource._id,
          supplierIds: rfqSupplierIds,
          responseDueDate: rfqResponseDueDate,
          notes: data.get("notes"),
        }),
      });
      show("RFQ opened and the approved requisition moved into sourcing.");
      setRfqOpen(false);
      setRfqSource(null);
      setTab("RFQS");
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error ? reason.message : "Could not open the RFQ.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function chooseQuoteSupplier(rfq: RequestForQuotation, id: string) {
    const supplier = activeSuppliers.find((item) => item._id === id);
    setQuoteSupplierId(id);
    setQuoteExpectedDate(
      isoDate(profile.timeZone, supplier?.leadTimeDays || 7),
    );
    setQuoteLines(
      rfq.items.map((line) => ({
        productId: line.productId,
        unitCost: supplierCost(
          purchase.products.find((product) => product._id === line.productId),
          supplier,
        ),
      })),
    );
  }

  function beginQuote(rfq: RequestForQuotation) {
    const recorded = new Set(rfq.quotes.map((quote) => quote.supplierId));
    const supplier = activeSuppliers.find(
      (item) =>
        rfq.invitedSuppliers.some(
          (invited) => invited.supplierId === item._id,
        ) && !recorded.has(item._id),
    );
    if (!supplier)
      return show(
        "Every invited supplier already has a recorded quote.",
        "error",
      );
    setQuoteRfq(rfq);
    chooseQuoteSupplier(rfq, supplier._id);
  }

  async function submitQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quoteRfq) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/request-for-quotations", {
        method: "PATCH",
        body: JSON.stringify({
          id: quoteRfq._id,
          expectedVersion: quoteRfq.version,
          action: "SUBMIT_QUOTE",
          supplierId: quoteSupplierId,
          supplierReference: data.get("supplierReference"),
          expectedDeliveryDate: quoteExpectedDate,
          notes: data.get("notes"),
          items: quoteLines,
        }),
      });
      show("Supplier quote recorded with a base-currency comparison snapshot.");
      setQuoteRfq(null);
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not record the supplier quote.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function rfqAction(
    rfq: RequestForQuotation,
    action: "AWARD" | "CANCEL",
    quoteId = "",
  ) {
    const reason = window
      .prompt(
        action === "AWARD"
          ? "Reason for awarding this supplier quote:"
          : "Reason for cancelling this RFQ:",
      )
      ?.trim();
    if (!reason) return;
    if (reason.length < 3)
      return show(
        "Please enter at least three characters of decision evidence.",
        "error",
      );
    setBusy(true);
    try {
      await apiRequest("/api/request-for-quotations", {
        method: "PATCH",
        body: JSON.stringify({
          id: rfq._id,
          expectedVersion: rfq.version,
          action,
          reason,
          ...(quoteId ? { quoteId } : {}),
        }),
      });
      show(
        action === "AWARD"
          ? "Supplier quote awarded with decision evidence."
          : "RFQ cancelled and the requisition returned to approved status.",
      );
      await load(false);
    } catch (reasonValue) {
      show(
        reasonValue instanceof Error
          ? reasonValue.message
          : "Could not update the RFQ.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function beginOrderFromRfq(rfq: RequestForQuotation) {
    const quote = rfq.quotes.find((item) => item._id === rfq.winningQuoteId);
    if (!quote)
      return show("The awarded supplier quote is unavailable.", "error");
    setSourceRequisitionId(rfq.sourceRequisitionId);
    setSourceRfqId(rfq._id);
    setSupplierId(quote.supplierId);
    setLocationId(rfq.locationId);
    setExpectedDate(quote.expectedDeliveryDate.slice(0, 10));
    setTaxRate(purchase.business.taxRate);
    setTaxMode(purchase.business.taxMode);
    setDraftLines(
      quote.items.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitCost: line.unitCost,
      })),
    );
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
          ...(sourceRfqId ? { sourceRfqId } : {}),
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
      setSourceRfqId("");
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
        ? window
            .prompt(
              action === "CLOSE_SHORT"
                ? "Reason for closing the unreceived balance:"
                : "Reason for cancelling this purchase order:",
            )
            ?.trim()
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
        const batchTracked = purchase.products.find(
          (product) => product._id === line.productId,
        )?.batchTracked;
        return {
          productId: line.productId,
          quantity: Number(receiveCounts[line.productId] || 0),
          ...(batchTracked
            ? {
                lotNo: receiveLots[line.productId]?.lotNo || "",
                expiryDate: receiveLots[line.productId]?.expiryDate || "",
              }
            : {}),
        };
      })
      .filter((line) => line.quantity > 0);
    if (!lines.length)
      return show("Enter at least one received quantity.", "error");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await apiRequest<{
        pendingMatch?: boolean;
        matchException?: PurchaseMatchException;
      }>("/api/purchase-orders", {
        method: "PATCH",
        body: JSON.stringify({
          id: receiveOrder._id,
          action: "RECEIVE",
          clientRequestId: crypto.randomUUID(),
          supplierInvoiceNo: data.get("supplierInvoiceNo"),
          invoiceDate: data.get("invoiceDate"),
          supplierInvoiceTotal: data.get("supplierInvoiceTotal"),
          supplierInvoiceTax: data.get("supplierInvoiceTax"),
          matchNote: data.get("matchNote"),
          receivedAt: data.get("receivedAt"),
          notes: data.get("notes"),
          lines,
        }),
      });
      if (response.pendingMatch) {
        show(
          "Invoice difference sent for independent approval. No stock, payable or journal was posted.",
        );
        setReceiveOrder(null);
        await load(false);
        return;
      }
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

  async function reviewMatchException(
    exception: PurchaseMatchException,
    action: "APPROVE" | "REJECT",
  ) {
    const note = window
      .prompt(
        action === "APPROVE"
          ? "Approval evidence for this supplier invoice difference:"
          : "Reason for rejecting this supplier invoice difference:",
      )
      ?.trim();
    if (!note) return;
    if (note.length < 3) {
      show(
        "Please enter at least three characters of review evidence.",
        "error",
      );
      return;
    }
    setBusy(true);
    try {
      await apiRequest("/api/purchase-match-exceptions", {
        method: "PATCH",
        body: JSON.stringify({
          id: exception._id,
          expectedVersion: exception.version,
          action,
          note,
        }),
      });
      show(
        action === "APPROVE"
          ? "Invoice difference approved. Receiving can now retry the exact invoice evidence."
          : "Invoice difference rejected without posting stock or accounting entries.",
      );
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not review the invoice difference.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function beginLandedCost(bill: Bill) {
    setLandedCostBill(bill);
    setLandedCostSupplierId(
      activeSuppliers.find((supplier) => supplier._id === bill.supplierId)
        ?._id ||
        activeSuppliers[0]?._id ||
        "",
    );
  }

  async function postLandedCost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!landedCostBill) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/landed-costs", {
        method: "POST",
        body: JSON.stringify({
          receiptId: landedCostBill.goodsReceiptId,
          clientRequestId: crypto.randomUUID(),
          supplierId: landedCostSupplierId,
          supplierInvoiceNo: data.get("supplierInvoiceNo"),
          invoiceDate: data.get("invoiceDate"),
          postedAt: data.get("postedAt"),
          total: data.get("total"),
          tax: data.get("tax"),
          category: data.get("category"),
          allocationBasis: data.get("allocationBasis"),
          description: data.get("description"),
        }),
      });
      show(
        "Landed cost allocated to inventory and consumed goods; the supplier bill and balanced journal were posted together.",
      );
      setLandedCostBill(null);
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not post the landed-cost invoice.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function beginReturn(bill: Bill) {
    setReturnLoading(true);
    setReturnDetail(null);
    setReturnCounts({});
    try {
      const detail = await apiRequest<PurchaseReturnDetail>(
        `/api/purchase-returns?billId=${encodeURIComponent(bill._id)}`,
      );
      setReturnDetail(detail);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not open this goods receipt for return.",
        "error",
      );
    } finally {
      setReturnLoading(false);
    }
  }

  async function postReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!returnDetail) return;
    const lines = returnDetail.receipt.items
      .map((line) => ({
        productId: line.productId,
        quantity: Number(returnCounts[line.productId] || 0),
      }))
      .filter((line) => line.quantity > 0);
    if (!lines.length)
      return show("Enter at least one quantity to return.", "error");
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/purchase-returns", {
        method: "POST",
        body: JSON.stringify({
          billId: returnDetail.bill._id,
          expectedUpdatedAt: returnDetail.bill.updatedAt,
          clientRequestId: crypto.randomUUID(),
          supplierCreditNo: data.get("supplierCreditNo"),
          returnedAt: data.get("returnedAt"),
          reason: data.get("reason"),
          lines,
        }),
      });
      show(
        "Purchase return posted. Stock, supplier balance, tax and ledger were updated together.",
      );
      setReturnDetail(null);
      setReturnCounts({});
      await load(false);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not post the purchase return.",
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
      [
        "As of",
        "Bill",
        "Purchase order",
        "Supplier",
        "Supplier invoice",
        "Invoice date",
        "Due date",
        "Currency",
        "Original total",
        "Open balance",
        `Open balance (${profile.currency})`,
        "Days overdue",
        "Age bucket",
        "Status",
      ],
      ...payables.bills
        .filter(
          (bill) => bill.status !== "PAID" && Number(bill.baseBalance || 0) > 0,
        )
        .map((bill) => [
          payables.aging.asOf,
          bill.billNo,
          bill.purchaseOrderNo,
          bill.supplierName,
          bill.supplierInvoiceNo,
          bill.invoiceDate.slice(0, 10),
          bill.dueDate.slice(0, 10),
          bill.currency,
          bill.total,
          bill.balance,
          bill.baseBalance,
          bill.daysOverdue,
          bill.bucket,
          bill.displayStatus,
        ]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    downloadReceiptFile(
      csv,
      "text/csv;charset=utf-8",
      `accounts-payable-aging-${payables.aging.asOf}.csv`,
    );
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
              <button className="button button-secondary" onClick={beginOrder}>
                <FilePlus2 size={16} />
                New purchase order
              </button>
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
          className={tab === "RFQS" ? "active" : ""}
          onClick={() => setTab("RFQS")}
        >
          RFQ comparison
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
            <div>
              <span className="eyebrow">REQUEST TO BUY</span>
              <h2>Purchase requisitions</h2>
            </div>
            {canWrite ? (
              <AddButton onClick={beginRequisition}>New requisition</AddButton>
            ) : null}
          </div>
          {requisitions.length ? (
            <div className="requisition-list">
              {requisitions.map((requisition) => {
                const makerCanApprove =
                  allowSelfApproval ||
                  !requisition.createdBy ||
                  requisition.createdBy !== currentUserId;
                return (
                  <article
                    key={requisition._id}
                    className={
                      requisition.priority === "URGENT" &&
                      requisition.status === "SUBMITTED"
                        ? "urgent"
                        : ""
                    }
                  >
                    <header>
                      <div className="requisition-stamp">
                        <FilePlus2 />
                      </div>
                      <span>
                        <strong>{requisition.requisitionNo}</strong>
                        <small>
                          {requisition.createdByName} ·{" "}
                          {shortDate.format(new Date(requisition.createdAt))}
                        </small>
                      </span>
                      <span>
                        <small>REQUIRED</small>
                        <strong>
                          {dateOnly.format(new Date(requisition.requiredDate))}
                        </strong>
                      </span>
                      <span>
                        <small>DESTINATION</small>
                        <strong>
                          {requisition.locationCode} ·{" "}
                          {requisition.locationName}
                        </strong>
                      </span>
                      <span>
                        <small>PRIORITY</small>
                        <strong>{requisition.priority}</strong>
                      </span>
                      <StatusPill value={requisition.status} />
                    </header>
                    <div className="requisition-body">
                      <div>
                        <span className="eyebrow">BUSINESS JUSTIFICATION</span>
                        <p>{requisition.justification}</p>
                        {requisition.notes ? (
                          <small>{requisition.notes}</small>
                        ) : null}
                      </div>
                      <div className="requisition-items">
                        {requisition.items.map((line) => (
                          <span key={line.productId}>
                            <strong>
                              {line.sku} · {line.productName}
                            </strong>
                            <b>
                              {line.quantity} {line.unit}
                            </b>
                          </span>
                        ))}
                      </div>
                      <footer>
                        <span>
                          {requisition.suggestedSupplierName
                            ? `Suggested supplier · ${requisition.suggestedSupplierCode} · ${requisition.suggestedSupplierName}`
                            : "Supplier to be selected during purchase-order preparation"}
                          {requisition.sourceRfqNo
                            ? ` · Sourcing through ${requisition.sourceRfqNo}`
                            : ""}
                          {requisition.convertedPurchaseOrderNo
                            ? ` · Converted to ${requisition.convertedPurchaseOrderNo}`
                            : ""}
                          {requisition.rejectionReason
                            ? ` · Rejected: ${requisition.rejectionReason}`
                            : ""}
                          {requisition.cancellationReason
                            ? ` · Cancelled: ${requisition.cancellationReason}`
                            : ""}
                        </span>
                        <div className="row-actions">
                          {canWrite && requisition.status === "SUBMITTED" ? (
                            <button
                              className="button button-quiet"
                              disabled={busy}
                              onClick={() =>
                                void requisitionAction(requisition, "CANCEL")
                              }
                            >
                              <XCircle size={14} />
                              Cancel
                            </button>
                          ) : null}
                          {canApprove &&
                          makerCanApprove &&
                          requisition.status === "SUBMITTED" ? (
                            <>
                              <button
                                className="button button-quiet"
                                disabled={busy}
                                onClick={() =>
                                  void requisitionAction(requisition, "REJECT")
                                }
                              >
                                <XCircle size={14} />
                                Reject
                              </button>
                              <button
                                className="button button-secondary"
                                disabled={busy}
                                onClick={() =>
                                  void requisitionAction(requisition, "APPROVE")
                                }
                              >
                                <ClipboardCheck size={14} />
                                Approve
                              </button>
                            </>
                          ) : null}
                          {canWrite && requisition.status === "APPROVED" ? (
                            <>
                              <button
                                className="button button-secondary"
                                disabled={busy || activeSuppliers.length < 2}
                                onClick={() => beginRfq(requisition)}
                              >
                                <Factory size={14} />
                                Request quotes
                              </button>
                              <button
                                className="button button-primary"
                                disabled={busy}
                                onClick={() =>
                                  beginOrderFromRequisition(requisition)
                                }
                              >
                                <FilePlus2 size={14} />
                                Create purchase order
                              </button>
                            </>
                          ) : null}
                        </div>
                      </footer>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No purchase requisitions"
              detail="Submit an internal request for products before committing to a supplier purchase order."
              action={
                canWrite ? (
                  <AddButton onClick={beginRequisition}>
                    New requisition
                  </AddButton>
                ) : undefined
              }
            />
          )}
        </section>
      ) : tab === "RFQS" ? (
        <section className="panel procurement-ledger">
          <div className="panel-header">
            <div>
              <span className="eyebrow">COMPETITIVE SOURCING</span>
              <h2>RFQ supplier comparison</h2>
            </div>
            <span className="muted-copy">
              Base-currency snapshots make cross-currency offers comparable.
            </span>
          </div>
          {rfqs.length ? (
            <div className="rfq-list">
              {rfqs.map((rfq) => {
                const makerCanAward =
                  allowSelfApproval ||
                  !rfq.createdBy ||
                  rfq.createdBy !== currentUserId;
                const rankedQuotes = [...rfq.quotes].sort(
                  (left, right) => left.baseSubtotal - right.baseSubtotal,
                );
                const recordedSupplierIds = new Set(
                  rfq.quotes.map((quote) => quote.supplierId),
                );
                const canAddQuote = rfq.invitedSuppliers.some(
                  (supplier) => !recordedSupplierIds.has(supplier.supplierId),
                );
                return (
                  <article key={rfq._id}>
                    <header>
                      <div className="requisition-stamp">
                        <Factory />
                      </div>
                      <span>
                        <strong>{rfq.rfqNo}</strong>
                        <small>
                          {rfq.sourceRequisitionNo} · {rfq.createdByName}
                        </small>
                      </span>
                      <span>
                        <small>RESPONSE DUE</small>
                        <strong>
                          {dateOnly.format(new Date(rfq.responseDueDate))}
                        </strong>
                      </span>
                      <span>
                        <small>SUPPLIERS / QUOTES</small>
                        <strong>
                          {rfq.invitedSuppliers.length} / {rfq.quotes.length}
                        </strong>
                      </span>
                      <span>
                        <small>NEED DATE</small>
                        <strong>
                          {dateOnly.format(new Date(rfq.requiredDate))}
                        </strong>
                      </span>
                      <StatusPill value={rfq.status} />
                    </header>
                    <div className="rfq-body">
                      <div className="rfq-scope">
                        <span>
                          <small>Destination</small>
                          <strong>
                            {rfq.locationCode} · {rfq.locationName}
                          </strong>
                        </span>
                        <span>
                          <small>Invited</small>
                          <strong>
                            {rfq.invitedSuppliers
                              .map((supplier) => supplier.supplierCode)
                              .join(" · ")}
                          </strong>
                        </span>
                        <span>
                          <small>Reason</small>
                          <strong>{rfq.justification}</strong>
                        </span>
                      </div>
                      {rankedQuotes.length ? (
                        <div className="quote-comparison">
                          {rankedQuotes.map((quote, index) => {
                            const winning = quote._id === rfq.winningQuoteId;
                            const late =
                              quote.expectedDeliveryDate.slice(0, 10) >
                              rfq.requiredDate.slice(0, 10);
                            return (
                              <article
                                key={quote._id}
                                className={winning ? "winner" : ""}
                              >
                                <header>
                                  <span>
                                    <b>
                                      {quote.supplierCode} ·{" "}
                                      {quote.supplierName}
                                    </b>
                                    <small>{quote.supplierReference}</small>
                                  </span>
                                  {winning ? (
                                    <StatusPill value="AWARDED" />
                                  ) : index === 0 ? (
                                    <span className="comparison-badge">
                                      LOWEST BASE
                                    </span>
                                  ) : null}
                                </header>
                                <strong>
                                  {currencyFormatter(
                                    profile.locale,
                                    quote.currency,
                                  ).format(quote.subtotal)}
                                </strong>
                                <small>
                                  {money.format(quote.baseSubtotal)} comparison
                                  · delivery{" "}
                                  {dateOnly.format(
                                    new Date(quote.expectedDeliveryDate),
                                  )}
                                  {late ? " · after need date" : ""}
                                </small>
                                <div>
                                  {quote.items.map((line) => (
                                    <span key={line.productId}>
                                      {line.sku} · {line.quantity} ×{" "}
                                      {currencyFormatter(
                                        profile.locale,
                                        quote.currency,
                                      ).format(line.unitCost)}
                                    </span>
                                  ))}
                                </div>
                                {canApprove &&
                                makerCanAward &&
                                rfq.status === "OPEN" ? (
                                  <button
                                    className="button button-secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      void rfqAction(rfq, "AWARD", quote._id)
                                    }
                                  >
                                    <ClipboardCheck size={14} />
                                    Award quote
                                  </button>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="empty-inline">
                          No supplier quotes recorded yet.
                        </div>
                      )}
                      <footer>
                        <span>
                          {rfq.awardReason
                            ? `Award evidence · ${rfq.awardReason}`
                            : rfq.cancellationReason
                              ? `Cancelled · ${rfq.cancellationReason}`
                              : `${rfq.quotes.length} of ${rfq.invitedSuppliers.length} invited suppliers recorded`}
                          {rfq.convertedPurchaseOrderNo
                            ? ` · Converted to ${rfq.convertedPurchaseOrderNo}`
                            : ""}
                        </span>
                        <div className="row-actions">
                          {canWrite &&
                          ["OPEN", "AWARDED"].includes(rfq.status) ? (
                            <button
                              className="button button-quiet"
                              disabled={busy}
                              onClick={() => void rfqAction(rfq, "CANCEL")}
                            >
                              <XCircle size={14} />
                              Cancel RFQ
                            </button>
                          ) : null}
                          {canWrite && rfq.status === "OPEN" && canAddQuote ? (
                            <button
                              className="button button-secondary"
                              disabled={busy}
                              onClick={() => beginQuote(rfq)}
                            >
                              <Plus size={14} />
                              Record quote
                            </button>
                          ) : null}
                          {canWrite && rfq.status === "AWARDED" ? (
                            <button
                              className="button button-primary"
                              disabled={busy}
                              onClick={() => beginOrderFromRfq(rfq)}
                            >
                              <FilePlus2 size={14} />
                              Create purchase order
                            </button>
                          ) : null}
                        </div>
                      </footer>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No requests for quotation"
              detail="Approve a purchase requisition, then invite at least two suppliers for a controlled price comparison."
            />
          )}
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
                const matchExceptions = purchase.matchExceptions.filter(
                  (exception) => exception.purchaseOrderId === order._id,
                );
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
                      {matchExceptions.length ? (
                        <div className="match-exception-list">
                          {matchExceptions.map((exception) => {
                            const exceptionMoney = currencyFormatter(
                              profile.locale,
                              exception.currency,
                            );
                            const reviewerAllowed =
                              canApprove &&
                              (allowSelfApproval ||
                                exception.requestedBy !== currentUserId);
                            return (
                              <article
                                className="match-exception-card"
                                key={exception._id}
                              >
                                <header>
                                  <span>
                                    <strong>
                                      Invoice difference ·{" "}
                                      {exception.supplierInvoiceNo}
                                    </strong>
                                    <small>
                                      Requested by {exception.requestedByName} ·{" "}
                                      {shortDate.format(
                                        new Date(exception.requestedAt),
                                      )}
                                    </small>
                                  </span>
                                  <StatusPill value={exception.status} />
                                </header>
                                <div className="match-exception-values">
                                  <span>
                                    <small>PO-derived receipt</small>
                                    <strong>
                                      {exceptionMoney.format(
                                        exception.expectedTotal,
                                      )}
                                    </strong>
                                    <small>
                                      Tax{" "}
                                      {exceptionMoney.format(
                                        exception.expectedTax,
                                      )}
                                    </small>
                                  </span>
                                  <span>
                                    <small>Supplier invoice</small>
                                    <strong>
                                      {exceptionMoney.format(
                                        exception.invoiceTotal,
                                      )}
                                    </strong>
                                    <small>
                                      Tax{" "}
                                      {exceptionMoney.format(
                                        exception.invoiceTax,
                                      )}
                                    </small>
                                  </span>
                                  <span>
                                    <small>Total variance</small>
                                    <strong>
                                      {exceptionMoney.format(
                                        exception.totalVariance,
                                      )}
                                    </strong>
                                    <small>
                                      Tax variance{" "}
                                      {exceptionMoney.format(
                                        exception.taxVariance,
                                      )}
                                    </small>
                                  </span>
                                </div>
                                <p>{exception.requestNote}</p>
                                {exception.status === "APPROVED" ? (
                                  <small className="match-exception-guidance">
                                    Approved once: re-enter the exact invoice
                                    number, date, quantities, total and tax to
                                    post this receipt.
                                  </small>
                                ) : exception.reviewNote ? (
                                  <small className="match-exception-guidance">
                                    Review evidence: {exception.reviewNote}
                                  </small>
                                ) : null}
                                {exception.status === "PENDING" &&
                                reviewerAllowed ? (
                                  <footer>
                                    <button
                                      className="button button-quiet"
                                      disabled={busy}
                                      onClick={() =>
                                        void reviewMatchException(
                                          exception,
                                          "REJECT",
                                        )
                                      }
                                    >
                                      <XCircle size={14} /> Reject
                                    </button>
                                    <button
                                      className="button button-secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        void reviewMatchException(
                                          exception,
                                          "APPROVE",
                                        )
                                      }
                                    >
                                      <ClipboardCheck size={14} /> Approve
                                      difference
                                    </button>
                                  </footer>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      ) : null}
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
                              onClick={() =>
                                void orderAction(order, "CLOSE_SHORT")
                              }
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
            <button
              className="button button-secondary"
              onClick={exportPayableAging}
              disabled={!payables.aging.openBillCount}
            >
              <Download size={15} />
              Export aging CSV
            </button>
          </div>
          <div
            className="payable-aging-summary"
            aria-label={`Accounts payable aging as of ${payables.aging.asOf}`}
          >
            {(
              [
                ["CURRENT", "Current"],
                ["1_30", "1–30 days"],
                ["31_60", "31–60 days"],
                ["61_90", "61–90 days"],
                ["90_PLUS", "Over 90 days"],
              ] as const
            ).map(([key, label]) => (
              <article
                key={key}
                className={
                  key !== "CURRENT" && payables.aging.buckets[key].baseAmount
                    ? "overdue"
                    : ""
                }
              >
                <span>{label}</span>
                <strong>
                  {money.format(payables.aging.buckets[key].baseAmount)}
                </strong>
                <small>
                  {payables.aging.buckets[key].count} open bill
                  {payables.aging.buckets[key].count === 1 ? "" : "s"}
                </small>
              </article>
            ))}
          </div>
          <div className="payable-aging-meta">
            <span>
              As of <strong>{payables.aging.asOf}</strong>
            </span>
            <span>
              Due in the next 7 days{" "}
              <strong>{money.format(payables.aging.dueNext7DaysBase)}</strong>
            </span>
            <span>
              Overdue exposure{" "}
              <strong>{money.format(payables.aging.overdueBase)}</strong>
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
                    <small>
                      {bill.billType === "LANDED_COST"
                        ? `Landed cost · ${bill.receiptNo || bill.purchaseOrderNo}`
                        : bill.purchaseOrderNo}
                    </small>
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
                    {bill.daysOverdue > 0 ? (
                      <small>{bill.daysOverdue}d overdue</small>
                    ) : null}
                    {bill.billType !== "LANDED_COST" ? (
                      <EInvoiceGenerator
                        sourceId={bill._id}
                        sourceType="PURCHASE_BILL"
                      />
                    ) : null}
                    {canWrite &&
                    bill.billType !== "LANDED_COST" &&
                    bill.goodsReceiptId ? (
                      <button
                        className="button button-quiet"
                        onClick={() => beginLandedCost(bill)}
                      >
                        <Truck size={14} />
                        Add landed cost
                      </button>
                    ) : null}
                    {canWrite &&
                    bill.billType !== "LANDED_COST" &&
                    bill.status === "OPEN" &&
                    Number(bill.paidAmount || 0) === 0 ? (
                      <button
                        className="button button-quiet"
                        disabled={returnLoading}
                        onClick={() => void beginReturn(bill)}
                      >
                        <RotateCcw size={14} />
                        Return goods
                      </button>
                    ) : null}
                    {canPay &&
                    ["OPEN", "PARTIALLY_PAID"].includes(bill.status) ? (
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
                  <span>
                    <strong>{supplier.supplierName}</strong>
                    <small>
                      {supplier.billCount} open bill
                      {supplier.billCount === 1 ? "" : "s"}
                      {supplier.oldestDaysOverdue
                        ? ` · oldest ${supplier.oldestDaysOverdue}d overdue`
                        : ""}
                    </small>
                  </span>
                  <span>
                    <small>Total</small>
                    <strong>{money.format(supplier.totalBase)}</strong>
                  </span>
                  <span className={supplier.overdueBase ? "danger-text" : ""}>
                    <small>Overdue</small>
                    <strong>{money.format(supplier.overdueBase)}</strong>
                  </span>
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
            <span>
              <strong>Request first, commit after approval</strong>
              <small>
                The approved location, products and quantities are locked into
                the converted purchase order.
              </small>
            </span>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Receiving location</span>
              <select
                value={requisitionLocationId}
                onChange={(event) =>
                  setRequisitionLocationId(event.target.value)
                }
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
              <span>Suggested supplier · optional</span>
              <select
                value={requisitionSupplierId}
                onChange={(event) =>
                  setRequisitionSupplierId(event.target.value)
                }
              >
                <option value="">Select during purchase order</option>
                {activeSuppliers.map((supplier) => (
                  <option key={supplier._id} value={supplier._id}>
                    {supplier.code} · {supplier.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Required date</span>
              <input
                type="date"
                min={isoDate(profile.timeZone)}
                value={requisitionRequiredDate}
                onChange={(event) =>
                  setRequisitionRequiredDate(event.target.value)
                }
                required
              />
            </label>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>Priority</span>
              <select name="priority" defaultValue="NORMAL">
                <option value="NORMAL">Normal</option>
                <option value="URGENT">Urgent</option>
              </select>
            </label>
            <label className="field">
              <span>Business justification</span>
              <input
                name="justification"
                minLength={3}
                maxLength={500}
                required
                placeholder="Why these products are needed"
              />
            </label>
          </div>
          <div className="requisition-line-editor">
            <header>
              <span>Product</span>
              <span>Requested quantity</span>
              <span />
            </header>
            {requisitionLines.map((line, index) => (
              <div key={index}>
                <select
                  value={line.productId}
                  onChange={(event) =>
                    setRequisitionLines((current) =>
                      current.map((item, lineIndex) =>
                        lineIndex === index
                          ? { ...item, productId: event.target.value }
                          : item,
                      ),
                    )
                  }
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
                  max="1000000"
                  step="1"
                  value={line.quantity}
                  onChange={(event) =>
                    setRequisitionLines((current) =>
                      current.map((item, lineIndex) =>
                        lineIndex === index
                          ? { ...item, quantity: Number(event.target.value) }
                          : item,
                      ),
                    )
                  }
                  required
                />
                <button
                  type="button"
                  disabled={requisitionLines.length === 1}
                  onClick={() =>
                    setRequisitionLines((current) =>
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
                setRequisitionLines((current) => [
                  ...current,
                  { productId: "", quantity: 1 },
                ])
              }
            >
              <Plus size={15} />
              Add product
            </button>
          </div>
          <label className="field">
            <span>Request notes</span>
            <textarea
              name="notes"
              rows={3}
              maxLength={500}
              placeholder="Specification, preferred pack size or operational context"
            />
          </label>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setRequisitionOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !requisitionLocationId}
            >
              {busy ? "Submitting…" : "Submit for approval"}
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={rfqOpen}
        onClose={() => {
          setRfqOpen(false);
          setRfqSource(null);
        }}
        title={
          rfqSource
            ? `Open RFQ for ${rfqSource.requisitionNo}`
            : "Open request for quotation"
        }
        kicker="COMPETITIVE SOURCING"
      >
        <form className="modal-form wide-form" onSubmit={createRfq}>
          <div className="receipt-control-note">
            <Factory />
            <span>
              <strong>Invite at least two suppliers</strong>
              <small>
                The approved destination, products and quantities become the
                fixed comparison scope.
              </small>
            </span>
          </div>
          {rfqSource ? (
            <div className="rfq-scope">
              <span>
                <small>Destination</small>
                <strong>
                  {rfqSource.locationCode} · {rfqSource.locationName}
                </strong>
              </span>
              <span>
                <small>Required</small>
                <strong>
                  {dateOnly.format(new Date(rfqSource.requiredDate))}
                </strong>
              </span>
              <span>
                <small>Products</small>
                <strong>{rfqSource.items.length}</strong>
              </span>
            </div>
          ) : null}
          <label className="field">
            <span>Supplier response deadline</span>
            <input
              type="date"
              min={isoDate(profile.timeZone)}
              max={rfqSource?.requiredDate.slice(0, 10)}
              value={rfqResponseDueDate}
              onChange={(event) => setRfqResponseDueDate(event.target.value)}
              required
            />
          </label>
          <div className="field">
            <span>Invited suppliers · {rfqSupplierIds.length} selected</span>
            <div className="supplier-choice-grid">
              {activeSuppliers.map((supplier) => (
                <label
                  key={supplier._id}
                  className={
                    rfqSupplierIds.includes(supplier._id) ? "selected" : ""
                  }
                >
                  <input
                    type="checkbox"
                    checked={rfqSupplierIds.includes(supplier._id)}
                    onChange={() => toggleRfqSupplier(supplier._id)}
                  />
                  <span>
                    <strong>
                      {supplier.code} · {supplier.name}
                    </strong>
                    <small>
                      {supplier.currency} · lead {supplier.leadTimeDays} days
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            <span>RFQ instructions</span>
            <textarea
              name="notes"
              rows={3}
              maxLength={500}
              placeholder="Pack size, specification, warranty or commercial conditions"
            />
          </label>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setRfqOpen(false);
                setRfqSource(null);
              }}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || rfqSupplierIds.length < 2}
            >
              {busy ? "Opening…" : "Open RFQ"}
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={Boolean(quoteRfq)}
        onClose={() => setQuoteRfq(null)}
        title={
          quoteRfq
            ? `Record quote · ${quoteRfq.rfqNo}`
            : "Record supplier quote"
        }
        kicker="SUPPLIER OFFER SNAPSHOT"
      >
        <form
          className="modal-form wide-form"
          onSubmit={submitQuote}
          key={quoteRfq?._id || "quote"}
        >
          <div className="receipt-control-note">
            <ClipboardCheck />
            <span>
              <strong>Record the supplier document exactly</strong>
              <small>
                Prices are preserved in supplier currency and compared using a
                frozen base-currency rate.
              </small>
            </span>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Invited supplier</span>
              <select
                value={quoteSupplierId}
                onChange={(event) =>
                  quoteRfq && chooseQuoteSupplier(quoteRfq, event.target.value)
                }
                required
              >
                {quoteRfq?.invitedSuppliers
                  .filter(
                    (invited) =>
                      !quoteRfq.quotes.some(
                        (quote) => quote.supplierId === invited.supplierId,
                      ),
                  )
                  .map((invited) => (
                    <option key={invited.supplierId} value={invited.supplierId}>
                      {invited.supplierCode} · {invited.supplierName} ·{" "}
                      {invited.currency}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Supplier quotation reference</span>
              <input
                name="supplierReference"
                minLength={2}
                maxLength={80}
                required
                placeholder="QT-2026-001"
              />
            </label>
            <label className="field">
              <span>Promised delivery</span>
              <input
                type="date"
                min={isoDate(profile.timeZone)}
                value={quoteExpectedDate}
                onChange={(event) => setQuoteExpectedDate(event.target.value)}
                required
              />
            </label>
          </div>
          <div className="quote-line-editor">
            <header>
              <span>Requested product</span>
              <span>Quantity</span>
              <span>
                Quoted unit cost · {selectedQuoteSupplier?.currency || "—"}
              </span>
              <span>Line total</span>
            </header>
            {quoteRfq?.items.map((line, index) => {
              const price = quoteLines[index]?.unitCost || 0;
              return (
                <div key={line.productId}>
                  <span>
                    <strong>
                      {line.sku} · {line.productName}
                    </strong>
                    <small>{line.unit}</small>
                  </span>
                  <b>{line.quantity}</b>
                  <input
                    type="number"
                    min={currencyStep(
                      selectedQuoteSupplier?.currency || profile.currency,
                    )}
                    step={currencyStep(
                      selectedQuoteSupplier?.currency || profile.currency,
                    )}
                    value={price || ""}
                    onChange={(event) =>
                      setQuoteLines((current) =>
                        current.map((item, lineIndex) =>
                          lineIndex === index
                            ? { ...item, unitCost: Number(event.target.value) }
                            : item,
                        ),
                      )
                    }
                    required
                  />
                  <strong>
                    {currencyFormatter(
                      profile.locale,
                      selectedQuoteSupplier?.currency || profile.currency,
                    ).format(line.quantity * price)}
                  </strong>
                </div>
              );
            })}
          </div>
          <label className="field">
            <span>Quote notes</span>
            <textarea
              name="notes"
              rows={3}
              maxLength={500}
              placeholder="Validity, freight, pack size or exclusions"
            />
          </label>
          <div className="purchase-draft-total">
            <span>Quoted subtotal · before PO tax treatment</span>
            <strong>
              {currencyFormatter(
                profile.locale,
                selectedQuoteSupplier?.currency || profile.currency,
              ).format(
                (quoteRfq?.items || []).reduce(
                  (sum, line, index) =>
                    sum +
                    line.quantity * Number(quoteLines[index]?.unitCost || 0),
                  0,
                ),
              )}
            </strong>
          </div>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setQuoteRfq(null)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !quoteSupplierId}
            >
              {busy ? "Recording…" : "Record supplier quote"}
            </button>
          </footer>
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
        onClose={() => {
          setOrderOpen(false);
          setSourceRequisitionId("");
          setSourceRfqId("");
        }}
        title="Draft purchase order"
        kicker="CONTROLLED COMMITMENT"
      >
        <form className="modal-form wide-form" onSubmit={createOrder}>
          {sourceRfqId ? (
            <div className="receipt-control-note">
              <ClipboardCheck />
              <span>
                <strong>Converting an awarded supplier quote</strong>
                <small>
                  Supplier, delivery date, destination, products, quantities and
                  quoted unit costs are locked to the sourcing decision.
                </small>
              </span>
            </div>
          ) : sourceRequisitionId ? (
            <div className="receipt-control-note">
              <ClipboardCheck />
              <span>
                <strong>Converting an approved requisition</strong>
                <small>
                  Destination, products and quantities are locked. Select the
                  supplier, confirm costs and create the purchase-order draft.
                </small>
              </span>
            </div>
          ) : null}
          <div className="purchase-draft-top">
            <div className="form-grid three">
              <label className="field">
                <span>Supplier</span>
                <select
                  value={supplierId}
                  onChange={(event) => chooseSupplier(event.target.value)}
                  disabled={Boolean(sourceRfqId)}
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
                  disabled={Boolean(sourceRfqId)}
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
                    {purchase.reorderSuggestions.length} low-stock
                    recommendations use recent 30-day demand
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
                  disabled={Boolean(sourceRfqId)}
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
              onClick={() => {
                setOrderOpen(false);
                setSourceRequisitionId("");
                setSourceRfqId("");
              }}
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
          <div className="form-grid three">
            <label className="field">
              <span>Supplier invoice total · {receiveOrder?.currency}</span>
              <input
                name="supplierInvoiceTotal"
                type="number"
                min={currencyStep(receiveOrder?.currency || profile.currency)}
                step={currencyStep(receiveOrder?.currency || profile.currency)}
                defaultValue={receiveExpected.total || ""}
                required
              />
            </label>
            <label className="field">
              <span>Supplier invoice tax · {receiveOrder?.currency}</span>
              <input
                name="supplierInvoiceTax"
                type="number"
                min="0"
                step={currencyStep(receiveOrder?.currency || profile.currency)}
                defaultValue={receiveExpected.tax}
                required
              />
            </label>
            <div className="field receipt-match-reference">
              <span>PO-derived receipt value</span>
              <strong>
                {receiveOrder
                  ? currencyFormatter(
                      profile.locale,
                      receiveOrder.currency,
                    ).format(receiveExpected.total)
                  : ""}
              </strong>
              <small>
                Tax{" "}
                {receiveOrder
                  ? currencyFormatter(
                      profile.locale,
                      receiveOrder.currency,
                    ).format(receiveExpected.tax)
                  : ""}
              </small>
            </div>
          </div>
          <label className="field">
            <span>Invoice difference evidence</span>
            <textarea
              name="matchNote"
              rows={2}
              maxLength={300}
              placeholder="Required only when the supplier invoice total or tax differs from the purchase order"
            />
            <small>
              A difference creates an independent approval request. Stock,
              payables and journals remain unchanged until the exact evidence is
              approved.
            </small>
          </label>
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
              const batchTracked =
                purchase.products.find(
                  (product) => product._id === line.productId,
                )?.batchTracked === true;
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
                  {batchTracked ? (
                    <input
                      aria-label={`${line.productName} supplier lot`}
                      value={receiveLots[line.productId]?.lotNo || ""}
                      onChange={(event) =>
                        setReceiveLots((current) => ({
                          ...current,
                          [line.productId]: {
                            lotNo: event.target.value,
                            expiryDate:
                              current[line.productId]?.expiryDate || "",
                          },
                        }))
                      }
                      placeholder="Lot / batch no."
                      required={Number(receiveCounts[line.productId] || 0) > 0}
                      disabled={!outstanding}
                    />
                  ) : (
                    <small>Not tracked</small>
                  )}
                  {batchTracked ? (
                    <input
                      aria-label={`${line.productName} expiry date`}
                      type="date"
                      min={isoDate(profile.timeZone, 1)}
                      value={receiveLots[line.productId]?.expiryDate || ""}
                      onChange={(event) =>
                        setReceiveLots((current) => ({
                          ...current,
                          [line.productId]: {
                            lotNo: current[line.productId]?.lotNo || "",
                            expiryDate: event.target.value,
                          },
                        }))
                      }
                      required={Number(receiveCounts[line.productId] || 0) > 0}
                      disabled={!outstanding}
                    />
                  ) : (
                    <small>—</small>
                  )}
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
        open={Boolean(landedCostBill)}
        onClose={() => setLandedCostBill(null)}
        title={`Allocate landed cost · ${landedCostBill?.receiptNo || landedCostBill?.purchaseOrderNo || "receipt"}`}
        kicker="FREIGHT · DUTY · INSURANCE"
      >
        <form
          className="modal-form wide-form"
          onSubmit={postLandedCost}
          key={landedCostBill?._id || "landed-cost"}
        >
          <div className="receipt-control-note">
            <Truck />
            <span>
              <strong>Attach the charge to the goods it brought in</strong>
              <small>
                Remaining goods increase inventory cost. The consumed or
                returned share moves to cost of goods sold, and the supplier
                bill remains payable.
              </small>
            </span>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Cost supplier</span>
              <select
                value={landedCostSupplierId}
                onChange={(event) =>
                  setLandedCostSupplierId(event.target.value)
                }
                required
                autoFocus
              >
                <option value="">
                  Choose freight, customs or service supplier
                </option>
                {activeSuppliers.map((supplier) => (
                  <option key={supplier._id} value={supplier._id}>
                    {supplier.code} · {supplier.name} · {supplier.currency}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Cost category</span>
              <select name="category" defaultValue="FREIGHT" required>
                <option value="FREIGHT">Freight</option>
                <option value="DUTY">Customs duty</option>
                <option value="INSURANCE">Cargo insurance</option>
                <option value="HANDLING">Handling</option>
                <option value="OTHER">Other direct landed cost</option>
              </select>
            </label>
            <label className="field">
              <span>Allocate across receipt by</span>
              <select name="allocationBasis" defaultValue="VALUE" required>
                <option value="VALUE">Received inventory value</option>
                <option value="QUANTITY">Received quantity</option>
              </select>
            </label>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Supplier invoice no.</span>
              <input
                name="supplierInvoiceNo"
                minLength={2}
                maxLength={80}
                placeholder="FRT-2026-001"
                required
              />
            </label>
            <label className="field">
              <span>Supplier invoice date</span>
              <input
                name="invoiceDate"
                type="date"
                max={isoDate(profile.timeZone)}
                defaultValue={isoDate(profile.timeZone)}
                required
              />
            </label>
            <label className="field">
              <span>Accounting date</span>
              <input
                name="postedAt"
                type="date"
                max={isoDate(profile.timeZone)}
                defaultValue={isoDate(profile.timeZone)}
                required
              />
            </label>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>
                Invoice total ·{" "}
                {selectedLandedCostSupplier?.currency || "supplier currency"}
              </span>
              <input
                name="total"
                type="number"
                min={currencyStep(
                  selectedLandedCostSupplier?.currency || profile.currency,
                )}
                step={currencyStep(
                  selectedLandedCostSupplier?.currency || profile.currency,
                )}
                required
              />
            </label>
            <label className="field">
              <span>
                Recoverable tax ·{" "}
                {selectedLandedCostSupplier?.currency || "supplier currency"}
              </span>
              <input
                name="tax"
                type="number"
                min="0"
                step={currencyStep(
                  selectedLandedCostSupplier?.currency || profile.currency,
                )}
                defaultValue="0"
                required
              />
            </label>
          </div>
          <label className="field">
            <span>Cost evidence</span>
            <textarea
              name="description"
              rows={3}
              minLength={3}
              maxLength={300}
              placeholder="Shipment, airway bill, customs declaration or insurance reference"
              required
            />
          </label>
          <p className="form-hint">
            Posting uses the active supplier exchange rate, creates a separate
            accounts-payable bill and keeps the source receipt allocation for
            audit.
          </p>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setLandedCostBill(null)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !landedCostSupplierId}
            >
              <Truck size={16} />
              {busy ? "Allocating…" : "Post landed cost"}
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={Boolean(returnDetail)}
        onClose={() => {
          setReturnDetail(null);
          setReturnCounts({});
        }}
        title={`Return goods from ${returnDetail?.bill.billNo || "supplier bill"}`}
        kicker="SUPPLIER CREDIT + STOCK REVERSAL"
      >
        <form className="modal-form wide-form" onSubmit={postReturn}>
          <div className="receipt-control-note">
            <RotateCcw />
            <span>
              <strong>
                Record only goods physically leaving this location
              </strong>
              <small>
                The supplier credit, stock, exact receipt tax and general ledger
                are reversed together. Paid bills require a separate
                supplier-credit workflow.
              </small>
            </span>
          </div>
          <div className="form-grid three">
            <label className="field">
              <span>Supplier credit note</span>
              <input
                name="supplierCreditNo"
                minLength={2}
                maxLength={80}
                placeholder="CN-2026-001"
                required
                autoFocus
              />
            </label>
            <label className="field">
              <span>Return date</span>
              <input
                name="returnedAt"
                type="date"
                min={returnDetail?.receipt.receivedAt.slice(0, 10)}
                max={isoDate(profile.timeZone)}
                defaultValue={isoDate(profile.timeZone)}
                required
              />
            </label>
            <div className="field">
              <span>Source receipt</span>
              <strong>
                {returnDetail?.receipt.receiptNo} ·{" "}
                {returnDetail?.receipt.locationName}
              </strong>
            </div>
          </div>
          <div className="receive-lines">
            <header>
              <span>Product</span>
              <span>Received</span>
              <span>Returned</span>
              <span>Available stock</span>
              <span>Return now</span>
              <span>Receipt batch</span>
            </header>
            {returnDetail?.receipt.items.map((line) => {
              const maximum = Math.max(
                0,
                Math.min(
                  Number(line.returnableQuantity || 0),
                  Number(line.availableStock || 0),
                ),
              );
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
                    {line.returnedQuantity || 0} {line.unit}
                  </b>
                  <b>
                    {line.availableStock} {line.unit}
                  </b>
                  <input
                    aria-label={`${line.productName} return quantity`}
                    type="number"
                    min="0"
                    max={maximum}
                    step="1"
                    value={returnCounts[line.productId] || ""}
                    onChange={(event) =>
                      setReturnCounts((current) => ({
                        ...current,
                        [line.productId]: event.target.value,
                      }))
                    }
                    placeholder={`0 / ${maximum}`}
                    disabled={!maximum}
                  />
                  <small>
                    {line.batchTracked
                      ? `${line.lotNo || "Batch unavailable"}${line.expiryDate ? ` · ${line.expiryDate.slice(0, 10)}` : ""}`
                      : "Not tracked"}
                  </small>
                </label>
              );
            })}
          </div>
          {returnDetail?.returns.length ? (
            <p className="form-hint">
              Previous returns:{" "}
              {returnDetail.returns
                .map((item) => `${item.returnNo} · ${item.supplierCreditNo}`)
                .join("; ")}
            </p>
          ) : null}
          <label className="field">
            <span>Return reason</span>
            <textarea
              name="reason"
              rows={3}
              minLength={3}
              maxLength={300}
              placeholder="Damaged delivery, incorrect product or agreed supplier return"
              required
            />
          </label>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setReturnDetail(null);
                setReturnCounts({});
              }}
            >
              Cancel
            </button>
            <button className="button button-primary" disabled={busy}>
              <RotateCcw size={16} />
              {busy ? "Posting return…" : "Post purchase return"}
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
