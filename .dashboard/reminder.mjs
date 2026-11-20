// Installed by Streak Dashboard. Checks today's real contributions and nudges you if there are none.
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(".dashboard/settings.json", "utf8"));
const env = process.env;
const force = env.FORCE === "true";
const tz = cfg.timezone || "UTC";
const now = new Date();

const parts = {};
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
for (const p of fmt.formatToParts(now)) if (p.type !== "literal") parts[p.type] = Number(p.value);

const reminder = cfg.reminder || {};
if (!force && (!reminder.enabled || parts.hour !== reminder.hour)) {
  console.log("Not reminder time: " + parts.hour + ":00 in " + tz + " (reminder at " + reminder.hour + ":00, enabled=" + !!reminder.enabled + ")");
  process.exit(0);
}

// Start of "today" in the chosen timezone, as UTC.
const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
const from = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset).toISOString();

const query = "query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){" +
  "totalIssueContributions totalPullRequestContributions totalPullRequestReviewContributions " +
  "commitContributionsByRepository(maxRepositories:100){repository{name} contributions{totalCount}}}}}";
const res = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: { Authorization: "Bearer " + env.GH_TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { login: env.GH_LOGIN, from, to: now.toISOString() } }),
});
const json = await res.json();
if (!json.data || json.errors) {
  console.error("GitHub query failed:", JSON.stringify(json));
  process.exit(1);
}
const c = json.data.user.contributionsCollection;
const bot = String(cfg.botRepo || "").toLowerCase();
const commits = c.commitContributionsByRepository
  .filter((r) => r.repository.name.toLowerCase() !== bot)
  .reduce((s, r) => s + r.contributions.totalCount, 0);
const real = commits + c.totalIssueContributions + c.totalPullRequestContributions + c.totalPullRequestReviewContributions;
console.log("Real contributions today (" + tz + "): " + real);

if (real > 0 && !force) process.exit(0);

let text = real > 0
  ? "You already have " + real + " real contribution(s) today. Nice work!"
  : "No real contributions yet today. Write a log entry or push some code to keep your streak going.";
if (force) text = "[Test] " + text;
if (cfg.dashboardUrl) text += "\n" + cfg.dashboardUrl;

async function telegram(msg) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets are not set");
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
  });
  if (!r.ok) throw new Error("Telegram " + r.status + ": " + (await r.text()));
}

async function email(msg) {
  if (!env.RESEND_API_KEY || !env.REMINDER_EMAIL) throw new Error("RESEND_API_KEY / REMINDER_EMAIL secrets are not set");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Streak Reminder <onboarding@resend.dev>",
      to: [env.REMINDER_EMAIL],
      subject: force ? "Streak reminder (test)" : "Keep your streak going",
      text: msg,
    }),
  });
  if (!r.ok) throw new Error("Resend " + r.status + ": " + (await r.text()));
}

await (reminder.channel === "email" ? email(text) : telegram(text));
console.log("Reminder sent via " + (reminder.channel || "telegram"));
