/* eslint-disable formatjs/no-literal-string-in-jsx */
import { useFeatureSupport } from "@canva/app-hooks";
import { Button, Rows, Text } from "@canva/app-ui-kit";
import { addElementAtCursor, addElementAtPoint } from "@canva/design";
import { requestOpenExternalUrl } from "@canva/platform";
import { useEffect, useMemo, useState } from "react";
import * as styles from "styles/components.css";

type EnhanceOperation = "upscale" | "remove_background";

type ReveResponse = {
  imageDataUrl: string;
  version: string;
  requestId: string;
  creditsUsed: number;
  creditsRemaining: number;
  contentViolation: boolean;
  originalPrompt?: string;
  optimizedPrompt?: string;
  promptOptimized?: boolean;
  promptOptimizationSource?: string;
  usage?: UsageView;
};

type UsageView = {
  userId: string;
  generatedCount: number;
  freeLimit: number;
  remainingFree: number;
  billingStatus: "free" | "active";
  hasActiveSubscription: boolean;
  canGenerate: boolean;
};

type BillingCheckoutResponse = {
  checkoutUrl: string;
};

type ApiErrorShape = {
  message: string;
  code?: string;
  checkoutUrl?: string;
  usage?: UsageView;
};

class ApiError extends Error {
  code?: string;
  checkoutUrl?: string;
  usage?: UsageView;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = "ApiError";
    this.code = shape.code;
    this.checkoutUrl = shape.checkoutUrl;
    this.usage = shape.usage;
  }
}

const DEFAULT_ENHANCE_PROMPT =
  "Enhance this image quality while preserving natural details.";

async function postJson<T>(path: string, payload: Record<string, unknown>) {
  const response = await fetch(`${BACKEND_HOST}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as T | ApiErrorShape;

  if (!response.ok) {
    const fallbackMessage = `Request failed with ${response.status}`;
    const message =
      typeof (body as ApiErrorShape).message === "string"
        ? (body as ApiErrorShape).message
        : fallbackMessage;

    throw new ApiError({
      message,
      code: (body as ApiErrorShape).code,
      checkoutUrl: (body as ApiErrorShape).checkoutUrl,
      usage: (body as ApiErrorShape).usage,
    });
  }

  return body as T;
}

async function getJson<T>(path: string) {
  const response = await fetch(`${BACKEND_HOST}${path}`);
  const body = (await response.json()) as T | ApiErrorShape;

  if (!response.ok) {
    throw new ApiError({
      message:
        typeof (body as ApiErrorShape).message === "string"
          ? (body as ApiErrorShape).message
          : `Request failed with ${response.status}`,
      code: (body as ApiErrorShape).code,
      checkoutUrl: (body as ApiErrorShape).checkoutUrl,
      usage: (body as ApiErrorShape).usage,
    });
  }

  return body as T;
}

function getOrCreateClientUserId() {
  const key = "canva_reve_client_user_id";
  const existing = window.localStorage.getItem(key);
  if (existing && existing.trim()) {
    return existing;
  }

  const generated =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  window.localStorage.setItem(key, generated);
  return generated;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") {
        reject(new Error("Could not read the selected image."));
        return;
      }

      const base64 = value.includes(",")
        ? value.substring(value.indexOf(",") + 1)
        : value;
      resolve(base64);
    };
    reader.onerror = () =>
      reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

export const App = () => {
  const isSupported = useFeatureSupport();
  const addElement = [addElementAtPoint, addElementAtCursor].find((fn) =>
    isSupported(fn),
  );
  const canAddToDesign = Boolean(addElement);

  const [prompt, setPrompt] = useState("");
  const [enhancePrompt, setEnhancePrompt] = useState(DEFAULT_ENHANCE_PROMPT);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [enhanceOperation, setEnhanceOperation] =
    useState<EnhanceOperation>("upscale");
  const [upscaleFactor, setUpscaleFactor] = useState<number>(2);

  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReveResponse | null>(null);
  const [resultLabel, setResultLabel] = useState("Generated image");
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const clientUserId = useMemo(() => getOrCreateClientUserId(), []);

  const fileName = useMemo(
    () => selectedFile?.name ?? "No image selected",
    [selectedFile],
  );

  const clearError = () => setError(null);

  useEffect(() => {
    let isMounted = true;

    const loadUsage = async () => {
      try {
        const currentUsage = await getJson<UsageView>(
          `/api/billing/status?userId=${encodeURIComponent(clientUserId)}`,
        );
        if (isMounted) {
          setUsage(currentUsage);
        }
      } catch {
        // keep UI usable if billing endpoint is temporarily unavailable
      }
    };

    loadUsage();

    return () => {
      isMounted = false;
    };
  }, [clientUserId]);

  const createWithPrompt = async () => {
    if (!prompt.trim()) {
      setError("Please enter a prompt.");
      return;
    }

    setLoading(true);
    clearError();
    try {
      const data = await postJson<ReveResponse>("/api/reve/create-remove-bg", {
        prompt: prompt.trim(),
        clientUserId,
      });
      setResult(data);
      setUsage(data.usage ?? null);
      setCheckoutUrl(null);
      setResultLabel("Prompt result (background removed)");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setCheckoutUrl(err.checkoutUrl || null);
        if (err.usage) {
          setUsage(err.usage);
        }
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to generate image.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const enhanceUploadedImage = async () => {
    if (!selectedFile) {
      setError("Please upload an image first.");
      return;
    }

    setLoading(true);
    clearError();
    try {
      const referenceImageBase64 = await fileToBase64(selectedFile);
      const data = await postJson<ReveResponse>("/api/reve/enhance", {
        referenceImageBase64,
        operation: enhanceOperation,
        prompt: enhancePrompt.trim() || DEFAULT_ENHANCE_PROMPT,
        upscaleFactor,
        clientUserId,
      });

      setResult(data);
      setUsage(data.usage ?? null);
      setCheckoutUrl(null);
      setResultLabel(
        enhanceOperation === "upscale"
          ? `Enhanced image (upscale x${upscaleFactor})`
          : "Enhanced image (background removed)",
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setCheckoutUrl(err.checkoutUrl || null);
        if (err.usage) {
          setUsage(err.usage);
        }
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to enhance image.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const openCheckout = async () => {
    setCheckoutLoading(true);
    try {
      let url = checkoutUrl;
      if (!url) {
        const response = await postJson<BillingCheckoutResponse>(
          "/api/billing/create-checkout",
          {
            clientUserId,
          },
        );
        url = response.checkoutUrl;
      }

      if (!url) {
        throw new Error("No checkout URL available.");
      }

      await requestOpenExternalUrl({ url });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open checkout.");
    } finally {
      setCheckoutLoading(false);
    }
  };

  const addResultToDesign = async () => {
    if (!addElement || !result?.imageDataUrl) {
      return;
    }

    await addElement({
      type: "image",
      dataUrl: result.imageDataUrl,
      altText: {
        decorative: false,
        text: "Image generated with Reve",
      },
    });
  };

  return (
    <div className={styles.scrollContainer}>
      <Rows spacing="2u">
        <div className={styles.hero}>
          <Text variant="bold">Creator Super Tool</Text>
          <Text>
            AI image generation with automatic prompt optimization, cleaner
            backgrounds, and quick Canva insertion.
          </Text>
          {usage ? (
            <Text>
              Plan: {usage.billingStatus.toUpperCase()} | Free remaining:{" "}
              {usage.remainingFree}/{usage.freeLimit}
            </Text>
          ) : null}
        </div>

        <div className={styles.card}>
          <div className={styles.sectionHeader}>
            <Text variant="bold">Create (Auto Remove BG)</Text>
            <span className={styles.pill}>Prompt to image</span>
          </div>
          <Text>
            Type your idea and the app automatically optimizes it before sending
            to Reve.
          </Text>
          <textarea
            className={styles.textArea}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              clearError();
            }}
            placeholder="Example: A futuristic sneaker product shot on a studio floor"
          />
          <div className={styles.actionWrap}>
            <Button
              variant="primary"
              onClick={createWithPrompt}
              loading={loading}
              stretch
            >
              Create image
            </Button>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.sectionHeader}>
            <Text variant="bold">BG / Enhance ✨</Text>
            <span className={styles.pill}>Upload workflow</span>
          </div>
          <Text>
            Upload an image and choose between smart upscaling or background
            removal.
          </Text>
          <label className={styles.label}>Upload image</label>
          <div className={styles.filePickerRow}>
            <input
              id="enhance-image-input"
              className={styles.fileInputHidden}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/tiff,image/avif"
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null);
                clearError();
              }}
            />
            <label
              htmlFor="enhance-image-input"
              className={styles.chooseButton}
            >
              Choose image
            </label>
            <span className={styles.fileNameBadge}>{fileName}</span>
          </div>

          <label className={styles.label}>
            Enhance prompt
            <textarea
              className={styles.textArea}
              value={enhancePrompt}
              onChange={(event) => setEnhancePrompt(event.target.value)}
            />
          </label>

          <label className={styles.label}>
            Mode
            <div className={styles.choiceRow}>
              <button
                type="button"
                className={`${styles.choiceButton} ${
                  enhanceOperation === "upscale"
                    ? styles.choiceButtonActive
                    : ""
                }`}
                onClick={() => setEnhanceOperation("upscale")}
              >
                Enhance + Upscale
              </button>
              <button
                type="button"
                className={`${styles.choiceButton} ${
                  enhanceOperation === "remove_background"
                    ? styles.choiceButtonActive
                    : ""
                }`}
                onClick={() => setEnhanceOperation("remove_background")}
              >
                Remove Background
              </button>
            </div>
          </label>

          {enhanceOperation === "upscale" ? (
            <label className={styles.label}>
              Upscale factor
              <div className={styles.choiceRow}>
                {[2, 3, 4].map((factor) => (
                  <button
                    key={factor}
                    type="button"
                    className={`${styles.choiceButton} ${
                      upscaleFactor === factor ? styles.choiceButtonActive : ""
                    }`}
                    onClick={() => setUpscaleFactor(factor)}
                  >
                    {factor}x
                  </button>
                ))}
              </div>
            </label>
          ) : null}

          <div className={styles.actionWrap}>
            <Button
              variant="primary"
              onClick={enhanceUploadedImage}
              loading={loading}
              stretch
            >
              Run BG / Enhance
            </Button>
          </div>
        </div>

        {error ? <Text tone="critical">{error}</Text> : null}

        {usage && !usage.canGenerate ? (
          <div className={styles.card}>
            <div className={styles.sectionHeader}>
              <Text variant="bold">Upgrade required</Text>
              <span className={styles.pill}>Billing</span>
            </div>
            <Text>
              You reached the free limit of {usage.freeLimit} generated image
              {usage.freeLimit > 1 ? "s" : ""}. Upgrade to continue.
            </Text>
            <div className={styles.actionWrap}>
              <Button
                variant="primary"
                onClick={openCheckout}
                loading={checkoutLoading}
                stretch
              >
                Upgrade with Lemon Squeezy
              </Button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className={styles.card}>
            <div className={styles.sectionHeader}>
              <Text variant="bold">{resultLabel}</Text>
              <span className={styles.pill}>Result</span>
            </div>

            <img
              src={result.imageDataUrl}
              className={styles.previewImage}
              alt={resultLabel}
            />
            <div className={styles.actionWrap}>
              <Button
                variant="secondary"
                onClick={addResultToDesign}
                disabled={!canAddToDesign}
                stretch
              >
                Add to design
              </Button>
            </div>
          </div>
        ) : null}
      </Rows>
    </div>
  );
};
