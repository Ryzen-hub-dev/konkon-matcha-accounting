import "server-only";
import type { Db } from "mongodb";
import { z } from "zod";
import { decryptMemberToken, encryptMemberToken } from "@/lib/member-cards";

const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_CONTEXT = "attachment-storage:github-token:v1";
const settingId = "github-private-v1";

export const attachmentStorageInputSchema = z.object({
  owner: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repository: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  branch: z.string().trim().min(1).max(160).regex(/^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[]))[A-Za-z0-9._/-]+(?<![./])$/),
  basePath: z.string().trim().max(180).default("konkon-evidence").transform((value) => value.replace(/^\/+|\/+$/g, "") || "konkon-evidence").refine((value) => value.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part))),
  token: z.string().trim().max(500).optional(),
}).strict();

export type AttachmentStorageConfig = {
  owner: string;
  repository: string;
  branch: string;
  basePath: string;
  encryptedToken: string;
  tokenLast4: string;
  validatedAt: Date;
};

function headers(token: string, accept = "application/vnd.github+json") {
  return { Accept: accept, Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "konkon-matcha-ledger" };
}

async function githubError(response: Response) {
  if (response.status === 401 || response.status === 403) return "GitHub rejected this token or its repository permissions.";
  if (response.status === 404) return "GitHub could not find this private repository or branch with the supplied token.";
  if (response.status === 409) return "The GitHub repository is empty or the branch is not ready. Add an initial commit first.";
  if (response.status === 422) return "GitHub rejected the repository path or file payload.";
  return `GitHub storage is temporarily unavailable (${response.status}).`;
}

export function safeAttachmentStorage(config?: Partial<AttachmentStorageConfig> | null) {
  return config?.encryptedToken ? {
    configured: true,
    owner: String(config.owner || ""), repository: String(config.repository || ""), branch: String(config.branch || ""),
    basePath: String(config.basePath || ""), tokenLast4: String(config.tokenLast4 || ""), validatedAt: config.validatedAt || null,
  } : { configured: false, owner: "", repository: "", branch: "main", basePath: "konkon-evidence", tokenLast4: "", validatedAt: null };
}

export async function getAttachmentStorageConfig(db: Db): Promise<AttachmentStorageConfig | null> {
  const record = await db.collection("attachmentStorageSettings").findOne({ _id: settingId as never });
  return record?.encryptedToken ? record as unknown as AttachmentStorageConfig : null;
}

export async function validateGithubStorage(input: Omit<AttachmentStorageConfig, "encryptedToken" | "tokenLast4" | "validatedAt">, token: string) {
  const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`;
  const repositoryResponse = await fetch(repositoryUrl, { headers: headers(token), signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!repositoryResponse.ok) throw new Error(await githubError(repositoryResponse));
  const repository = await repositoryResponse.json() as { private?: boolean; permissions?: { push?: boolean } };
  if (repository.private !== true) throw new Error("Choose a private GitHub repository. Public repositories are not accepted for evidence storage.");
  if (repository.permissions?.push !== true) throw new Error("This token needs Contents read and write access to the selected repository.");
  const branchResponse = await fetch(`${repositoryUrl}/branches/${encodeURIComponent(input.branch)}`, { headers: headers(token), signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!branchResponse.ok) throw new Error(await githubError(branchResponse));
}

export async function saveAttachmentStorageConfig(db: Db, input: z.infer<typeof attachmentStorageInputSchema>) {
  const current = await getAttachmentStorageConfig(db);
  const token = input.token || (current ? decryptMemberToken(current.encryptedToken, TOKEN_CONTEXT) : "");
  if (!token) throw new Error("Enter a fine-grained GitHub token the first time you configure storage.");
  const plain = { owner: input.owner, repository: input.repository, branch: input.branch, basePath: input.basePath };
  await validateGithubStorage(plain, token);
  const now = new Date();
  const saved: AttachmentStorageConfig = { ...plain, encryptedToken: encryptMemberToken(token, TOKEN_CONTEXT), tokenLast4: token.slice(-4), validatedAt: now };
  await db.collection("attachmentStorageSettings").updateOne(
    { _id: settingId as never },
    { $set: { ...saved, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  return safeAttachmentStorage(saved);
}

function storagePath(config: AttachmentStorageConfig, relativePath: string) {
  const safeParts = relativePath.split("/").filter(Boolean);
  if (!safeParts.length || safeParts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) throw new Error("The attachment storage path is invalid.");
  return [config.basePath, ...safeParts].filter(Boolean).join("/");
}

function repoContentsUrl(config: AttachmentStorageConfig, path: string) {
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function putPrivateAttachment(config: AttachmentStorageConfig, relativePath: string, bytes: Buffer, message: string) {
  const token = decryptMemberToken(config.encryptedToken, TOKEN_CONTEXT);
  const path = storagePath(config, relativePath);
  const response = await fetch(repoContentsUrl(config, path), {
    method: "PUT", headers: { ...headers(token), "Content-Type": "application/json" }, signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ message, content: bytes.toString("base64"), branch: config.branch }), cache: "no-store",
  });
  if (!response.ok) throw new Error(await githubError(response));
  const body = await response.json() as { content?: { sha?: string }; commit?: { sha?: string } };
  if (!body.content?.sha || !body.commit?.sha) throw new Error("GitHub did not confirm the stored attachment.");
  return { path, blobSha: body.content.sha, commitSha: body.commit.sha };
}

export async function getPrivateAttachment(config: AttachmentStorageConfig, storedPath: string) {
  const expectedPrefix = `${config.basePath}/`;
  if (!storedPath.startsWith(expectedPrefix)) throw new Error("The attachment path is outside the configured evidence area.");
  const token = decryptMemberToken(config.encryptedToken, TOKEN_CONTEXT);
  const url = `${repoContentsUrl(config, storedPath)}?ref=${encodeURIComponent(config.branch)}`;
  const response = await fetch(url, { headers: headers(token, "application/vnd.github.raw+json"), signal: AbortSignal.timeout(25_000), cache: "no-store" });
  if (!response.ok) throw new Error(await githubError(response));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 16 * 1024 * 1024) throw new Error("The stored attachment exceeds the protected download limit.");
  return bytes;
}
