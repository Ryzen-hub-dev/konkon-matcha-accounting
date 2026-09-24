"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Cable,
  CheckCircle2,
  Copy,
  KeyRound,
  Landmark,
  Plus,
  RadioTower,
} from "lucide-react";
import {
  apiRequest,
  EmptyState,
  LoadingPanel,
  Modal,
  Notice,
  PageHeader,
  StatusPill,
  useNotice,
} from "@/components/ui";
import { useBusiness } from "@/components/business-context";

type Account = { code: string; name: string };
type Connection = {
  _id: string;
  name: string;
  provider: string;
  accountCode: string;
  accountName: string;
  externalAccountReferenceLast4?: string;
  currency: string;
  active: boolean;
  status: string;
  secretLast4: string;
  lastReceivedAt?: string;
  receivedEventCount?: number;
};
type FeedTransaction = {
  _id: string;
  connectionName: string;
  provider: string;
  accountCode: string;
  eventId: string;
  postedAt: string;
  amount: number;
  currency: string;
  description: string;
  reference: string;
  status: string;
};
type Data = {
  connections: Connection[];
  accounts: Account[];
  transactions: FeedTransaction[];
  canManage: boolean;
};

export function BankConnectionsView() {
  const { profile } = useBusiness();
  const [data, setData] = useState<Data | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{
    connection: Connection;
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState("/api/webhooks/bank-feed");
  const { notice, show } = useNotice();
  const money = useMemo(
    () =>
      new Intl.NumberFormat(profile.locale, {
        style: "currency",
        currency: profile.currency,
      }),
    [profile.currency, profile.locale],
  );

  async function load() {
    try {
      setData(await apiRequest<Data>("/api/bank-connections"));
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not load bank connections.",
        "error",
      );
    }
  }
  useEffect(() => {
    setEndpoint(`${window.location.origin}/api/webhooks/bank-feed`);
    void load();
  }, []);

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest<Connection & { webhookSecret: string }>(
        "/api/bank-connections",
        {
          method: "POST",
          body: JSON.stringify({
            action: "CREATE",
            name: form.get("name"),
            provider: form.get("provider"),
            accountCode: form.get("accountCode"),
            externalAccountId: form.get("externalAccountId"),
          }),
        },
      );
      setCreating(false);
      setSecret({ connection: result, value: result.webhookSecret });
      show("Bank feed interface created. Copy its signing secret now.");
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not create the bank connection.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function connectionAction(
    connection: Connection,
    action: "ROTATE_SECRET" | "SET_ACTIVE",
  ) {
    if (busy) return;
    if (
      action === "ROTATE_SECRET" &&
      !window.confirm(
        `Rotate the secret for ${connection.name}? The old sender will stop working immediately.`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await apiRequest<Connection & { webhookSecret?: string }>(
        "/api/bank-connections",
        {
          method: "POST",
          body: JSON.stringify(
            action === "ROTATE_SECRET"
              ? { action, id: connection._id }
              : { action, id: connection._id, active: !connection.active },
          ),
        },
      );
      if (result.webhookSecret)
        setSecret({ connection: result, value: result.webhookSecret });
      show(
        action === "ROTATE_SECRET"
          ? "Signing secret rotated."
          : result.active
            ? "Bank feed enabled."
            : "Bank feed disabled.",
      );
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not update the bank connection.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      show(message);
    } catch {
      show("Copy is unavailable. Select the value manually.", "error");
    }
  }

  if (!data)
    return (
      <div className="page page-enter">
        <PageHeader
          eyebrow="BANK DATA"
          title="Live bank feeds"
          description="Loading signed transaction interfaces."
        />
        {notice ? <Notice {...notice} /> : null}
        <LoadingPanel label="Opening the bank connection desk…" />
      </div>
    );

  return (
    <div className="page page-enter bank-connections-page">
      <PageHeader
        eyebrow="BANK DATA"
        title="Live bank feeds"
        description="Receive signed transactions from an approved bank, aggregator or your own middleware without exposing workspace credentials."
        action={
          data.canManage ? (
            <button
              className="button button-primary"
              onClick={() => setCreating(true)}
            >
              <Plus />
              New feed
            </button>
          ) : undefined
        }
      />
      {notice ? <Notice {...notice} /> : null}
      <section className="bank-feed-rail">
        <RadioTower />
        <div>
          <strong>Provider-neutral signed push</strong>
          <span>
            The receiving API is ready now. No bank is treated as connected
            until its first valid signed event arrives.
          </span>
        </div>
        <i />
        <div>
          <strong>Vercel-safe</strong>
          <span>
            Each event is verified and stored during one short request; no
            always-on worker is required.
          </span>
        </div>
      </section>
      <div className="bank-feed-layout">
        <section className="panel bank-feed-connections">
          <header className="panel-header">
            <div>
              <span className="eyebrow">CONNECTIONS</span>
              <h2>Bank interfaces</h2>
            </div>
            <Cable />
          </header>
          {data.connections.length ? (
            data.connections.map((connection) => (
              <article key={connection._id} className="bank-feed-connection">
                <div className="bank-seal">
                  <Landmark />
                </div>
                <div>
                  <strong>{connection.name}</strong>
                  <span>
                    {connection.provider} · {connection.accountCode}{" "}
                    {connection.accountName}
                  </span>
                  <small>
                    {connection.lastReceivedAt
                      ? `Last event ${new Date(connection.lastReceivedAt).toLocaleString()}`
                      : "Waiting for the first signed event"}
                  </small>
                </div>
                <StatusPill
                  value={connection.active ? connection.status : "DISABLED"}
                />
                {data.canManage ? (
                  <footer>
                    <button
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() =>
                        void connectionAction(connection, "ROTATE_SECRET")
                      }
                    >
                      <KeyRound />
                      Rotate secret
                    </button>
                    <button
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() =>
                        void connectionAction(connection, "SET_ACTIVE")
                      }
                    >
                      {connection.active ? "Disable" : "Enable"}
                    </button>
                  </footer>
                ) : null}
              </article>
            ))
          ) : (
            <EmptyState
              title="No live feed interfaces"
              detail="Create one when your bank, aggregator or middleware is ready to send signed transactions."
            />
          )}
        </section>
        <section className="panel bank-feed-events">
          <header className="panel-header">
            <div>
              <span className="eyebrow">LATEST 100</span>
              <h2>Received transactions</h2>
            </div>
            <CheckCircle2 />
          </header>
          {data.transactions.length ? (
            <div className="bank-event-list">
              {data.transactions.map((transaction) => (
                <article key={transaction._id}>
                  <span>
                    <strong>{transaction.description}</strong>
                    <small>
                      {transaction.connectionName} ·{" "}
                      {new Date(transaction.postedAt).toLocaleString()} ·{" "}
                      {transaction.reference || transaction.eventId}
                    </small>
                  </span>
                  <b className={transaction.amount < 0 ? "negative" : ""}>
                    {money.format(transaction.amount)}
                  </b>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No transactions received"
              detail="The list updates after a sender passes timestamp, signature, currency and duplicate checks."
            />
          )}
        </section>
      </div>
      <Modal
        open={creating}
        onClose={() => {
          if (!busy) setCreating(false);
        }}
        title="Create bank feed"
        kicker="SIGNED PUSH API"
      >
        <form className="modal-form" onSubmit={createConnection}>
          <div className="form-grid two">
            <label className="field">
              <span>Connection name</span>
              <input
                name="name"
                placeholder="Maybank operating account"
                minLength={2}
                maxLength={80}
                required
              />
            </label>
            <label className="field">
              <span>Provider code</span>
              <input
                name="provider"
                placeholder="MAYBANK or CUSTOM"
                minLength={2}
                maxLength={40}
                pattern="[A-Za-z0-9_-]+"
                required
              />
            </label>
            <label className="field">
              <span>Ledger bank account</span>
              <select name="accountCode" required>
                {data.accounts.map((account) => (
                  <option key={account.code} value={account.code}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Provider account reference</span>
              <input
                name="externalAccountId"
                maxLength={100}
                placeholder="Optional masked account ID"
              />
            </label>
          </div>
          <p className="form-hint">
            Creating this interface does not contact a bank. The provider must
            send HTTPS events using the generated secret.
          </p>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !data.accounts.length}
            >
              {busy ? "Creating…" : "Create interface"}
            </button>
          </footer>
        </form>
      </Modal>
      <Modal
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        title="Copy the signing secret"
        kicker="SHOWN ONCE"
      >
        {secret ? (
          <div className="bank-feed-secret">
            <p>
              Give these values only to the approved sender. Rotating the secret
              immediately invalidates the previous one.
            </p>
            <label>
              <span>Webhook URL</span>
              <code>{endpoint}</code>
              <button
                className="icon-button"
                onClick={() => void copy(endpoint, "Webhook URL copied.")}
              >
                <Copy />
              </button>
            </label>
            <label>
              <span>Connection header</span>
              <code>{secret.connection._id}</code>
              <button
                className="icon-button"
                onClick={() =>
                  void copy(secret.connection._id, "Connection ID copied.")
                }
              >
                <Copy />
              </button>
            </label>
            <label>
              <span>Signing secret</span>
              <code>{secret.value}</code>
              <button
                className="icon-button"
                onClick={() =>
                  void copy(secret.value, "Signing secret copied.")
                }
              >
                <Copy />
              </button>
            </label>
            <small>
              Send Unix seconds in x-konkon-bank-timestamp and
              HMAC-SHA256(secret, timestamp + "." + exact JSON body) in
              x-konkon-bank-signature.
            </small>
            <footer>
              <button
                className="button button-primary"
                onClick={() => setSecret(null)}
              >
                I saved the secret
              </button>
            </footer>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
