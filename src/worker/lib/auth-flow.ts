import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { EmailMessage } from "cloudflare:email";
import { getDb, accounts, loginCodes } from "../../db";
import { generateLoginCode, hashLoginCode } from "./keys";

const CODE_TTL_MS = 10 * 60 * 1000;
const FROM_NAME = "headlesstools";

export type LoginSendPath = "structured" | "mime";
export type LoginSendError = { code: string; message: string };
export type LoginSendResult = {
	sendPath?: LoginSendPath;
	sendError?: LoginSendError;
};

function authFrom(env: Env): string {
	return `auth@${env.INBOX_DOMAIN}`;
}

function headerSafe(value: string): string {
	return value.replace(/[\r\n\u0000]+/g, " ").trim();
}

function redactSecrets(value: string): string {
	return value.replace(/\b\d{6}\b/g, "[code]").slice(0, 1_000);
}

function publicSendError(error: unknown): LoginSendError {
	const codeValue =
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code != null
			? String((error as { code: unknown }).code)
			: error instanceof Error
				? error.name
				: "unknown";
	const message = error instanceof Error ? error.message : String(error);
	return {
		code: redactSecrets(codeValue).slice(0, 128) || "unknown",
		message: redactSecrets(message) || "email send failed",
	};
}

function isBindingMismatch(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	const code =
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code != null
			? String((error as { code: unknown }).code)
			: "";
	// Email Service returns E_* codes. Anything else is treated as a binding/API
	// mismatch so we can retry once with the legacy EmailMessage MIME path.
	if (code.startsWith("E_")) return false;
	return true;
}

function buildLoginMime(from: string, to: string, subject: string, text: string, html: string): string {
	const boundary = `----=_HT_${crypto.randomUUID().replaceAll("-", "")}`;
	const crlf = "\r\n";
	return [
		`From: ${headerSafe(FROM_NAME)} <${headerSafe(from)}>`,
		`To: ${headerSafe(to)}`,
		`Subject: ${headerSafe(subject)}`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		`Content-Type: text/plain; charset="UTF-8"`,
		"Content-Transfer-Encoding: 7bit",
		"",
		text,
		`--${boundary}`,
		`Content-Type: text/html; charset="UTF-8"`,
		"Content-Transfer-Encoding: 7bit",
		"",
		html,
		`--${boundary}--`,
		"",
	].join(crlf);
}

async function persistSendResult(env: Env, loginCodeId: string, result: LoginSendResult) {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS login_code_send_results (
			login_code_id TEXT PRIMARY KEY,
			send_path TEXT,
			error_code TEXT,
			error_message TEXT,
			created_at INTEGER NOT NULL
		)`,
	).run();
	await env.DB.prepare(
		`INSERT OR REPLACE INTO login_code_send_results (login_code_id, send_path, error_code, error_message, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			loginCodeId,
			result.sendPath ?? "none",
			result.sendError?.code ?? null,
			result.sendError?.message ?? null,
			Math.floor(Date.now() / 1000),
		)
		.run();
}

export async function sendLoginCode(env: Env, email: string): Promise<LoginSendResult> {
	const code = generateLoginCode();
	const codeHash = await hashLoginCode(code);
	const now = Date.now();
	const id = crypto.randomUUID();
	const from = authFrom(env);
	const subject = `${code} is your headlesstools login code`;
	const text = `Your login code is ${code}. It expires in 10 minutes.`;
	const html = `<p>Your login code is <strong>${code}</strong>. It expires in 10 minutes.</p>`;

	// D1 batch is transactional: concurrent requests leave only the newest code
	// usable instead of accumulating several valid codes for one address.
	await env.DB.batch([
		env.DB.prepare("UPDATE login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL").bind(
			Math.floor(now / 1000),
			email,
		),
		env.DB.prepare(
			"INSERT INTO login_codes (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
		).bind(id, email, codeHash, Math.floor((now + CODE_TTL_MS) / 1000), Math.floor(now / 1000)),
	]);

	let result: LoginSendResult = {};
	try {
		await env.EMAIL.send({
			to: email,
			from: { email: from, name: FROM_NAME },
			subject,
			text,
			html,
		});
		result = { sendPath: "structured" };
	} catch (structuredError) {
		if (isBindingMismatch(structuredError)) {
			try {
				const mime = buildLoginMime(from, email, subject, text, html);
				await env.EMAIL.send(new EmailMessage(from, email, mime));
				result = { sendPath: "mime" };
			} catch (mimeError) {
				result = { sendError: publicSendError(mimeError) };
			}
		} else {
			result = { sendError: publicSendError(structuredError) };
		}
		if (result.sendError) {
			console.error(
				JSON.stringify({
					message: "login code email send failed",
					sendPath: result.sendPath ?? "none",
					code: result.sendError.code,
					error: result.sendError.message,
				}),
			);
		}
	}

	try {
		await persistSendResult(env, id, result);
	} catch (persistError) {
		console.error(
			JSON.stringify({
				message: "login code send result persist failed",
				error: persistError instanceof Error ? persistError.message : String(persistError),
			}),
		);
	}

	return result;
}

export async function resolveAccountFromCode(db: ReturnType<typeof getDb>, email: string, code: string) {
	const codeHash = await hashLoginCode(code);

	const [row] = await db
		.select()
		.from(loginCodes)
		.where(
			and(
				eq(loginCodes.email, email),
				eq(loginCodes.codeHash, codeHash),
				isNull(loginCodes.consumedAt),
				gt(loginCodes.expiresAt, new Date()),
			),
		)
		.orderBy(desc(loginCodes.createdAt))
		.limit(1);

	if (!row) return null;

	const consumed = await db
		.update(loginCodes)
		.set({ consumedAt: new Date() })
		.where(and(eq(loginCodes.id, row.id), isNull(loginCodes.consumedAt), gt(loginCodes.expiresAt, new Date())))
		.returning();
	if (consumed.length === 0) return null;

	let [account] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
	if (!account) {
		[account] = await db.insert(accounts).values({ email }).onConflictDoNothing().returning();
		if (!account) [account] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
	}

	return account;
}
