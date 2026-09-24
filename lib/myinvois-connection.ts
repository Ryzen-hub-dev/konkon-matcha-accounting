import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { decryptMemberToken, encryptMemberToken } from "@/lib/member-cards";

const CONNECTION_ID = "MYINVOIS";
const CLIENT_ID_CONTEXT = "tax:myinvois:client-id:v1";
const CLIENT_SECRET_CONTEXT = "tax:myinvois:client-secret:v1";
const ACCESS_TOKEN_CONTEXT = "tax:myinvois:access-token:v1";

const optionalCredential = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().min(1).max(300).optional(),
);

export const myInvoisConnectionInputSchema = z
  .object({
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    clientId: optionalCredential,
    clientSecret: optionalCredential,
  })
  .strict();

export type MyInvoisConnectionRecord = {
  _id: typeof CONNECTION_ID;
  environment: "SANDBOX" | "PRODUCTION";
  encryptedClientId: string;
  encryptedClientSecret: string;
  clientIdLast4: string;
  secretLast4: string;
  encryptedAccessToken?: string;
  accessTokenExpiresAt?: Date;
  accessTokenRefreshedAt?: Date;
  validatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export class MyInvoisError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

export function myInvoisSubmissionFailureState(error: unknown) {
  return error instanceof MyInvoisError && error.outcomeUnknown
    ? "REVIEW_REQUIRED"
    : "RETRY_ALLOWED";
}

export function myInvoisBaseUrl(
  environment: MyInvoisConnectionRecord["environment"],
) {
  return environment === "SANDBOX"
    ? "https://preprod-api.myinvois.hasil.gov.my"
    : "https://api.myinvois.hasil.gov.my";
}

export function safeMyInvoisConnection(
  record?: Partial<MyInvoisConnectionRecord> | null,
) {
  return record?.encryptedClientSecret
    ? {
        configured: true,
        provider: CONNECTION_ID,
        environment: record.environment || "SANDBOX",
        clientIdLast4: String(record.clientIdLast4 || ""),
        secretLast4: String(record.secretLast4 || ""),
        validatedAt: record.validatedAt || null,
      }
    : {
        configured: false,
        provider: CONNECTION_ID,
        environment: "SANDBOX" as const,
        clientIdLast4: "",
        secretLast4: "",
        validatedAt: null,
      };
}

export async function getMyInvoisConnection(db: Db) {
  return await db
    .collection<MyInvoisConnectionRecord>("taxConnections")
    .findOne({ _id: CONNECTION_ID });
}

async function requestToken(
  record: Pick<
    MyInvoisConnectionRecord,
    "environment" | "encryptedClientId" | "encryptedClientSecret"
  >,
  request: typeof fetch,
) {
  const clientId = decryptMemberToken(
    record.encryptedClientId,
    CLIENT_ID_CONTEXT,
  );
  const clientSecret = decryptMemberToken(
    record.encryptedClientSecret,
    CLIENT_SECRET_CONTEXT,
  );
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "InvoicingAPI",
  });
  let response: Response;
  try {
    response = await request(
      `${myInvoisBaseUrl(record.environment)}/connect/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      },
    );
  } catch {
    throw new MyInvoisError(
      "MyInvois could not be reached. Check the network and environment.",
      503,
    );
  }
  if ([400, 401, 403].includes(response.status))
    throw new MyInvoisError(
      "MyInvois rejected these ERP credentials or this environment.",
    );
  if (response.status === 429)
    throw new MyInvoisError(
      "MyInvois is rate-limiting logins. Reuse the cached session and try again later.",
      429,
    );
  if (!response.ok)
    throw new MyInvoisError(
      `MyInvois authentication failed (${response.status}).`,
      response.status >= 500 ? 503 : 422,
    );
  const result = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (
    !result ||
    typeof result.access_token !== "string" ||
    !result.access_token
  )
    throw new MyInvoisError(
      "MyInvois did not return a valid access token.",
      502,
    );
  const expiresIn =
    typeof result.expires_in === "number" && Number.isFinite(result.expires_in)
      ? Math.max(60, Math.min(result.expires_in, 3_600))
      : 3_600;
  return {
    token: result.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1_000),
  };
}

export async function getMyInvoisAccessToken(
  db: Db,
  record: MyInvoisConnectionRecord,
  request: typeof fetch = fetch,
  forceRefresh = false,
) {
  const expiresAt = record.accessTokenExpiresAt
    ? new Date(record.accessTokenExpiresAt)
    : null;
  if (
    !forceRefresh &&
    record.encryptedAccessToken &&
    expiresAt &&
    expiresAt.getTime() > Date.now() + 5 * 60_000
  ) {
    return decryptMemberToken(
      record.encryptedAccessToken,
      ACCESS_TOKEN_CONTEXT,
    );
  }
  const issued = await requestToken(record, request);
  await db.collection<MyInvoisConnectionRecord>("taxConnections").updateOne(
    { _id: CONNECTION_ID },
    {
      $set: {
        encryptedAccessToken: encryptMemberToken(
          issued.token,
          ACCESS_TOKEN_CONTEXT,
        ),
        accessTokenExpiresAt: issued.expiresAt,
        accessTokenRefreshedAt: new Date(),
      },
    },
  );
  return issued.token;
}

export async function saveMyInvoisConnection(
  db: Db,
  input: z.infer<typeof myInvoisConnectionInputSchema>,
  request: typeof fetch = fetch,
) {
  const current = await getMyInvoisConnection(db);
  const clientId =
    input.clientId ||
    (current
      ? decryptMemberToken(current.encryptedClientId, CLIENT_ID_CONTEXT)
      : "");
  const clientSecret =
    input.clientSecret ||
    (current
      ? decryptMemberToken(current.encryptedClientSecret, CLIENT_SECRET_CONTEXT)
      : "");
  if (!clientId || !clientSecret)
    throw new MyInvoisError(
      "Enter the MyInvois ERP Client ID and Client Secret for the first connection.",
    );
  const draft: MyInvoisConnectionRecord = {
    _id: CONNECTION_ID,
    environment: input.environment,
    encryptedClientId: encryptMemberToken(clientId, CLIENT_ID_CONTEXT),
    encryptedClientSecret: encryptMemberToken(
      clientSecret,
      CLIENT_SECRET_CONTEXT,
    ),
    clientIdLast4: clientId.slice(-4),
    secretLast4: clientSecret.slice(-4),
    validatedAt: new Date(),
    createdAt: current?.createdAt || new Date(),
    updatedAt: new Date(),
  };
  const issued = await requestToken(draft, request);
  draft.encryptedAccessToken = encryptMemberToken(
    issued.token,
    ACCESS_TOKEN_CONTEXT,
  );
  draft.accessTokenExpiresAt = issued.expiresAt;
  draft.accessTokenRefreshedAt = new Date();
  await db
    .collection<MyInvoisConnectionRecord>("taxConnections")
    .replaceOne({ _id: CONNECTION_ID }, draft, { upsert: true });
  return safeMyInvoisConnection(draft);
}

export async function deleteMyInvoisConnection(db: Db) {
  return (
    (
      await db
        .collection<MyInvoisConnectionRecord>("taxConnections")
        .deleteOne({ _id: CONNECTION_ID })
    ).deletedCount > 0
  );
}

async function authenticatedRequest(
  db: Db,
  record: MyInvoisConnectionRecord,
  path: string,
  init: RequestInit,
  request: typeof fetch,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getMyInvoisAccessToken(
      db,
      record,
      request,
      attempt > 0,
    );
    let response: Response;
    try {
      response = await request(
        `${myInvoisBaseUrl(record.environment)}${path}`,
        {
          ...init,
          headers: {
            Accept: "application/json",
            "Accept-Language": "en",
            ...init.headers,
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(20_000),
          cache: "no-store",
        },
      );
    } catch {
      const outcomeUnknown =
        String(init.method || "GET").toUpperCase() === "POST";
      throw new MyInvoisError(
        outcomeUnknown
          ? "The MyInvois submission result is unknown. Check the authority portal and link the submission UID before retrying."
          : "MyInvois could not be reached. The local document remains unchanged.",
        503,
        outcomeUnknown,
      );
    }
    if (response.status === 401 && attempt === 0) continue;
    return response;
  }
  throw new MyInvoisError(
    "MyInvois authentication could not be refreshed.",
    503,
  );
}

function submissionError(status: number) {
  if (status === 400)
    return "MyInvois rejected the submission structure. Generate a new reviewed document after correcting its official fields.";
  if (status === 403)
    return "MyInvois rejected the submitter or the connected ERP account lacks permission.";
  if (status === 422)
    return "MyInvois detected a duplicate submission. Wait for the authority retry interval before checking again.";
  if (status === 429)
    return "MyInvois is rate-limiting submissions. Try again after the authority retry interval.";
  if (status >= 500)
    return "MyInvois is temporarily unavailable. Do not generate a different invoice number; check status before retrying.";
  return `MyInvois could not accept the submission (${status}).`;
}

export function myInvoisSubmissionEnvelope(
  content: string,
  codeNumber: string,
) {
  let minified: string;
  try {
    minified = JSON.stringify(JSON.parse(content));
  } catch {
    throw new MyInvoisError("The saved MyInvois JSON is invalid.");
  }
  const bytes = Buffer.from(minified, "utf8");
  if (!bytes.length || bytes.length > 300_000)
    throw new MyInvoisError(
      "The MyInvois document must be no larger than 300 KB after minification.",
      413,
    );
  return {
    documents: [
      {
        format: "JSON",
        document: bytes.toString("base64"),
        documentHash: createHash("sha256").update(bytes).digest("hex"),
        codeNumber,
      },
    ],
  };
}

export async function submitMyInvoisDocument(
  db: Db,
  content: string,
  codeNumber: string,
  request: typeof fetch = fetch,
  expectedEnvironment?: MyInvoisConnectionRecord["environment"],
) {
  const connection = await getMyInvoisConnection(db);
  if (!connection)
    throw new MyInvoisError("Connect MyInvois in Settings before submitting.");
  if (expectedEnvironment && connection.environment !== expectedEnvironment)
    throw new MyInvoisError(
      "The MyInvois environment changed before submission. Review the connection and try again.",
      409,
    );
  const response = await authenticatedRequest(
    db,
    connection,
    "/api/v1.0/documentsubmissions/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(myInvoisSubmissionEnvelope(content, codeNumber)),
    },
    request,
  );
  if (!response.ok)
    throw new MyInvoisError(
      submissionError(response.status),
      response.status >= 500 ? 503 : response.status === 429 ? 429 : 422,
      response.status === 422 || response.status >= 500,
    );
  const result = (await response.json().catch(() => null)) as {
    submissionUid?: unknown;
    acceptedDocuments?: Array<Record<string, unknown>>;
    rejectedDocuments?: unknown[];
  } | null;
  if (
    !result ||
    typeof result.submissionUid !== "string" ||
    !result.submissionUid ||
    !Array.isArray(result.acceptedDocuments) ||
    !result.acceptedDocuments.length
  ) {
    throw new MyInvoisError(
      "MyInvois returned no accepted document identifier. Check the authority portal and link the submission UID before retrying.",
      502,
      true,
    );
  }
  const accepted = result.acceptedDocuments[0];
  return {
    submissionUid: result.submissionUid,
    uuid: typeof accepted.uuid === "string" ? accepted.uuid : "",
    internalId:
      typeof accepted.invoiceCodeNumber === "string"
        ? accepted.invoiceCodeNumber
        : codeNumber,
    environment: connection.environment,
  };
}

export async function getMyInvoisSubmission(
  db: Db,
  submissionUid: string,
  request: typeof fetch = fetch,
  expectedEnvironment?: MyInvoisConnectionRecord["environment"],
) {
  const connection = await getMyInvoisConnection(db);
  if (!connection)
    throw new MyInvoisError("The MyInvois connection is not configured.");
  if (expectedEnvironment && connection.environment !== expectedEnvironment)
    throw new MyInvoisError(
      `Reconnect the ${expectedEnvironment.toLowerCase()} MyInvois environment to check this submission.`,
      409,
    );
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(submissionUid))
    throw new MyInvoisError("The MyInvois submission reference is invalid.");
  const response = await authenticatedRequest(
    db,
    connection,
    `/api/v1.0/documentsubmissions/${encodeURIComponent(submissionUid)}?pageNo=1&pageSize=100`,
    { method: "GET" },
    request,
  );
  if (!response.ok)
    throw new MyInvoisError(
      submissionError(response.status),
      response.status >= 500 ? 503 : 422,
    );
  const result = (await response.json().catch(() => null)) as {
    overallStatus?: unknown;
    documentSummary?: Array<Record<string, unknown>>;
  } | null;
  if (
    !result ||
    typeof result.overallStatus !== "string" ||
    !Array.isArray(result.documentSummary)
  )
    throw new MyInvoisError(
      "MyInvois returned an invalid submission status.",
      502,
    );
  return {
    overallStatus: result.overallStatus,
    documents: result.documentSummary,
    environment: connection.environment,
  };
}
