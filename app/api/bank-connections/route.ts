import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import {
  authorize,
  created,
  fail,
  ok,
  publicError,
  sameOrigin,
} from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import {
  bankConnectionMutationSchema,
  generateBankFeedSecret,
} from "@/lib/bank-connections";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { encryptMemberToken } from "@/lib/member-cards";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";
const projection = {
  encryptedWebhookSecret: 0,
  externalAccountId: 0,
  externalAccountReferenceHash: 0,
  createdBy: 0,
  updatedBy: 0,
};
const secretContext = (id: string) => `bank-feed:${id}:webhook-secret:v1`;

export async function GET() {
  const auth = await authorize("accounting.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [connections, accounts, transactions] = await Promise.all([
      db
        .collection("bankConnections")
        .find({}, { projection })
        .sort({ active: -1, name: 1 })
        .limit(50)
        .toArray(),
      db
        .collection("chartOfAccounts")
        .find({ type: "ASSET", cashEquivalent: true, active: { $ne: false } })
        .project({ code: 1, name: 1 })
        .sort({ code: 1 })
        .toArray(),
      db
        .collection("bankFeedTransactions")
        .find({})
        .project({ rawPayload: 0 })
        .sort({ postedAt: -1 })
        .limit(100)
        .toArray(),
    ]);
    return ok(
      serialise({
        connections,
        accounts,
        transactions,
        canManage: hasPermission(auth.session.role, "owner.control"),
      }),
    );
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = bankConnectionMutationSchema.safeParse(await request.json());
    if (!input.success)
      return fail(
        "Check the bank connection.",
        422,
        input.error.flatten().fieldErrors,
      );
    const db = await getDb();
    if (input.data.action === "CREATE") {
      if ((await db.collection("bankConnections").countDocuments({})) >= 20)
        return fail("Keep at most 20 bank connections.", 409);
      const [account, settings] = await Promise.all([
        db.collection("chartOfAccounts").findOne({
          code: input.data.accountCode,
          type: "ASSET",
          cashEquivalent: true,
          active: { $ne: false },
        }),
        db.collection("settings").findOne({ key: "business" }),
      ]);
      if (!account) return fail("Choose an active bank ledger account.", 422);
      const nameNormalized = input.data.name.toLocaleLowerCase("en-US");
      const id = new ObjectId(
        createHash("sha256")
          .update(`bank-connection:${nameNormalized}`)
          .digest("hex")
          .slice(0, 24),
      );
      const secret = generateBankFeedSecret();
      const now = new Date();
      const business = normaliseBusinessSettings(settings);
      const externalAccountReference = input.data.externalAccountId.trim();
      const document = {
        _id: id,
        name: input.data.name,
        nameNormalized,
        provider: input.data.provider,
        accountCode: String(account.code),
        accountName: String(account.name),
        externalAccountReferenceLast4: externalAccountReference.slice(-4),
        externalAccountReferenceHash: externalAccountReference
          ? createHash("sha256").update(externalAccountReference).digest("hex")
          : "",
        currency: business.currency,
        mode: "SIGNED_PUSH",
        active: true,
        status: "WAITING_FOR_FIRST_EVENT",
        encryptedWebhookSecret: encryptMemberToken(
          secret,
          secretContext(id.toHexString()),
        ),
        secretLast4: secret.slice(-4),
        createdBy: new ObjectId(auth.session.id),
        createdAt: now,
        updatedAt: now,
      };
      await db.collection("bankConnections").insertOne(document);
      await writeAudit(
        db,
        auth.session,
        "bank_connection.create",
        "bankConnection",
        id.toHexString(),
        {
          name: document.name,
          provider: document.provider,
          accountCode: document.accountCode,
        },
      );
      return created(
        serialise({
          ...document,
          encryptedWebhookSecret: undefined,
          externalAccountReferenceHash: undefined,
          createdBy: undefined,
          webhookSecret: secret,
        }),
      );
    }
    const id = new ObjectId(input.data.id);
    if (input.data.action === "ROTATE_SECRET") {
      const secret = generateBankFeedSecret();
      const updated = await db.collection("bankConnections").findOneAndUpdate(
        { _id: id },
        {
          $set: {
            encryptedWebhookSecret: encryptMemberToken(
              secret,
              secretContext(input.data.id),
            ),
            secretLast4: secret.slice(-4),
            status: "WAITING_FOR_FIRST_EVENT",
            updatedBy: new ObjectId(auth.session.id),
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after", projection },
      );
      if (!updated) return fail("The bank connection was not found.", 404);
      await writeAudit(
        db,
        auth.session,
        "bank_connection.rotate_secret",
        "bankConnection",
        input.data.id,
      );
      return ok(serialise({ ...updated, webhookSecret: secret }));
    }
    const updated = await db.collection("bankConnections").findOneAndUpdate(
      { _id: id },
      {
        $set: {
          active: input.data.active,
          status: input.data.active ? "WAITING_FOR_EVENT" : "DISABLED",
          updatedBy: new ObjectId(auth.session.id),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after", projection },
    );
    if (!updated) return fail("The bank connection was not found.", 404);
    await writeAudit(
      db,
      auth.session,
      input.data.active ? "bank_connection.enable" : "bank_connection.disable",
      "bankConnection",
      input.data.id,
    );
    return ok(serialise(updated));
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return fail(
        "That connection name or provider account is already in use.",
        409,
      );
    return publicError(error);
  }
}
