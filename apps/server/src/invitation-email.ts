import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Transaction } from "./database.js";
import { DeliveryError, type EmailRequest } from "./email.js";
export interface InvitationMailConfig {
  key: Buffer;
  from: string;
  appUrl: string;
}
export function invitationMailFromEnvironment():
  InvitationMailConfig | undefined {
  if (process.env.INVITATION_EMAIL_ENABLED !== "true") return undefined;
  const encoded = process.env.INVITATION_EMAIL_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded))
    throw new Error(
      "INVITATION_EMAIL_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("Invalid invitation email encryption key");
  const from = process.env.EMAIL_FROM ?? "";
  if (!from.trim() || from.length > 254 || /[\r\n]/.test(from))
    throw new Error("Invitation email requires EMAIL_FROM");
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("Invitation email requires APP_URL");
  const site = new URL(appUrl);
  if (
    (site.protocol !== "https:" &&
      !(
        site.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(site.hostname)
      )) ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/"
  )
    throw new Error(
      "APP_URL must be a trusted HTTPS app origin (HTTP allowed only on loopback)",
    );
  return { key, from, appUrl: site.origin };
}
export function encryptInvitation(
  request: EmailRequest,
  key: Buffer,
  orgId: string,
  invitationId: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`lira-invitation-v1:${orgId}:${invitationId}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(request), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}
export function decryptInvitation(
  payload: string,
  key: Buffer,
  orgId: string,
  invitationId: string,
): EmailRequest {
  try {
    const [version, iv, tag, data, ...rest] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !data || rest.length)
      throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    decipher.setAAD(Buffer.from(`lira-invitation-v1:${orgId}:${invitationId}`));
    const parsed = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(data, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as EmailRequest;
    if (
      typeof parsed.from !== "string" ||
      !Array.isArray(parsed.to) ||
      parsed.to.length !== 1 ||
      typeof parsed.to[0] !== "string" ||
      typeof parsed.subject !== "string" ||
      typeof parsed.text !== "string"
    )
      throw new Error();
    return parsed;
  } catch {
    throw new DeliveryError("email_unavailable");
  }
}
export async function queueInvitationEmail(
  tx: Transaction,
  orgId: string,
  actorId: string,
  invitation: { id: string; email: string },
  token: string,
  config: InvitationMailConfig,
) {
  const link = new URL(config.appUrl);
  link.hash = `invite=${token}`;
  const request: EmailRequest = {
    from: config.from,
    to: [invitation.email],
    subject: "You are invited to a Lira workspace",
    text: `You have been invited to join a club workspace in Lira.\n\nSign in or create an account using ${invitation.email}, verify that email, then accept this invitation:\n${link.toString()}\n\nThe invitation expires after seven days and may be revoked earlier. If you were not expecting it, you can ignore this email.`,
  };
  const eventId = randomUUID();
  await tx.query(
    "INSERT INTO app.activity_events(id,org_id,actor_membership_id,action,changes) VALUES($1,$2,$3,'invitation.email_queued',$4)",
    [eventId, orgId, actorId, JSON.stringify({ invitationId: invitation.id })],
  );
  await tx.query(
    "INSERT INTO app.invitation_emails(org_id,invitation_id,event_id,encrypted_payload) VALUES($1,$2,$3,$4)",
    [
      orgId,
      invitation.id,
      eventId,
      encryptInvitation(request, config.key, orgId, invitation.id),
    ],
  );
  await tx.query(
    "INSERT INTO app.outbox_jobs(org_id,event_id,type,payload) VALUES($1,$2,'invitation.email',$3)",
    [orgId, eventId, JSON.stringify({ invitationId: invitation.id })],
  );
  const expiry = (
    await tx.query(
      "INSERT INTO app.activity_events(org_id,actor_membership_id,action,changes) VALUES($1,$2,'invitation.email_expiry_scheduled',$3) RETURNING id",
      [orgId, actorId, JSON.stringify({ invitationId: invitation.id })],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO app.outbox_jobs(org_id,event_id,type,payload,run_at) VALUES($1,$2,'invitation.email_expire',$3,now()+interval '20 hours')",
    [orgId, expiry.id, JSON.stringify({ invitationId: invitation.id })],
  );
}
