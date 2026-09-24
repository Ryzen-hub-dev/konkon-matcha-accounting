import "server-only";
import { createInterface, type Interface } from "node:readline";
import { connect, type TLSSocket } from "node:tls";
import type { Db } from "mongodb";
import { z } from "zod";
import { decryptMemberToken, encryptMemberToken } from "@/lib/member-cards";

const CONFIG_ID = "google-smtp-v1";
const PASSWORD_CONTEXT = "commerce:google-smtp:app-password:v1";

export const googleSmtpSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    senderName: z.string().trim().min(2).max(80),
    appPassword: z
      .preprocess(
        (value) =>
          typeof value === "string" ? value.replace(/\s+/g, "") : value,
        z.string().min(16).max(100),
      )
      .optional(),
  })
  .strict();

export type GoogleSmtpConfig = {
  _id: string;
  email: string;
  senderName: string;
  encryptedAppPassword: string;
  passwordLast4: string;
  verifiedAt: Date;
};

export function safeGoogleSmtp(config?: Partial<GoogleSmtpConfig> | null) {
  return config?.encryptedAppPassword
    ? {
        configured: true,
        email: String(config.email || ""),
        senderName: String(config.senderName || ""),
        passwordLast4: String(config.passwordLast4 || ""),
        verifiedAt: config.verifiedAt || null,
      }
    : {
        configured: false,
        email: "",
        senderName: "",
        passwordLast4: "",
        verifiedAt: null,
      };
}

export async function readGoogleSmtp(db: Db) {
  const record = await db
    .collection("commerceConnections")
    .findOne({ _id: CONFIG_ID as never });
  return record?.encryptedAppPassword
    ? (record as unknown as GoogleSmtpConfig)
    : null;
}

type SmtpResponse = { code: number; lines: string[] };

class SmtpSession {
  private responses: SmtpResponse[] = [];
  private waiters: Array<{
    resolve: (response: SmtpResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  private current: string[] = [];
  private lineReader: Interface;

  constructor(private socket: TLSSocket) {
    this.lineReader = createInterface({ input: socket, crlfDelay: Infinity });
    this.lineReader.on("line", (line) => {
      this.current.push(line);
      const match = /^(\d{3}) /.exec(line);
      if (!match) return;
      const response = { code: Number(match[1]), lines: this.current };
      this.current = [];
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(response);
      else this.responses.push(response);
    });
    const reject = (reason: Error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
    };
    socket.on("error", reject);
    socket.on("timeout", () => reject(new Error("Google SMTP timed out.")));
  }

  private next() {
    const response = this.responses.shift();
    if (response) return Promise.resolve(response);
    return new Promise<SmtpResponse>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async expect(codes: number[]) {
    const response = await this.next();
    if (!codes.includes(response.code))
      throw new Error(`Google SMTP rejected the request (${response.code}).`);
    return response;
  }

  async command(command: string, codes: number[]) {
    const response = this.expect(codes);
    this.socket.write(`${command}\r\n`);
    return response;
  }

  close() {
    this.lineReader.close();
    this.socket.end();
  }
}

async function openGoogleSmtp(email: string, appPassword: string) {
  const socket = connect({
    host: "smtp.gmail.com",
    port: 465,
    servername: "smtp.gmail.com",
    rejectUnauthorized: true,
  });
  socket.setTimeout(12_000);
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const smtp = new SmtpSession(socket);
  await smtp.expect([220]);
  await smtp.command("EHLO konkon-ledger", [250]);
  const login = Buffer.from(`\0${email}\0${appPassword}`).toString("base64");
  await smtp.command(`AUTH PLAIN ${login}`, [235]);
  return smtp;
}

export async function verifyGoogleSmtp(email: string, appPassword: string) {
  const smtp = await openGoogleSmtp(email, appPassword);
  try {
    await smtp.command("NOOP", [250]);
    await smtp.command("QUIT", [221]);
  } finally {
    smtp.close();
  }
}

export async function saveGoogleSmtp(
  db: Db,
  input: z.infer<typeof googleSmtpSchema>,
) {
  const current = await readGoogleSmtp(db);
  const appPassword =
    input.appPassword ||
    (current
      ? decryptMemberToken(current.encryptedAppPassword, PASSWORD_CONTEXT)
      : "");
  if (!appPassword)
    throw new Error("Enter a Google app password for the first connection.");
  await verifyGoogleSmtp(input.email, appPassword);
  const now = new Date();
  const record: GoogleSmtpConfig = {
    _id: CONFIG_ID,
    email: input.email,
    senderName: input.senderName,
    encryptedAppPassword: encryptMemberToken(appPassword, PASSWORD_CONTEXT),
    passwordLast4: appPassword.slice(-4),
    verifiedAt: now,
  };
  await db.collection("commerceConnections").replaceOne(
    { _id: CONFIG_ID as never },
    { ...record, updatedAt: now },
    { upsert: true },
  );
  return safeGoogleSmtp(record);
}

function mimeWord(value: string) {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildGoogleSmtpMessage(input: {
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const boundary = `konkon-${Date.now().toString(36)}`;
  return [
    `From: ${mimeWord(safeHeader(input.fromName))} <${safeHeader(input.fromEmail)}>`,
    `To: <${safeHeader(input.to)}>`,
    `Subject: ${mimeWord(safeHeader(input.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.text).toString("base64"),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.html).toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export async function sendGoogleSmtp(
  config: GoogleSmtpConfig,
  message: { to: string; subject: string; text: string; html: string },
) {
  const appPassword = decryptMemberToken(
    config.encryptedAppPassword,
    PASSWORD_CONTEXT,
  );
  const smtp = await openGoogleSmtp(config.email, appPassword);
  try {
    await smtp.command(`MAIL FROM:<${config.email}>`, [250]);
    await smtp.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await smtp.command("DATA", [354]);
    const content = buildGoogleSmtpMessage({
      fromEmail: config.email,
      fromName: config.senderName,
      ...message,
    }).replace(/^\./gm, "..");
    await smtp.command(`${content}\r\n.`, [250]);
    await smtp.command("QUIT", [221]);
  } finally {
    smtp.close();
  }
}
