import { env } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { describe, expect, it } from "vitest";
import { sendLoginCode } from "../src/worker/lib/auth-flow";
import authRoutes from "../src/worker/routes/auth";

type SendFn = (payload: unknown) => Promise<{ messageId: string }>;

function envWithEmail(send: SendFn): Env {
	return {
		DB: env.DB,
		INBOX_DOMAIN: env.INBOX_DOMAIN,
		LOGIN_CODE_RATE_LIMITER: env.LOGIN_CODE_RATE_LIMITER,
		EMAIL: { send },
	} as unknown as Env;
}

function emailError(code: string, message: string): Error {
	const error = new Error(message);
	(error as Error & { code: string }).code = code;
	return error;
}

function isStructuredPayload(payload: unknown): payload is {
	to: string;
	from: { email: string; name?: string };
	subject: string;
} {
	return (
		!!payload &&
		typeof payload === "object" &&
		"to" in payload &&
		"from" in payload &&
		"subject" in payload &&
		!(payload instanceof EmailMessage)
	);
}

async function sendResultForEmail(email: string) {
	const code = await env.DB.prepare("SELECT id FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1")
		.bind(email)
		.first<{ id: string }>();
	expect(code?.id).toBeTruthy();
	return env.DB.prepare(
		"SELECT send_path, error_code, error_message FROM login_code_send_results WHERE login_code_id = ?",
	)
		.bind(code!.id)
		.first<{ send_path: string; error_code: string | null; error_message: string | null }>();
}

describe("login code email send", () => {
	it("awaits structured EMAIL.send from auth@INBOX_DOMAIN", async () => {
		const payloads: unknown[] = [];
		const testEnv = envWithEmail(async (payload) => {
			payloads.push(payload);
			return { messageId: crypto.randomUUID() };
		});
		const email = `${crypto.randomUUID()}@example.com`;

		const result = await sendLoginCode(testEnv, email);

		expect(result).toEqual({ sendPath: "structured" });
		expect(payloads).toHaveLength(1);
		expect(payloads[0]).toMatchObject({
			to: email,
			from: { email: `auth@${env.INBOX_DOMAIN}`, name: "headlesstools" },
		});
		expect(await sendResultForEmail(email)).toMatchObject({
			send_path: "structured",
			error_code: null,
			error_message: null,
		});
	});

	it("retries once with EmailMessage MIME when structured send is a binding mismatch", async () => {
		const payloads: unknown[] = [];
		const testEnv = envWithEmail(async (payload) => {
			payloads.push(payload);
			if (isStructuredPayload(payload)) {
				throw new TypeError("EMAIL.send expected EmailMessage");
			}
			return { messageId: crypto.randomUUID() };
		});
		const email = `${crypto.randomUUID()}@example.com`;

		const result = await sendLoginCode(testEnv, email);

		expect(result).toEqual({ sendPath: "mime" });
		expect(payloads).toHaveLength(2);
		expect(isStructuredPayload(payloads[0])).toBe(true);
		expect(isStructuredPayload(payloads[1])).toBe(false);
		expect(await sendResultForEmail(email)).toMatchObject({ send_path: "mime", error_code: null });
	});

	it("does not MIME-retry Email Service E_* failures and returns sendError", async () => {
		let sends = 0;
		const testEnv = envWithEmail(async () => {
			sends += 1;
			throw emailError("E_SENDER_NOT_ALLOWED", "sender not allowed for 123456");
		});
		const email = `${crypto.randomUUID()}@example.com`;

		const result = await sendLoginCode(testEnv, email);

		expect(sends).toBe(1);
		expect(result.sendPath).toBeUndefined();
		expect(result.sendError).toEqual({
			code: "E_SENDER_NOT_ALLOWED",
			message: "sender not allowed for [code]",
		});
		expect(JSON.stringify(result)).not.toMatch(/\b\d{6}\b/);
		expect(await sendResultForEmail(email)).toMatchObject({
			send_path: "none",
			error_code: "E_SENDER_NOT_ALLOWED",
			error_message: "sender not allowed for [code]",
		});
	});

	it("returns sendError when structured and MIME sends both fail", async () => {
		const testEnv = envWithEmail(async (payload) => {
			if (isStructuredPayload(payload)) {
				throw new TypeError("not a send_email payload");
			}
			throw emailError("mime_failed", "legacy path rejected 654321");
		});
		const email = `${crypto.randomUUID()}@example.com`;

		const result = await sendLoginCode(testEnv, email);

		expect(result.sendError).toEqual({
			code: "mime_failed",
			message: "legacy path rejected [code]",
		});
		expect(await sendResultForEmail(email)).toMatchObject({
			send_path: "none",
			error_code: "mime_failed",
		});
	});

	it("POST /signup returns sendError without dropping ok:true", async () => {
		const testEnv = envWithEmail(async () => {
			throw emailError("E_UNKNOWN", "delivery failed");
		});

		const response = await authRoutes.request(
			"/signup",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: `${crypto.randomUUID()}@example.com` }),
			},
			testEnv,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			sendPath: "none",
			sendError: { code: "E_UNKNOWN", message: "delivery failed" },
		});
	});
});
