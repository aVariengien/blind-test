import { useEffect, useState } from "react";
import { getProviders, pinProvider } from "../api";
import type { ModelProviders, ProviderEndpoint } from "../types";

const DEFAULT = "__default__";

function label(e: ProviderEndpoint, recommended: boolean): string {
  const bits = [e.tag];
  if (e.quantization && e.quantization !== "unknown") bits.push(e.quantization);
  if (e.uptime1d != null) bits.push(`${e.uptime1d.toFixed(1)}% up`);
  if (e.status < 0) bits.push("degraded");
  if (recommended) bits.push("recommended");
  return bits.join(" · ");
}

/**
 * The OpenRouter provider a model is pinned to. The pin is app-wide (rounds,
 * compare, rooms, speed test, playground) and strict: if that provider is down
 * the request fails rather than falling back to another host.
 */
export default function ProviderPicker({ modelId, onChanged }: { modelId: string; onChanged?: () => void }) {
  const [info, setInfo] = useState<ModelProviders | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setInfo(null);
    setError(null);
    if (!modelId) return;
    getProviders(modelId)
      .then((d) => !dead && setInfo(d))
      .catch((err) => !dead && setError(String(err instanceof Error ? err.message : err)));
    return () => {
      dead = true;
    };
  }, [modelId]);

  async function change(value: string) {
    setBusy(true);
    setError(null);
    try {
      setInfo(await pinProvider(modelId, value === DEFAULT ? null : value));
      onChanged?.();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  if (!modelId) return null;
  if (error) return <span className="provider-picker bad" title={error}>provider: error</span>;
  if (!info) return <span className="provider-picker"><span className="spinner" /></span>;
  if (!info.endpoints.length && !info.pin)
    return <span className="provider-picker muted" title={info.error}>no provider list — routed by OpenRouter</span>;

  const pin = info.pin;
  const value = !pin || pin.auto ? DEFAULT : pin.tag;
  const defaultName = pin?.auto ? pin.tag : info.recommended;
  // A hand-picked tag that has since disappeared still has to show as selected.
  const missing = pin && !pin.auto && !info.endpoints.some((e) => e.tag === pin.tag);

  return (
    <span className={`provider-picker ${info.pinAvailable === false ? "bad" : ""}`}>
      <select value={value} disabled={busy} onChange={(e) => change(e.target.value)} title="pinned provider (no fallback)">
        <option value={DEFAULT}>default{defaultName ? ` — ${defaultName}` : ""}</option>
        {missing ? <option value={pin.tag}>{pin.tag} · no longer serves this model</option> : null}
        {info.endpoints.map((e) => (
          <option key={e.tag} value={e.tag}>
            {label(e, e.tag === info.recommended)}
          </option>
        ))}
      </select>
      {busy ? <span className="spinner" /> : null}
      {info.pinAvailable === false ? <span className="nm">pinned provider is gone — requests will fail</span> : null}
    </span>
  );
}
