"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Minus,
  PackageSearch,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  X,
} from "lucide-react";
import styles from "./storefront.module.css";

type Product = {
  _id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  price: number;
  available: number;
  onlineDescription: string;
  sensitiveGood: boolean;
};

type StoreData = {
  business: {
    name: string;
    email: string;
    phone: string;
    currency: string;
    locale: string;
  };
  store: {
    enabled: boolean;
    storeTitle: string;
    storeSubtitle: string;
    termsNotice: string;
    sensitiveFields: Array<{ key: string; label: string; required: boolean }>;
  };
  products: Product[];
};

async function api<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as {
    ok: boolean;
    data?: T;
    error?: string;
  };
  if (!response.ok || !body.ok) throw new Error(body.error || "Request failed.");
  return body.data as T;
}

export function StorefrontView() {
  const [data, setData] = useState<StoreData | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [checkout, setCheckout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ orderNo: string; message: string } | null>(null);

  useEffect(() => {
    void api<StoreData>("/api/storefront")
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Store unavailable."));
  }, []);

  const products = data?.products || [];
  const categories = ["ALL", ...new Set(products.map((product) => product.category))];
  const visible = products.filter(
    (product) =>
      (category === "ALL" || product.category === category) &&
      `${product.name} ${product.sku} ${product.category}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const selected = useMemo(
    () =>
      products
        .filter((product) => cart[product._id])
        .map((product) => ({ ...product, quantity: cart[product._id] })),
    [cart, products],
  );
  const quantity = selected.reduce((sum, item) => sum + item.quantity, 0);
  const money = new Intl.NumberFormat(data?.business.locale || "en", {
    style: "currency",
    currency: data?.business.currency || "USD",
  });
  const total = selected.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const hasSensitive = selected.some((item) => item.sensitiveGood);

  function change(product: Product, amount: number) {
    setCart((current) => {
      const next = Math.max(
        0,
        Math.min(product.available, Number(current[product._id] || 0) + amount),
      );
      const updated = { ...current, [product._id]: next };
      if (!next) delete updated[product._id];
      return updated;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !selected.length) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ orderNo: string; message: string }>(
        "/api/storefront",
        {
          method: "POST",
          body: JSON.stringify({
            customerName: form.get("customerName"),
            email: form.get("email"),
            phone: form.get("phone"),
            address: form.get("address"),
            note: form.get("note"),
            website: form.get("website"),
            items: selected.map((item) => ({
              productId: item._id,
              quantity: item.quantity,
            })),
            sensitiveAnswers: hasSensitive
              ? data.store.sensitiveFields.map((field) => ({
                  key: field.key,
                  value: form.get(`sensitive-${field.key}`),
                }))
              : [],
          }),
        },
      );
      setSuccess(result);
      setCart({});
      setCheckout(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.storePage}>
      <header className={styles.storeHeader}>
        <Link href="/" className={styles.wordmark}>
          <span>KK</span>
          <strong>{data?.business.name || "Order desk"}</strong>
        </Link>
        <nav>
          <a href="#catalogue">Catalogue</a>
          <span>Stock shown live</span>
        </nav>
        <button className={styles.cartButton} onClick={() => setCheckout(true)}>
          <ShoppingBag size={18} />
          <span>{quantity || "Cart"}</span>
        </button>
      </header>

      <section className={styles.storeHero}>
        <div>
          <span className={styles.signal}>ONLINE ORDER REQUEST</span>
          <h1>{data?.store.storeTitle || "Choose. Request. Confirm."}</h1>
          <p>
            {data?.store.storeSubtitle ||
              "Browse live products and ask for a confirmed offer before payment."}
          </p>
        </div>
        <div className={styles.routeCard} aria-label="Order route">
          <span>01</span><strong>Select</strong><i />
          <span>02</span><strong>Request</strong><i />
          <span>03</span><strong>Chat</strong><i />
          <span>04</span><strong>Pay & track</strong>
        </div>
      </section>

      <section className={styles.catalogue} id="catalogue">
        <header className={styles.catalogueHeader}>
          <div>
            <span className={styles.signal}>LIVE CATALOGUE</span>
            <h2>Available products</h2>
          </div>
          <label className={styles.searchBox}>
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search product or SKU"
            />
          </label>
        </header>
        <div className={styles.categoryRail}>
          {categories.map((item) => (
            <button
              key={item}
              className={category === item ? styles.activeCategory : ""}
              onClick={() => setCategory(item)}
            >
              {item === "ALL" ? "All products" : item}
            </button>
          ))}
        </div>
        {!data && !error ? (
          <div className={styles.loading}>Loading catalogue…</div>
        ) : error && !data ? (
          <div className={styles.storeError}>{error}</div>
        ) : visible.length ? (
          <div className={styles.productGrid}>
            {visible.map((product, index) => {
              const count = cart[product._id] || 0;
              return (
                <article className={styles.productCard} key={product._id}>
                  <div className={styles.productVisual}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <PackageSearch />
                    {product.sensitiveGood ? <b>CONTROLLED</b> : null}
                  </div>
                  <div className={styles.productCopy}>
                    <small>{product.category} · {product.sku}</small>
                    <h3>{product.name}</h3>
                    <p>{product.onlineDescription || `Sold per ${product.unit}. Availability is confirmed before payment.`}</p>
                  </div>
                  <footer>
                    <div>
                      <strong>{money.format(product.price)}</strong>
                      <small>{product.available} {product.unit} available</small>
                    </div>
                    {count ? (
                      <div className={styles.quantityControl}>
                        <button aria-label={`Remove one ${product.name}`} onClick={() => change(product, -1)}><Minus size={15} /></button>
                        <b>{count}</b>
                        <button aria-label={`Add one ${product.name}`} onClick={() => change(product, 1)} disabled={count >= product.available}><Plus size={15} /></button>
                      </div>
                    ) : (
                      <button className={styles.addButton} onClick={() => change(product, 1)} disabled={!product.available}>
                        {product.available ? "Add" : "Unavailable"}<Plus size={15} />
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyProducts}>No products match this search.</div>
        )}
      </section>

      {quantity ? (
        <button className={styles.floatingCart} onClick={() => setCheckout(true)}>
          <span>{quantity} item{quantity === 1 ? "" : "s"}</span>
          <strong>{money.format(total)}</strong>
          <ArrowRight size={18} />
        </button>
      ) : null}

      {checkout ? (
        <div className={styles.sheetBackdrop} role="presentation">
          <section className={styles.checkoutSheet} role="dialog" aria-modal="true" aria-label="Order request">
            <header>
              <div><span className={styles.signal}>ORDER REQUEST</span><h2>Review your selection</h2></div>
              <button onClick={() => setCheckout(false)} aria-label="Close"><X /></button>
            </header>
            <div className={styles.selectedItems}>
              {selected.map((item) => (
                <article key={item._id}>
                  <div><strong>{item.name}</strong><small>{money.format(item.price)} / {item.unit}</small></div>
                  <div className={styles.quantityControl}><button onClick={() => change(item, -1)}><Minus size={14} /></button><b>{item.quantity}</b><button onClick={() => change(item, 1)} disabled={item.quantity >= item.available}><Plus size={14} /></button></div>
                  <strong>{money.format(item.price * item.quantity)}</strong>
                </article>
              ))}
              <footer><span>Estimated list price</span><strong>{money.format(total)}</strong></footer>
            </div>
            <form onSubmit={submit} className={styles.orderForm}>
              <input className={styles.honeypot} tabIndex={-1} autoComplete="off" name="website" />
              <div className={styles.formPair}>
                <label><span>Name</span><input name="customerName" required maxLength={120} /></label>
                <label><span>Email</span><input name="email" type="email" required maxLength={254} /></label>
              </div>
              <label><span>Phone number</span><input name="phone" type="tel" required maxLength={40} /></label>
              <label><span>Delivery address</span><textarea name="address" required minLength={8} maxLength={500} rows={3} /></label>
              {hasSensitive ? (
                <fieldset className={styles.sensitiveFields}>
                  <legend><ShieldCheck size={17} />Controlled-item details</legend>
                  <p>These answers help staff confirm any additional fulfilment steps.</p>
                  {data?.store.sensitiveFields.map((field) => (
                    <label key={field.key}><span>{field.label}</span><textarea name={`sensitive-${field.key}`} required={field.required} maxLength={500} rows={2} /></label>
                  ))}
                </fieldset>
              ) : null}
              <label><span>Message · optional</span><textarea name="note" maxLength={1000} rows={3} placeholder="Delivery timing, preferred variation or a question" /></label>
              <p className={styles.terms}><ShieldCheck size={17} />{data?.store.termsNotice}</p>
              {error ? <p className={styles.formError}>{error}</p> : null}
              <button className={styles.submitOrder} disabled={busy || !selected.length}>{busy ? "Sending request…" : "Send order request"}<ArrowRight size={17} /></button>
            </form>
          </section>
        </div>
      ) : null}

      {success ? (
        <div className={styles.sheetBackdrop} role="presentation">
          <section className={styles.successCard} role="dialog" aria-modal="true">
            <i><Check /></i>
            <span className={styles.signal}>REQUEST RECEIVED</span>
            <h2>{success.orderNo}</h2>
            <p>{success.message}</p>
            <button onClick={() => setSuccess(null)}>Continue browsing</button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
