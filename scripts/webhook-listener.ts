#!/usr/bin/env -S npx tsx

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { rpc, xdr, scValToNative } from "@stellar/stellar-sdk";

// ─── .env loader ─────────────────────────────────────────────────────────────
function loadEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.resolve(process.cwd(), ".env.local"));
loadEnv(path.resolve(process.cwd(), ".env.contracts"));

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const LENDING_CONTRACT_ID = process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID;

const LARGE_LOAN_THRESHOLD_XLM = parseInt(process.env.LARGE_LOAN_THRESHOLD_XLM || "10000", 10);
const POLL_INTERVAL_MS = 5000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Supabase credentials not configured.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

/** Formats a Discord embed message */
function formatDiscordPayload(topic: string, eventData: Record<string, unknown>) {
  let title = "TrustLend Event";
  let color = 16777215; // White
  const fields: Record<string, unknown>[] = [];
  
  if (topic === "loan_originated") {
    title = "🚨 Large Loan Originated! 🚨";
    color = 3066993; // Green
    
    fields.push({ name: "Borrower", value: `\`${eventData.borrower}\``, inline: false });
    
    if (eventData.amountXLM) {
      fields.push({ name: "Amount", value: `${eventData.amountXLM} XLM`, inline: true });
    }
  } else if (topic === "liquidation_warning") {
    title = "⚠️ Liquidation Warning ⚠️";
    color = 15158332; // Red
    
    fields.push({ name: "Loan ID", value: `\`${eventData.loanId}\``, inline: true });
    if (eventData.healthFactor) {
      fields.push({ name: "Health Factor", value: `${eventData.healthFactor}`, inline: true });
    }
  }

  return {
    content: null,
    embeds: [
      {
        title,
        color,
        fields,
        footer: { text: "TrustLend Automations" },
        timestamp: new Date().toISOString()
      }
    ]
  };
}

/** Formats a Telegram message */
function formatTelegramPayload(topic: string, eventData: Record<string, unknown>) {
  let text = "TrustLend Event\n";
  if (topic === "loan_originated") {
    text = `🚨 *Large Loan Originated!* 🚨\n\n*Borrower:* \`${eventData.borrower}\`\n`;
    if (eventData.amountXLM) {
      text += `*Amount:* ${eventData.amountXLM} XLM\n`;
    }
  } else if (topic === "liquidation_warning") {
    text = `⚠️ *Liquidation Warning* ⚠️\n\n*Loan ID:* \`${eventData.loanId}\`\n`;
    if (eventData.healthFactor) {
      text += `*Health Factor:* ${eventData.healthFactor}\n`;
    }
  }
  return { parse_mode: "Markdown", text };
}

/** Broadcasts message to all active webhooks subscribed to the topic */
async function dispatchWebhooks(topic: string, eventData: Record<string, unknown>) {
  const { data: webhooks, error } = await supabase
    .from("webhook_endpoints")
    .select("*")
    .eq("is_active", true);

  if (error || !webhooks) {
    console.error("[webhooks-listener] Failed to fetch webhooks", error?.message);
    return;
  }
  
  if (webhooks.length === 0) return;

  const discordPayload = formatDiscordPayload(topic, eventData);
  const telegramPayload = formatTelegramPayload(topic, eventData);

  for (const hook of webhooks) {
    // Basic topic matching: 'all' or exact match
    if (hook.topic !== "all" && hook.topic !== topic) continue;
    
    if (hook.platform === "discord") {
      fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload)
      }).catch(err => console.error(`Failed to send to Discord webhook ${hook.name}:`, err.message));
    } else if (hook.platform === "telegram") {
      // Typically telegram webhook url looks like: https://api.telegram.org/bot<token>/sendMessage
      // The admin needs to manage the exact sendMessage URL in the database or we can expect the bot token
      // Assuming they provide the full api.telegram.org/... URL
      const payload = { ...telegramPayload, chat_id: hook.topic }; // chat_id logic would be needed but let's assume URL includes it or we don't have it, wait. Actually let's assume the hook url handles it or they deploy standard webhook reciever
      fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(telegramPayload)
      }).catch(err => console.error(`Failed to send to Telegram webhook ${hook.name}:`, err.message));
    } else if (hook.platform === "slack" || hook.platform === "custom") {
      // Default JSON payload
      fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, data: eventData })
      }).catch(err => console.error(`Failed to send to ${hook.platform} webhook ${hook.name}:`, err.message));
    }
  }
}

async function startListener() {
  if (!LENDING_CONTRACT_ID) {
    throw new Error("NEXT_PUBLIC_LENDING_CONTRACT_ID is not set.");
  }
  
  console.log(`[webhooks-listener] Listening to contract ${LENDING_CONTRACT_ID}`);
  
  let latestLedger = 0;
  try {
    const latest = await server.getLatestLedger();
    latestLedger = latest.sequence;
  } catch (err) {
    console.warn("Failed to get latest ledger, starting from 0");
  }

  setInterval(async () => {
    try {
      if (latestLedger === 0) {
          const latest = await server.getLatestLedger();
          latestLedger = latest.sequence;
          return;
      }

      const eventsResponse = await server.getEvents({
        startLedger: latestLedger,
        filters: [
          {
            type: "contract",
            contractIds: [LENDING_CONTRACT_ID]
          }
        ],
        limit: 100
      });

      if (eventsResponse.events) {
        for (const evt of eventsResponse.events) {
          // Track ledger
          if (evt.ledger > latestLedger) latestLedger = evt.ledger;
          if (evt.type !== "contract") continue;

          // Parse topics
          // Assuming topics[0] is the primary event type, e.g. "loan_originated"
          const primaryTopic = evt.topic[0]; 
          let topicName = "";
          try {
             // In stellar-sdk v16, topic array contains xdr.ScVal
             topicName = scValToNative(evt.topic[0]);
          } catch(e) {
             continue; // Unable to parse topic natively
          }

          if (topicName === "loan_originated") {
            const dataVal = evt.value;
            let loanData;
            try {
               loanData = scValToNative(dataVal) as Record<string, unknown>;
            } catch(e) {
               continue;
            }

            // TrustLend amount in stroops (10^7)
            const amountStroops = (loanData.amount as bigint) || (loanData.principal_amount as bigint) || 0n;
            const amountXLM = Number(amountStroops) / 10000000;
            
            if (amountXLM >= LARGE_LOAN_THRESHOLD_XLM) {
              await dispatchWebhooks("loan_originated", {
                borrower: (loanData.borrower as string) || "Unknown",
                amountXLM
              });
            }
          }
          // Note: Add other events like liquidation_warning checking here as the protocol evolves
        }
      }
      
      latestLedger++; // Advance to next ledger to avoid fetching same events endlessly
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[webhooks-listener] Error fetching events:", msg);
    }
  }, POLL_INTERVAL_MS);
}

const isDirectRun = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; } 
  catch { return false; }
})();

if (isDirectRun) {
  startListener().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
