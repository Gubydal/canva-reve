/* eslint-disable no-console */
import crypto from "crypto";
import express from "express";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ReveApiResponse = {
  image: string;
  version: string;
  content_violation: boolean;
  request_id: string;
  credits_used: number;
  credits_remaining: number;
};

type BillingStatus = "free" | "active";

type UsageRecord = {
  userId: string;
  generatedCount: number;
  billingStatus: BillingStatus;
  lemonCustomerId?: string;
  lemonSubscriptionId?: string;
  updatedAt: string;
};

type UsageStore = {
  users: Record<string, UsageRecord>;
};

type DbUsageRow = {
  user_id: string;
  generated_count: number;
  billing_status: BillingStatus;
  lemon_customer_id: string | null;
  lemon_subscription_id: string | null;
  updated_at: string;
};

type LemonCheckoutResponse = {
  data?: {
    attributes?: {
      url?: string;
    };
  };
};

type LemonCheckoutResult =
  | {
      ok: true;
      checkoutUrl: string;
    }
  | {
      ok: false;
      message: string;
      status?: number;
    };

type LongCatChatResponse = {
  choices?: {
    message?: {
      content?: string;
    };
  }[];
};

type PostProcess =
  | {
      process: "remove_background";
    }
  | {
      process: "upscale";
      upscale_factor: 2 | 3 | 4;
    };

const app = express();
const port = Number(process.env.CANVA_BACKEND_PORT || 3001);
const FREE_IMAGE_LIMIT = 1;
const DATA_DIR = path.join(process.cwd(), "backend", "data");
const USAGE_FILE_PATH = path.join(DATA_DIR, "usage.json");

app.post(
  "/api/billing/lemon/webhook",
  express.raw({ type: "application/json" }),
);

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const getReveKey = (): string => {
  const apiKey = process.env.REVE_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("Missing REVE_API_KEY in .env");
  }
  return apiKey;
};

const getLongcatKey = (): string | null => {
  const apiKey = process.env.LONGCAT_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    return null;
  }
  return apiKey;
};

const getLemonApiKey = (): string | null => {
  const apiKey = process.env.LEMON_SQUEEZY_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    return null;
  }
  return apiKey;
};

const getLemonStoreId = (): string | null => {
  const storeId = process.env.LEMON_SQUEEZY_STORE_ID;
  if (!storeId || storeId.trim() === "") {
    return null;
  }
  return storeId;
};

const getLemonVariantId = (): string | null => {
  const variantId = process.env.LEMON_SQUEEZY_VARIANT_ID;
  if (!variantId || variantId.trim() === "") {
    return null;
  }
  return variantId;
};

const getLemonWebhookSecret = (): string | null => {
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!secret || secret.trim() === "") {
    return null;
  }
  return secret;
};

const getSupabaseUrl = (): string | null => {
  const url = process.env.SUPABASE_URL;
  if (!url || url.trim() === "") {
    return null;
  }
  return url;
};

const getSupabaseServiceRoleKey = (): string | null => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.trim() === "") {
    return null;
  }
  return key;
};

const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const supabaseUrl = getSupabaseUrl();
const supabaseServiceRoleKey = getSupabaseServiceRoleKey();

const supabase: SupabaseClient | null = (() => {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }

  if (!isValidHttpUrl(supabaseUrl)) {
    console.warn(
      "SUPABASE_URL is invalid. Falling back to local usage storage.",
    );
    return null;
  }

  try {
    return createClient(supabaseUrl, supabaseServiceRoleKey);
  } catch (error) {
    console.warn(
      "Failed to initialize Supabase client. Falling back to local usage storage.",
      error,
    );
    return null;
  }
})();

const normalizeBase64 = (base64OrDataUrl: string): string => {
  const value = base64OrDataUrl.trim();
  const commaIndex = value.indexOf(",");
  if (value.startsWith("data:") && commaIndex >= 0) {
    return value.substring(commaIndex + 1);
  }
  return value;
};

const sanitizeUpscaleFactor = (value: unknown): 2 | 3 | 4 => {
  const numeric = Number(value);
  if (numeric === 3 || numeric === 4) {
    return numeric;
  }
  return 2;
};

const clampPrompt = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.slice(0, 2560);
};

function getClientUserId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const maybeUserId = (payload as { clientUserId?: unknown }).clientUserId;
  if (typeof maybeUserId !== "string") {
    return null;
  }

  const userId = maybeUserId.trim();
  return userId ? userId : null;
}

function ensureUsageStore(): UsageStore {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(USAGE_FILE_PATH)) {
    const initial: UsageStore = { users: {} };
    fs.writeFileSync(USAGE_FILE_PATH, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  try {
    const raw = fs.readFileSync(USAGE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as UsageStore;
    if (!parsed.users || typeof parsed.users !== "object") {
      return { users: {} };
    }
    return parsed;
  } catch {
    return { users: {} };
  }
}

function saveUsageStore(store: UsageStore) {
  fs.writeFileSync(USAGE_FILE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function getOrCreateLocalUsageRecord(userId: string): UsageRecord {
  const store = ensureUsageStore();
  const existing = store.users[userId];
  if (existing) {
    return existing;
  }

  const created: UsageRecord = {
    userId,
    generatedCount: 0,
    billingStatus: "free",
    updatedAt: new Date().toISOString(),
  };

  store.users[userId] = created;
  saveUsageStore(store);
  return created;
}

function updateLocalUsageRecord(
  userId: string,
  updater: (record: UsageRecord) => UsageRecord,
) {
  const store = ensureUsageStore();
  const current =
    store.users[userId] ||
    ({
      userId,
      generatedCount: 0,
      billingStatus: "free",
      updatedAt: new Date().toISOString(),
    } as UsageRecord);

  const next = updater(current);
  next.updatedAt = new Date().toISOString();
  store.users[userId] = next;
  saveUsageStore(store);
  return next;
}

function mapDbUsageRowToUsageRecord(row: DbUsageRow): UsageRecord {
  return {
    userId: row.user_id,
    generatedCount: row.generated_count,
    billingStatus: row.billing_status,
    lemonCustomerId: row.lemon_customer_id ?? undefined,
    lemonSubscriptionId: row.lemon_subscription_id ?? undefined,
    updatedAt: row.updated_at,
  };
}

function buildUsageView(record: UsageRecord) {
  const remainingFree = Math.max(0, FREE_IMAGE_LIMIT - record.generatedCount);
  const hasActiveSubscription = record.billingStatus === "active";
  const canGenerate = hasActiveSubscription || remainingFree > 0;

  return {
    userId: record.userId,
    generatedCount: record.generatedCount,
    freeLimit: FREE_IMAGE_LIMIT,
    remainingFree,
    billingStatus: record.billingStatus,
    hasActiveSubscription,
    canGenerate,
  };
}

async function getOrCreateSupabaseUsageRecord(userId: string) {
  if (!supabase) {
    return null;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("app_usage")
    .select(
      "user_id, generated_count, billing_status, lemon_customer_id, lemon_subscription_id, updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle<DbUsageRow>();

  if (fetchError) {
    throw fetchError;
  }

  if (existing) {
    return mapDbUsageRowToUsageRecord(existing);
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await supabase
    .from("app_usage")
    .insert({
      user_id: userId,
      generated_count: 0,
      billing_status: "free",
      updated_at: now,
    })
    .select(
      "user_id, generated_count, billing_status, lemon_customer_id, lemon_subscription_id, updated_at",
    )
    .single<DbUsageRow>();

  if (insertError) {
    throw insertError;
  }

  return mapDbUsageRowToUsageRecord(inserted);
}

async function getUsageRecord(userId: string): Promise<UsageRecord> {
  if (!supabase) {
    return getOrCreateLocalUsageRecord(userId);
  }

  try {
    const remote = await getOrCreateSupabaseUsageRecord(userId);
    if (remote) {
      return remote;
    }
  } catch (error) {
    console.error(
      "Supabase usage read failed, falling back to local store",
      error,
    );
  }

  return getOrCreateLocalUsageRecord(userId);
}

async function updateUsageRecord(
  userId: string,
  updater: (record: UsageRecord) => UsageRecord,
): Promise<UsageRecord> {
  if (!supabase) {
    return updateLocalUsageRecord(userId, updater);
  }

  try {
    const current = await getUsageRecord(userId);
    const next = updater(current);
    next.updatedAt = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("app_usage")
      .upsert(
        {
          user_id: userId,
          generated_count: next.generatedCount,
          billing_status: next.billingStatus,
          lemon_customer_id: next.lemonCustomerId ?? null,
          lemon_subscription_id: next.lemonSubscriptionId ?? null,
          updated_at: next.updatedAt,
        },
        { onConflict: "user_id" },
      )
      .select(
        "user_id, generated_count, billing_status, lemon_customer_id, lemon_subscription_id, updated_at",
      )
      .single<DbUsageRow>();

    if (updateError) {
      throw updateError;
    }

    return mapDbUsageRowToUsageRecord(updated);
  } catch (error) {
    console.error(
      "Supabase usage write failed, falling back to local store",
      error,
    );
    return updateLocalUsageRecord(userId, updater);
  }
}

async function getUsageView(userId: string) {
  const record = await getUsageRecord(userId);
  return buildUsageView(record);
}

async function markGenerationUsage(userId: string) {
  return updateUsageRecord(userId, (record) => ({
    ...record,
    generatedCount: record.generatedCount + 1,
  }));
}

async function setBillingStatus(userId: string, billingStatus: BillingStatus) {
  return updateUsageRecord(userId, (record) => ({
    ...record,
    billingStatus,
  }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function readNestedString(
  obj: Record<string, unknown>,
  pathParts: string[],
): string | null {
  let current: unknown = obj;
  for (const part of pathParts) {
    if (!isObject(current) || !(part in current)) {
      return null;
    }
    current = current[part];
  }

  return typeof current === "string" ? current : null;
}

function extractLemonUserId(payload: Record<string, unknown>): string | null {
  const fromMetaCustom = readNestedString(payload, [
    "meta",
    "custom_data",
    "user_id",
  ]);
  if (fromMetaCustom) {
    return fromMetaCustom;
  }

  const fromDataCustom = readNestedString(payload, [
    "data",
    "attributes",
    "custom_data",
    "user_id",
  ]);
  if (fromDataCustom) {
    return fromDataCustom;
  }

  const direct = readNestedString(payload, ["data", "attributes", "user_id"]);
  return direct;
}

function verifyLemonSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
) {
  const secret = getLemonWebhookSecret();
  if (!secret) {
    return true;
  }

  if (!signatureHeader) {
    return false;
  }

  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(computed);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

async function createLemonCheckoutUrl(args: {
  userId: string;
  email?: string;
}): Promise<LemonCheckoutResult> {
  const apiKey = getLemonApiKey();
  const storeId = getLemonStoreId();
  const variantId = getLemonVariantId();

  if (!apiKey || !storeId || !variantId) {
    return {
      ok: false,
      message:
        "Missing Lemon configuration. Set LEMON_SQUEEZY_API_KEY, LEMON_SQUEEZY_STORE_ID, and LEMON_SQUEEZY_VARIANT_ID.",
    };
  }

  const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
    },
    body: JSON.stringify({
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: args.email,
            custom: {
              user_id: args.userId,
            },
          },
          product_options: {
            redirect_url: "https://www.canva.com",
          },
        },
        relationships: {
          store: {
            data: {
              type: "stores",
              id: storeId,
            },
          },
          variant: {
            data: {
              type: "variants",
              id: variantId,
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Lemon checkout API error", response.status, errorText);
    return {
      ok: false,
      status: response.status,
      message:
        "Lemon checkout creation failed. Verify API key permissions and that store/variant IDs are correct.",
    };
  }

  const json = (await response.json()) as LemonCheckoutResponse;
  const url = json.data?.attributes?.url;
  if (typeof url !== "string" || !url) {
    return {
      ok: false,
      message:
        "Lemon checkout URL was empty. Check your product variant configuration.",
    };
  }

  return {
    ok: true,
    checkoutUrl: url,
  };
}

async function optimizePromptWithLongcat(args: {
  prompt: string;
  workflow: "create" | "enhance";
  operation?: "upscale" | "remove_background";
}) {
  const longcatKey = getLongcatKey();
  const originalPrompt = clampPrompt(args.prompt);

  if (!longcatKey || !originalPrompt) {
    return {
      prompt: originalPrompt,
      optimized: false,
      source: "original",
    } as const;
  }

  const systemPrompt =
    "You are a senior prompt engineer for high-end image generation. Rewrite user prompts to be clearer, visually specific, and concise while preserving user intent. Return only one optimized prompt with no markdown and no explanations.";

  const userPrompt = `Workflow: ${args.workflow}\nPostprocess: ${
    args.operation ?? "none"
  }\nUser prompt: ${originalPrompt}\n\nRules:\n- Keep under 200 words\n- Keep intent unchanged\n- Add useful composition/lighting/detail wording\n- Avoid policy-sensitive content\n- Output only the optimized prompt.`;

  try {
    const response = await fetch(
      "https://api.longcat.chat/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${longcatKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "LongCat-Flash-Chat",
          temperature: 0.3,
          max_tokens: 350,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      },
    );

    if (!response.ok) {
      return {
        prompt: originalPrompt,
        optimized: false,
        source: "original",
      } as const;
    }

    const json = (await response.json()) as LongCatChatResponse;
    const optimized = clampPrompt(
      json.choices?.[0]?.message?.content || originalPrompt,
    );

    return {
      prompt: optimized || originalPrompt,
      optimized: Boolean(optimized && optimized !== originalPrompt),
      source: "longcat",
    } as const;
  } catch {
    return {
      prompt: originalPrompt,
      optimized: false,
      source: "original",
    } as const;
  }
}

async function callReve(
  endpoint: "create" | "edit",
  body: Record<string, unknown>,
) {
  const response = await fetch(`https://api.reve.com/v1/image/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getReveKey()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as
    | ReveApiResponse
    | { error_code?: string; message?: string };

  if (!response.ok) {
    const message =
      "message" in json && json.message ? json.message : "Reve API call failed";
    const code =
      "error_code" in json && json.error_code ? ` (${json.error_code})` : "";
    throw new Error(`${message}${code}`);
  }

  return json as ReveApiResponse;
}

function toClientResponse(data: ReveApiResponse) {
  return {
    imageDataUrl: `data:image/png;base64,${data.image}`,
    version: data.version,
    requestId: data.request_id,
    creditsUsed: data.credits_used,
    creditsRemaining: data.credits_remaining,
    contentViolation: data.content_violation,
  };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/billing/status", async (req, res) => {
  try {
    const userIdParam = req.query.userId;
    const userId = typeof userIdParam === "string" ? userIdParam.trim() : "";
    if (!userId) {
      res.status(400).json({ message: "userId is required." });
      return;
    }

    const usage = await getUsageView(userId);
    res.status(200).json(usage);
  } catch (error) {
    res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Unable to load billing usage.",
    });
  }
});

app.post("/api/billing/create-checkout", async (req, res) => {
  try {
    const userId = getClientUserId(req.body);
    if (!userId) {
      res.status(400).json({ message: "clientUserId is required." });
      return;
    }

    const email =
      typeof req.body.email === "string" && req.body.email.trim()
        ? req.body.email.trim()
        : undefined;

    const checkoutResult = await createLemonCheckoutUrl({ userId, email });
    if (!checkoutResult.ok) {
      res.status(503).json({
        message: checkoutResult.message,
        code: "billing_not_ready",
        lemonStatus: checkoutResult.status,
      });
      return;
    }

    res.status(200).json({ checkoutUrl: checkoutResult.checkoutUrl });
  } catch (error) {
    res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Unable to create checkout session.",
    });
  }
});

app.post("/api/billing/lemon/webhook", async (req, res) => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ message: "Invalid webhook body." });
    return;
  }

  const signature = req.header("X-Signature") || undefined;
  if (!verifyLemonSignature(rawBody, signature)) {
    res.status(401).json({ message: "Invalid webhook signature." });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ message: "Webhook payload is not valid JSON." });
    return;
  }

  if (!isObject(payload)) {
    res.status(400).json({ message: "Webhook payload format is invalid." });
    return;
  }

  const eventName = readNestedString(payload, ["meta", "event_name"]);
  const userId = extractLemonUserId(payload);

  if (!eventName || !userId) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const activationEvents = new Set([
    "order_created",
    "subscription_created",
    "subscription_resumed",
    "subscription_unpaused",
    "subscription_payment_success",
  ]);
  const deactivationEvents = new Set([
    "subscription_cancelled",
    "subscription_expired",
    "subscription_paused",
    "subscription_payment_failed",
  ]);

  if (activationEvents.has(eventName)) {
    await setBillingStatus(userId, "active");
  }

  if (deactivationEvents.has(eventName)) {
    await setBillingStatus(userId, "free");
  }

  res.status(200).json({ ok: true });
});

app.post("/api/reve/create-remove-bg", async (req, res) => {
  try {
    const userId = getClientUserId(req.body);
    if (!userId) {
      res.status(400).json({ message: "clientUserId is required." });
      return;
    }

    const usage = await getUsageView(userId);
    if (!usage.canGenerate) {
      const checkoutResult = await createLemonCheckoutUrl({ userId });
      res.status(402).json({
        message: `Free plan limit reached (${FREE_IMAGE_LIMIT} image). Upgrade to continue generating.`,
        code: "upgrade_required",
        checkoutUrl: checkoutResult.ok ? checkoutResult.checkoutUrl : undefined,
        billingMessage: checkoutResult.ok ? undefined : checkoutResult.message,
        usage,
      });
      return;
    }

    const prompt =
      typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) {
      res.status(400).json({ message: "Prompt is required." });
      return;
    }

    const postprocessing: PostProcess[] = [{ process: "remove_background" }];

    const promptResult = await optimizePromptWithLongcat({
      prompt,
      workflow: "create",
      operation: "remove_background",
    });

    const data = await callReve("create", {
      prompt: promptResult.prompt,
      version: "latest",
      postprocessing,
      test_time_scaling: 1,
    });

    await markGenerationUsage(userId);
    const usageAfter = await getUsageView(userId);

    res.status(200).json({
      ...toClientResponse(data),
      originalPrompt: prompt,
      optimizedPrompt: promptResult.prompt,
      promptOptimized: promptResult.optimized,
      promptOptimizationSource: promptResult.source,
      usage: usageAfter,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Unexpected error while creating image.",
    });
  }
});

app.post("/api/reve/enhance", async (req, res) => {
  try {
    const userId = getClientUserId(req.body);
    if (!userId) {
      res.status(400).json({ message: "clientUserId is required." });
      return;
    }

    const usage = await getUsageView(userId);
    if (!usage.canGenerate) {
      const checkoutResult = await createLemonCheckoutUrl({ userId });
      res.status(402).json({
        message: `Free plan limit reached (${FREE_IMAGE_LIMIT} image). Upgrade to continue generating.`,
        code: "upgrade_required",
        checkoutUrl: checkoutResult.ok ? checkoutResult.checkoutUrl : undefined,
        billingMessage: checkoutResult.ok ? undefined : checkoutResult.message,
        usage,
      });
      return;
    }

    const referenceImageRaw =
      typeof req.body.referenceImageBase64 === "string"
        ? req.body.referenceImageBase64
        : "";

    if (!referenceImageRaw.trim()) {
      res.status(400).json({ message: "referenceImageBase64 is required." });
      return;
    }

    const operation =
      req.body.operation === "remove_background"
        ? "remove_background"
        : "upscale";

    const upscaleFactor = sanitizeUpscaleFactor(req.body.upscaleFactor);
    const postprocessing: PostProcess[] =
      operation === "remove_background"
        ? [{ process: "remove_background" }]
        : [{ process: "upscale", upscale_factor: upscaleFactor }];

    const prompt =
      typeof req.body.prompt === "string" && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : "Enhance this image quality while preserving natural details.";

    const promptResult = await optimizePromptWithLongcat({
      prompt,
      workflow: "enhance",
      operation,
    });

    const data = await callReve("edit", {
      edit_instruction: promptResult.prompt,
      reference_image: normalizeBase64(referenceImageRaw),
      version: "latest",
      postprocessing,
      test_time_scaling: 1,
    });

    await markGenerationUsage(userId);
    const usageAfter = await getUsageView(userId);

    res.status(200).json({
      ...toClientResponse(data),
      originalPrompt: prompt,
      optimizedPrompt: promptResult.prompt,
      promptOptimized: promptResult.optimized,
      promptOptimizationSource: promptResult.source,
      usage: usageAfter,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Unexpected error while enhancing image.",
    });
  }
});

const shouldEnableHttps = process.env.SHOULD_ENABLE_HTTPS === "true";

if (shouldEnableHttps) {
  const certFile = process.env.HTTPS_CERT_FILE;
  const keyFile = process.env.HTTPS_KEY_FILE;

  if (
    certFile &&
    keyFile &&
    fs.existsSync(certFile) &&
    fs.existsSync(keyFile)
  ) {
    const server = https.createServer(
      {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
      },
      app,
    );

    server.listen(port, () => {
      console.log(`Backend listening on https://localhost:${port}`);
    });
  } else {
    console.warn(
      "HTTPS requested, but cert or key is missing. Falling back to HTTP.",
    );
    http.createServer(app).listen(port, () => {
      console.log(`Backend listening on http://localhost:${port}`);
    });
  }
} else {
  http.createServer(app).listen(port, () => {
    console.log(`Backend listening on http://localhost:${port}`);
  });
}
