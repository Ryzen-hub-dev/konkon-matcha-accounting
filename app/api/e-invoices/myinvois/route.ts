import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { unpackDocument } from "@/lib/document-storage";
import {
  getMyInvoisConnection,
  getMyInvoisSubmission,
  MyInvoisError,
  myInvoisSubmissionFailureState,
  submitMyInvoisDocument,
} from "@/lib/myinvois-connection";

export const runtime = "nodejs";
export const maxDuration = 30;

const inputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-fA-F0-9]{24}$/)
      .transform((value) => value.toLowerCase()),
    action: z.enum(["SUBMIT", "REFRESH_STATUS", "LINK_SUBMISSION"]),
    confirmed: z.literal(true),
    submissionUid: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{4,100}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "LINK_SUBMISSION" && !value.submissionUid) {
      context.addIssue({
        code: "custom",
        path: ["submissionUid"],
        message: "Enter the authority submission UID.",
      });
    }
  });

export async function POST(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("The request body must be valid JSON.", 400);
  }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success)
    return fail(
      "Confirm the MyInvois action and choose a generated document.",
      422,
      parsed.error.flatten().fieldErrors,
    );
  try {
    const db = await getDb();
    const _id = new ObjectId(parsed.data.id);
    const artifact = await db.collection("eInvoices").findOne({ _id });
    if (!artifact) return fail("The generated document was not found.", 404);
    if (
      artifact.format !== "MYINVOIS_JSON" ||
      artifact.countryCode !== "MY" ||
      artifact.currency !== "MYR"
    ) {
      return fail(
        "Only a reviewed Malaysian MYR MyInvois JSON document can use this authority connector.",
        422,
      );
    }
    if (parsed.data.action === "SUBMIT") {
      if (artifact.myInvoisSubmissionUid)
        return fail(
          "This document was already submitted. Refresh its authority status instead.",
          409,
        );
      let content: string;
      try {
        content = unpackDocument(
          {
            encryptedContent: artifact.encryptedContent,
            contentEncoding: artifact.contentEncoding,
            sha256: artifact.sha256,
          },
          `einvoice:${parsed.data.id}`,
        );
      } catch {
        return fail(
          "Document integrity check failed. Restore a verified backup before filing.",
          503,
        );
      }
      const connection = await getMyInvoisConnection(db);
      if (!connection)
        return fail("Connect MyInvois in Settings before submitting.", 409);
      const attemptId = randomUUID();
      const startedAt = new Date();
      const claimed = await db.collection("eInvoices").findOneAndUpdate(
        {
          _id,
          myInvoisSubmissionUid: { $exists: false },
          $or: [
            { myInvoisSubmissionState: { $exists: false } },
            { myInvoisSubmissionState: "RETRY_ALLOWED" },
          ],
        },
        {
          $set: {
            myInvoisSubmissionState: "IN_PROGRESS",
            myInvoisSubmissionAttemptId: attemptId,
            myInvoisSubmissionStartedAt: startedAt,
            myInvoisSubmissionStartedBy: new ObjectId(auth.session.id),
            myInvoisEnvironment: connection.environment,
            updatedAt: startedAt,
          },
        },
        { returnDocument: "after" },
      );
      if (!claimed) {
        const latest = await db.collection("eInvoices").findOne({ _id });
        if (latest?.myInvoisSubmissionUid)
          return fail(
            "This document was already submitted. Refresh its authority status instead.",
            409,
          );
        if (latest?.myInvoisSubmissionState === "REVIEW_REQUIRED")
          return fail(
            "The previous submission result is unknown. Check the MyInvois portal and link its submission UID before retrying.",
            409,
          );
        return fail(
          "A MyInvois submission is already in progress. Wait for it to finish before taking another action.",
          409,
        );
      }
      let submitted: Awaited<ReturnType<typeof submitMyInvoisDocument>>;
      try {
        submitted = await submitMyInvoisDocument(
          db,
          content,
          String(artifact.number || ""),
          fetch,
          connection.environment,
        );
      } catch (error) {
        const state = myInvoisSubmissionFailureState(error);
        const failedAt = new Date();
        await db.collection("eInvoices").updateOne(
          {
            _id,
            myInvoisSubmissionAttemptId: attemptId,
            myInvoisSubmissionUid: { $exists: false },
          },
          {
            $set: {
              myInvoisSubmissionState: state,
              status:
                state === "REVIEW_REQUIRED"
                  ? "MYINVOIS_REVIEW_REQUIRED"
                  : "GENERATED_NOT_SUBMITTED",
              myInvoisLastError:
                error instanceof MyInvoisError
                  ? error.message
                  : "The submission stopped before an authority result was recorded.",
              myInvoisSubmissionFinishedAt: failedAt,
              updatedAt: failedAt,
            },
          },
        );
        throw error;
      }
      const now = new Date();
      const result = await db.collection("eInvoices").updateOne(
        {
          _id,
          myInvoisSubmissionAttemptId: attemptId,
          myInvoisSubmissionState: "IN_PROGRESS",
        },
        {
          $set: {
            status: "SUBMITTED_PENDING_VALIDATION",
            validation: "MYINVOIS_SYNCHRONOUS_ACCEPTED",
            myInvoisSubmissionState: "SUBMITTED",
            myInvoisSubmissionUid: submitted.submissionUid,
            myInvoisUuid: submitted.uuid,
            myInvoisInternalId: submitted.internalId,
            myInvoisEnvironment: submitted.environment,
            myInvoisSubmittedAt: now,
            myInvoisSubmissionFinishedAt: now,
            myInvoisSubmittedBy: new ObjectId(auth.session.id),
            updatedAt: now,
          },
          $unset: { myInvoisLastError: "" },
        },
      );
      if (!result.modifiedCount) {
        await db.collection("eInvoices").updateOne(
          { _id, myInvoisSubmissionUid: { $exists: false } },
          {
            $set: {
              myInvoisSubmissionState: "REVIEW_REQUIRED",
              status: "MYINVOIS_REVIEW_REQUIRED",
              myInvoisLastError:
                "MyInvois accepted the document but the local acknowledgement needs recovery.",
              updatedAt: now,
            },
          },
        );
        return fail(
          "MyInvois accepted the document but the local acknowledgement needs recovery. Link the submission UID from the authority portal.",
          409,
        );
      }
      await writeAudit(
        db,
        auth.session,
        "einvoice.myinvois_submit",
        "eInvoice",
        parsed.data.id,
        {
          attemptId,
          submissionUid: submitted.submissionUid,
          uuid: submitted.uuid,
          environment: submitted.environment,
        },
      );
    } else if (parsed.data.action === "LINK_SUBMISSION") {
      if (artifact.myInvoisSubmissionUid)
        return fail(
          "This document already has an authority submission reference.",
          409,
        );
      if (
        artifact.myInvoisSubmissionState === "IN_PROGRESS" &&
        Date.now() -
          new Date(artifact.myInvoisSubmissionStartedAt || 0).getTime() <
          120_000
      ) {
        return fail(
          "The current submission is still in progress. Wait before recovering it.",
          409,
        );
      }
      const authority = await getMyInvoisSubmission(
        db,
        parsed.data.submissionUid!,
        fetch,
        artifact.myInvoisEnvironment,
      );
      const summary = authority.documents.find(
        (item) =>
          String(item.internalId || "") === String(artifact.number || ""),
      );
      if (!summary)
        return fail(
          "That MyInvois submission does not contain this document number.",
          422,
        );
      const documentStatus = String(
        summary.status || authority.overallStatus,
      ).toUpperCase();
      const now = new Date();
      const result = await db.collection("eInvoices").updateOne(
        { _id, myInvoisSubmissionUid: { $exists: false } },
        {
          $set: {
            status: `MYINVOIS_${documentStatus.replace(/[^A-Z]+/g, "_")}`,
            validation: "MYINVOIS_AUTHORITY_LINKED",
            myInvoisSubmissionState: "SUBMITTED",
            myInvoisSubmissionUid: parsed.data.submissionUid,
            myInvoisOverallStatus: authority.overallStatus,
            myInvoisDocumentStatus: String(summary.status || ""),
            myInvoisUuid: String(summary.uuid || ""),
            myInvoisLongId: String(summary.longId || ""),
            myInvoisInternalId: String(
              summary.internalId || artifact.number || "",
            ),
            myInvoisEnvironment: authority.environment,
            myInvoisLinkedAt: now,
            myInvoisLinkedBy: new ObjectId(auth.session.id),
            updatedAt: now,
          },
          $unset: { myInvoisLastError: "" },
        },
      );
      if (!result.modifiedCount)
        return fail(
          "Another session linked this document first. Refresh its status.",
          409,
        );
      await writeAudit(
        db,
        auth.session,
        "einvoice.myinvois_link",
        "eInvoice",
        parsed.data.id,
        {
          submissionUid: parsed.data.submissionUid,
          uuid: String(summary.uuid || ""),
          environment: authority.environment,
        },
      );
    } else {
      if (!artifact.myInvoisSubmissionUid)
        return fail("This document has not been submitted to MyInvois.", 409);
      if (
        artifact.myInvoisStatusCheckedAt &&
        Date.now() - new Date(artifact.myInvoisStatusCheckedAt).getTime() <
          3_000
      )
        return fail(
          "Wait at least three seconds before refreshing MyInvois status again.",
          429,
        );
      const authority = await getMyInvoisSubmission(
        db,
        String(artifact.myInvoisSubmissionUid),
        fetch,
        artifact.myInvoisEnvironment,
      );
      const summary =
        authority.documents.find(
          (item) =>
            String(item.uuid || "") === String(artifact.myInvoisUuid || ""),
        ) ||
        authority.documents.find(
          (item) =>
            String(item.internalId || "") === String(artifact.number || ""),
        ) ||
        authority.documents[0];
      const documentStatus = String(
        summary?.status || authority.overallStatus,
      ).toUpperCase();
      const now = new Date();
      await db.collection("eInvoices").updateOne(
        { _id },
        {
          $set: {
            status: `MYINVOIS_${documentStatus.replace(/[^A-Z]+/g, "_")}`,
            myInvoisSubmissionState: "SUBMITTED",
            myInvoisOverallStatus: authority.overallStatus,
            myInvoisDocumentStatus: String(summary?.status || ""),
            myInvoisUuid: String(summary?.uuid || artifact.myInvoisUuid || ""),
            myInvoisLongId: String(summary?.longId || ""),
            myInvoisStatusCheckedAt: now,
            updatedAt: now,
          },
        },
      );
      await writeAudit(
        db,
        auth.session,
        "einvoice.myinvois_status",
        "eInvoice",
        parsed.data.id,
        {
          submissionUid: artifact.myInvoisSubmissionUid,
          overallStatus: authority.overallStatus,
          documentStatus: String(summary?.status || ""),
        },
      );
    }
    const updated = await db.collection("eInvoices").findOne(
      { _id },
      {
        projection: {
          encryptedContent: 0,
            inputHash: 0,
            createdBy: 0,
            clientRequestId: 0,
            myInvoisSubmissionStartedBy: 0,
            myInvoisSubmittedBy: 0,
            myInvoisLinkedBy: 0,
        },
      },
    );
    return ok(updated);
  } catch (error) {
    if (error instanceof MyInvoisError)
      return fail(error.message, error.status);
    return publicError(error);
  }
}
