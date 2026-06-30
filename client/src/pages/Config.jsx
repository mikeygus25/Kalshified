import { useState, useEffect } from "react";
import { getConfig, saveConfig } from "../lib/api";

function Section({ title, children }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm text-gray-300">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <div className="sm:w-52 shrink-0">{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, min, max }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      min={min}
      max={max}
      className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 transition-colors"
    />
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? "bg-indigo-600" : "bg-gray-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function Radio({ options, value, onChange }) {
  return (
    <div className="flex gap-3">
      {options.map((opt) => (
        <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="accent-indigo-500"
          />
          <span className="text-sm text-gray-300">{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

export default function Config() {
  const [cfg, setCfg]       = useState(null);
  const [dirty, setDirty]   = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  useEffect(() => {
    getConfig().then(setCfg).catch(console.error);
  }, []);

  function update(key, val) {
    setCfg((prev) => ({ ...prev, [key]: val }));
    setDirty((prev) => ({ ...prev, [key]: val }));
    setSaved(false);
  }

  // Interval helpers: stored in ms, shown in seconds
  function intervalSec(key) {
    return Math.round((parseInt(cfg?.[key] ?? "0") || 0) / 1000);
  }
  function setIntervalSec(key, sec) {
    update(key, String(parseInt(sec || 0) * 1000));
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await saveConfig(dirty);
      setSaved(true);
      setDirty({});
    } catch (err) {
      alert("Save failed: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Loading config…</p>
      </div>
    );
  }

  const hasBrave     = !!cfg.BRAVE_SEARCH_API_KEY;
  const hasTelegram  = !!(cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID);
  const hasRobinhood = !!cfg.ROBINHOOD_ACCESS_TOKEN;

  return (
    <div className="p-4 lg:p-8 space-y-6 max-w-2xl mx-auto">
      <h2 className="text-xl font-bold text-white">Configuration</h2>

      <form onSubmit={handleSave} className="space-y-4">
        {/* Risk Limits */}
        <Section title="Risk Limits">
          <Field label="Max Daily Loss" hint="Pipeline stops buying after this loss ($)">
            <NumberInput
              value={cfg.MAX_DAILY_LOSS ?? "500"}
              onChange={(v) => update("MAX_DAILY_LOSS", v)}
              min={0}
            />
          </Field>
          <Field label="Max Position Size" hint="Maximum contracts per trade">
            <NumberInput
              value={cfg.MAX_POSITION_SIZE ?? "100"}
              onChange={(v) => update("MAX_POSITION_SIZE", v)}
              min={1}
            />
          </Field>
          <Field label="Max Open Positions" hint="Maximum simultaneous holdings">
            <NumberInput
              value={cfg.MAX_OPEN_POSITIONS ?? "10"}
              onChange={(v) => update("MAX_OPEN_POSITIONS", v)}
              min={1}
              max={50}
            />
          </Field>
        </Section>

        {/* Intervals */}
        <Section title="Intervals">
          <Field label="Pipeline interval (s)" hint="How often Scout→Edge→Vault runs">
            <NumberInput
              value={intervalSec("SCOUT_INTERVAL")}
              onChange={(v) => setIntervalSec("SCOUT_INTERVAL", v)}
              min={10}
            />
          </Field>
          <Field label="Vault check interval (s)" hint="Fast sell re-evaluation between pipelines">
            <NumberInput
              value={intervalSec("VAULT_INTERVAL")}
              onChange={(v) => setIntervalSec("VAULT_INTERVAL", v)}
              min={5}
            />
          </Field>
          <Field label="Robinhood interval (s)" hint="Stock trading cadence (market hours only)">
            <NumberInput
              value={intervalSec("ROBINHOOD_INTERVAL")}
              onChange={(v) => setIntervalSec("ROBINHOOD_INTERVAL", v)}
              min={60}
            />
          </Field>
          <p className="text-xs text-gray-600 pt-1">
            ⚠ Interval changes take effect on next restart.
          </p>
        </Section>

        {/* Trading Mode */}
        <Section title="Trading Mode">
          <Field label="Environment" hint="demo = paper trading, prod = real money">
            <Radio
              options={[
                { value: "demo", label: "Demo" },
                { value: "prod", label: "Production" },
              ]}
              value={cfg.KALSHI_ENV ?? "demo"}
              onChange={(v) => update("KALSHI_ENV", v)}
            />
          </Field>
        </Section>

        {/* Feature Toggles */}
        <Section title="Features">
          <Field
            label="Brave Search (news)"
            hint={hasBrave ? "API key configured" : "Set BRAVE_SEARCH_API_KEY to enable"}
          >
            <Toggle
              checked={hasBrave}
              onChange={(on) => update("BRAVE_SEARCH_API_KEY", on ? cfg.BRAVE_SEARCH_API_KEY || "" : "")}
            />
          </Field>
          <Field
            label="Telegram alerts"
            hint={hasTelegram ? "Bot configured" : "Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable"}
          >
            <Toggle
              checked={hasTelegram}
              onChange={(on) => {
                if (!on) {
                  update("TELEGRAM_BOT_TOKEN", "");
                  update("TELEGRAM_CHAT_ID", "");
                }
              }}
            />
          </Field>
          <Field
            label="Robinhood trading"
            hint={hasRobinhood ? "OAuth token set" : "Set ROBINHOOD_ACCESS_TOKEN to enable"}
          >
            <Toggle
              checked={hasRobinhood}
              onChange={(on) => update("ROBINHOOD_ACCESS_TOKEN", on ? cfg.ROBINHOOD_ACCESS_TOKEN || "" : "")}
            />
          </Field>
        </Section>

        {/* Save */}
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving || Object.keys(dirty).length === 0}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors text-sm"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
          {saved && <p className="text-emerald-400 text-sm">✓ Saved — applied immediately</p>}
        </div>

        <p className="text-xs text-gray-600">
          Changes are applied to the running process immediately and written to config.json.
          For Railway deployments, also update environment variables in the Railway dashboard to persist across restarts.
        </p>
      </form>
    </div>
  );
}
