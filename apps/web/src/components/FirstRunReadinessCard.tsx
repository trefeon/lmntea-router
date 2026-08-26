import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Circle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchHealth } from "@/lib/api";

const STORAGE_KEY = "lmntea-onboarded";
const PROGRESS_KEY = "lmntea-onboarding-progress";

// ---------------------------------------------------------------------------
// persisted shape
// ---------------------------------------------------------------------------

interface OnboardingProgress {
  providerDone: boolean;
  healthDone: boolean;
  comboDone: boolean;
}

function loadProgress(): OnboardingProgress {
  if (typeof window === "undefined") {
    return { providerDone: false, healthDone: false, comboDone: false };
  }
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") {
        return {
          providerDone: Boolean((j as Record<string, unknown>).providerDone),
          healthDone: Boolean((j as Record<string, unknown>).healthDone),
          comboDone: Boolean((j as Record<string, unknown>).comboDone),
        };
      }
    }
  } catch {
    // ignore
  }
  return { providerDone: false, healthDone: false, comboDone: false };
}

function saveProgress(p: OnboardingProgress) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
}

function isOnboarded(): boolean {
  if (typeof window === "undefined") return false;
  const v = localStorage.getItem(STORAGE_KEY);
  if (!v) return false;
  if (v === "true") return true;
  try {
    const j = JSON.parse(v);
    if (j && typeof j === "object" && "dismissed" in j) {
      return Boolean((j as Record<string, unknown>).dismissed);
    }
    // if stored as JSON progress object with dismissed?
    return false;
  } catch {
    return v === "true";
  }
}

function setOnboarded(dismissed: boolean) {
  localStorage.setItem(STORAGE_KEY, dismissed ? "true" : "false");
  // also dispatch event for other tabs/components
  try {
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: dismissed ? "true" : "false" }));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FirstRunReadinessCard({
  onDismiss,
  compact,
}: {
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const [progress, setProgress] = useState<OnboardingProgress>(() => loadProgress());
  const [dismissed, setDismissed] = useState<boolean>(() => isOnboarded());
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthOk, setHealthOk] = useState<boolean>(progress.healthDone);

  const doneCount = useMemo(() => {
    let c = 0;
    if (progress.providerDone) c++;
    if (progress.healthDone || healthOk) c++;
    if (progress.comboDone) c++;
    return c;
  }, [progress.comboDone, progress.healthDone, progress.providerDone, healthOk]);

  const allDone = doneCount === 3;

  // sync from storage on mount + listen
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROGRESS_KEY || e.key === STORAGE_KEY) {
        setProgress(loadProgress());
        setDismissed(isOnboarded());
        if (e.key === PROGRESS_KEY) {
          const p = loadProgress();
          setHealthOk(p.healthDone);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    // also poll for same-tab mutations via custom event?
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    saveProgress(progress);
  }, [progress]);

  // If providerDone not yet, check if api key exists → auto-mark
  useEffect(() => {
    if (!progress.providerDone) {
      const key = localStorage.getItem("lmntea-api-key");
      if (key && key.startsWith("sk-")) {
        setProgress((p) => ({ ...p, providerDone: true }));
      }
    }
    if (!progress.comboDone) {
      const combo = localStorage.getItem("lmntea-combo-created");
      if (combo === "true") {
        setProgress((p) => ({ ...p, comboDone: true }));
      }
    }
  }, [progress.comboDone, progress.providerDone]);

  const handleTestHealth = async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const res = await fetchHealth();
      if (res.status === "ok") {
        setHealthOk(true);
        setProgress((p) => ({ ...p, healthDone: true }));
        setHealthError(null);
      } else {
        setHealthError(`Health check returned ${res.status}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Health check failed";
      setHealthError(msg);
    } finally {
      setHealthLoading(false);
    }
  };

  const handleDismiss = () => {
    setOnboarded(true);
    setDismissed(true);
    onDismiss?.();
  };

  if (dismissed) {
    if (compact) return null;
    return (
      <Card className="border-zinc-800 bg-zinc-900">
        <CardContent className="flex items-center justify-between py-3">
          <span className="flex items-center gap-2 text-sm text-zinc-400">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
              <Check className="h-3 w-3" />
            </span>
            Setup complete
            <span className="text-zinc-500">· onboarding dismissed</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOnboarded(false);
              setDismissed(false);
            }}
          >
            Show again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">First-run readiness</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-zinc-700 bg-zinc-950 text-zinc-400 font-mono text-xs">
            Setup {doneCount}/3
          </Badge>
          <Button variant="ghost" size="icon-sm" onClick={handleDismiss} aria-label="Dismiss onboarding">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {/* Step 1 */}
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
              progress.providerDone
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-500"
                : "border-zinc-700 text-zinc-500 bg-zinc-900"
            }`}
          >
            {progress.providerDone ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-medium">1. Add provider</span>
            <span className="text-xs text-zinc-500">
              {progress.providerDone ? "API key configured · Connected" : "Connect OpenCode or compatible provider"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {progress.providerDone ? (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">done</Badge>
            ) : (
              <Link
                to="/providers"
                className="inline-flex h-8 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-black hover:bg-zinc-200"
              >
                Add
              </Link>
            )}
          </div>
        </div>

        {/* Step 2 */}
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
              healthOk || progress.healthDone
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-500"
                : "border-zinc-700 text-zinc-500 bg-zinc-900"
            }`}
          >
            {healthOk || progress.healthDone ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          </span>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-sm font-medium">2. Test health</span>
            <span className="text-xs text-zinc-500 truncate">
              {healthOk || progress.healthDone ? "GET /health 200 · gateway reachable" : healthError ?? "Verify gateway is up on :8787"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {healthOk || progress.healthDone ? (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">done</Badge>
            ) : (
              <Button size="sm" variant="outline" onClick={handleTestHealth} disabled={healthLoading} className="border-zinc-700 bg-zinc-900 hover:bg-zinc-800">
                {healthLoading ? "Checking…" : "Test"}
              </Button>
            )}
          </div>
        </div>
        {healthError && !healthOk && (
          <p className="px-1 text-xs text-red-400">{healthError}</p>
        )}

        {/* Step 3 */}
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
              progress.comboDone
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-500"
                : "border-zinc-700 text-zinc-500 bg-zinc-900"
            }`}
          >
            {progress.comboDone ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-medium">3. Create combo</span>
            <span className="text-xs text-zinc-500">
              {progress.comboDone ? "Combo created · fallback ready" : "Aether fallback with 8 models"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {progress.comboDone ? (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">done</Badge>
            ) : (
              <>
                <Link
                  to="/combos"
                  className="inline-flex h-8 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-black hover:bg-zinc-200"
                >
                  Create
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden sm:inline-flex border-zinc-700 bg-zinc-900 hover:bg-zinc-800"
                  onClick={() => setProgress((p) => ({ ...p, comboDone: true }))}
                >
                  Mark done
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Dismiss / progress */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-zinc-500">
            {allDone ? "All steps done — dismiss to show dashboard stats." : `${3 - doneCount} step${3 - doneCount === 1 ? "" : "s"} remaining`}
          </span>
          <Button
            size="sm"
            variant={allDone ? "default" : "outline"}
            onClick={handleDismiss}
            className={allDone ? "bg-white text-black hover:bg-zinc-200" : "border-zinc-700 bg-zinc-900 hover:bg-zinc-800"}
          >
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers for other pages to mark steps
// ---------------------------------------------------------------------------

export function markProviderDone() {
  const p = loadProgress();
  p.providerDone = true;
  saveProgress(p);
  try { window.dispatchEvent(new StorageEvent("storage", { key: PROGRESS_KEY })); } catch {}
}

export function markComboDone() {
  const p = loadProgress();
  p.comboDone = true;
  saveProgress(p);
  localStorage.setItem("lmntea-combo-created", "true");
  try { window.dispatchEvent(new StorageEvent("storage", { key: PROGRESS_KEY })); } catch {}
}

export function resetOnboarding() {
  localStorage.removeItem(PROGRESS_KEY);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("lmntea-combo-created");
}
