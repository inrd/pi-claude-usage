/**
 * Claude Usage Extension
 *
 * Mirrors the "Current session" / "This week" usage meters from claude.ai
 * (Settings > Usage) directly in the Pi footer.
 *
 * Reads the Claude Code OAuth token from the macOS Keychain (same token
 * `claude` the CLI uses) and polls Anthropic's `/api/oauth/usage` endpoint.
 *
 * Requires that you've run `claude` at least once and signed in (so a
 * token exists in the "Claude Code-credentials" Keychain item on macOS,
 * or in `~/.claude/.credentials.json` on Linux).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

interface UsageWindow {
	utilization: number; // 0-100
	resets_at: string | null;
}

interface UsageResponse {
	five_hour?: UsageWindow | null;
	seven_day?: UsageWindow | null;
}

interface MinimalModel {
	provider?: string;
	id?: string;
}

async function readTokenMac(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			"Claude Code-credentials",
			"-w",
		]);
		const data = JSON.parse(stdout.trim());
		return data?.claudeAiOauth?.accessToken;
	} catch {
		return undefined;
	}
}

async function readTokenFile(): Promise<string | undefined> {
	try {
		const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
		const data = JSON.parse(raw);
		return data?.claudeAiOauth?.accessToken;
	} catch {
		return undefined;
	}
}

async function getToken(): Promise<string | undefined> {
	if (platform() === "darwin") {
		return (await readTokenMac()) ?? (await readTokenFile());
	}
	return readTokenFile();
}

let backoffUntil = 0;

async function fetchUsage(): Promise<UsageResponse | undefined> {
	if (Date.now() < backoffUntil) return undefined;
	const token = await getToken();
	if (!token) return undefined;
	const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
	});
	if (res.status === 429) {
		const retry = Number(res.headers.get("retry-after")) || 300;
		backoffUntil = Date.now() + retry * 1000;
		return undefined;
	}
	if (!res.ok) return undefined;
	return (await res.json()) as UsageResponse;
}

function formatReset(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	if (sameDay) return `resets ${time}`;
	const day = d.toLocaleDateString([], { weekday: "short" });
	return `resets ${day} ${time}`;
}

function bar(pct: number, width = 8): string {
	const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function isClaudeModel(model: MinimalModel | undefined): boolean {
	if (!model) return false;
	const p = (model.provider ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	return p === "anthropic" || p === "claude-code" || id.includes("claude");
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastUsage: UsageResponse | undefined;
	let lastError = false;

	async function refresh(ctx: ExtensionContext, model: MinimalModel | undefined = ctx.model) {
		if (!isClaudeModel(model)) {
			ctx.ui.setStatus("claude-usage", undefined);
			return;
		}
		try {
			const usage = await fetchUsage();
			lastError = !usage;
			if (usage) lastUsage = usage;
			if (!usage && lastUsage) lastError = false; // keep showing last known values
			render(ctx);
		} catch {
			lastError = true;
			render(ctx);
		}
	}

	function render(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		if (!lastUsage) {
			ctx.ui.setStatus(
				"claude-usage",
				lastError ? theme.fg("dim", "usage: unavailable") : theme.fg("dim", "usage: loading..."),
			);
			return;
		}
		const parts: string[] = [];
		if (lastUsage.five_hour) {
			const u = lastUsage.five_hour.utilization;
			const color = u >= 90 ? "error" : u >= 70 ? "warning" : "dim";
			parts.push(theme.fg(color, `5h ${bar(u)} ${u.toFixed(0)}%`));
		}
		if (lastUsage.seven_day) {
			const u = lastUsage.seven_day.utilization;
			const color = u >= 90 ? "error" : u >= 70 ? "warning" : "dim";
			parts.push(theme.fg(color, `wk ${bar(u)} ${u.toFixed(0)}%`));
		}
		ctx.ui.setStatus("claude-usage", parts.join("  "));
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
		timer = setInterval(() => refresh(ctx), 180_000);
	});

	pi.on("model_select", async (event, ctx) => {
		if (isClaudeModel(event.model)) {
			// ctx.model may lag behind the event; render with what we have, then refresh
			if (lastUsage) render(ctx);
			await refresh(ctx, event.model);
		} else {
			ctx.ui.setStatus("claude-usage", undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show Claude subscription usage (5h session + weekly limits)",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			if (!lastUsage) {
				ctx.ui.notify(
					"Could not read Claude usage. Make sure you've signed in with `claude` (Claude Code CLI).",
					"error",
				);
				return;
			}
			const lines: string[] = [];
			if (lastUsage.five_hour) {
				const w = lastUsage.five_hour;
				lines.push(`Current session: ${w.utilization.toFixed(0)}% used (${formatReset(w.resets_at)})`);
			}
			if (lastUsage.seven_day) {
				const w = lastUsage.seven_day;
				lines.push(`This week: ${w.utilization.toFixed(0)}% used (${formatReset(w.resets_at)})`);
			}
			ctx.ui.notify(lines.join("\n") || "No usage data returned.", "info");
		},
	});
}
