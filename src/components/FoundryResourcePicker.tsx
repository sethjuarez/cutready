import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { AppSettings } from "../hooks/useSettings";
import { inputClass } from "../styles";

interface Subscription {
  subscription_id: string;
  display_name: string;
  state: string;
}

interface AiResource {
  name: string;
  resource_group: string;
  kind: string;
  endpoint: string;
  location: string;
}

interface FoundryProject {
  name: string;
  endpoint: string;
}

interface Props {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => Promise<void>;
}

export function FoundryResourcePicker({ settings, updateSetting }: Props) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [resources, setResources] = useState<AiResource[]>([]);
  const [projects, setProjects] = useState<FoundryProject[]>([]);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");

  // Fetch management token from refresh token (different scope than inference)
  const fetchManagementToken = useCallback(async () => {
    if (!settings.aiRefreshToken) return null;
    try {
      const result = await invoke<{ access_token: string; refresh_token?: string }>(
        "azure_token_refresh",
        {
          tenantId: settings.aiTenantId || "",
          refreshToken: settings.aiRefreshToken,
          clientId: settings.aiClientId || null,
          scope: "https://management.azure.com/.default offline_access",
        },
      );
      if (result.access_token) {
        await updateSetting("aiManagementToken", result.access_token);
        return result.access_token;
      }
    } catch {
      // Management token fetch failed
    }
    return null;
  }, [settings.aiRefreshToken, settings.aiTenantId, settings.aiClientId, updateSetting]);

  const getManagementToken = useCallback(async () => {
    if (settings.aiManagementToken) return settings.aiManagementToken;
    return fetchManagementToken();
  }, [settings.aiManagementToken, fetchManagementToken]);

  // Load subscriptions on mount if we have a token
  useEffect(() => {
    if (settings.aiRefreshToken && subscriptions.length === 0) {
      loadSubscriptions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.aiRefreshToken]);

  const loadSubscriptions = async () => {
    setLoading("subscriptions");
    setError("");
    try {
      const token = await getManagementToken();
      if (!token) {
        setError("Could not obtain management token. Try signing in again.");
        return;
      }
      const subs = await invoke<Subscription[]>("list_azure_subscriptions", {
        managementToken: token,
      });
      setSubscriptions(subs);

      // Auto-select if only one, or re-select previously saved
      if (subs.length === 1) {
        await selectSubscription(subs[0]);
      } else if (settings.aiSubscriptionId) {
        const saved = subs.find((s) => s.subscription_id === settings.aiSubscriptionId);
        if (saved) loadResources(saved.subscription_id);
      }
    } catch (e) {
      setError(`Failed to list subscriptions: ${e}`);
    } finally {
      setLoading("");
    }
  };

  const loadResources = async (subscriptionId: string) => {
    setLoading("resources");
    setError("");
    setResources([]);
    setProjects([]);
    try {
      const token = await getManagementToken();
      if (!token) return;
      const res = await invoke<AiResource[]>("list_azure_ai_resources", {
        managementToken: token,
        subscriptionId,
      });
      setResources(res);

      // Auto-select if only one, or re-select previously saved
      if (res.length === 1) {
        await selectResource(res[0]);
      } else if (settings.aiResourceName) {
        const saved = res.find((r) => r.name === settings.aiResourceName);
        if (saved) loadProjects(saved);
      }
    } catch (e) {
      setError(`Failed to list AI resources: ${e}`);
    } finally {
      setLoading("");
    }
  };

  const loadProjects = async (resource: AiResource) => {
    setLoading("projects");
    setError("");
    setProjects([]);
    try {
      const token = await getManagementToken();
      if (!token) return;
      const proj = await invoke<FoundryProject[]>("list_foundry_projects", {
        managementToken: token,
        subscriptionId: settings.aiSubscriptionId,
        resourceGroup: resource.resource_group,
        resourceName: resource.name,
      });
      setProjects(proj);

      // Auto-select if only one
      if (proj.length === 1) {
        await selectProject(proj[0]);
      }
    } catch (e) {
      setError(`Failed to list projects: ${e}`);
    } finally {
      setLoading("");
    }
  };

  const selectSubscription = async (sub: Subscription) => {
    await updateSetting("aiSubscriptionId", sub.subscription_id);
    await updateSetting("aiResourceGroup", "");
    await updateSetting("aiResourceName", "");
    await updateSetting("aiEndpoint", "");
    await updateSetting("aiModel", "");
    loadResources(sub.subscription_id);
  };

  const selectResource = async (res: AiResource) => {
    await updateSetting("aiResourceGroup", res.resource_group);
    await updateSetting("aiResourceName", res.name);
    await updateSetting("aiEndpoint", res.endpoint);
    await updateSetting("aiModel", "");
    loadProjects(res);
  };

  const selectProject = async (proj: FoundryProject) => {
    await updateSetting("aiEndpoint", proj.endpoint);
    await updateSetting("aiModel", "");
  };

  const pickerItemClass =
    "w-full text-left px-3 py-2 text-sm hover:bg-[rgb(var(--color-accent))]/10 transition-colors flex items-center justify-between gap-2";
  const selectedItemClass = "text-[rgb(var(--color-accent))] font-medium";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Azure Resource</span>
        <button
          onClick={loadSubscriptions}
          disabled={!!loading}
          className="p-1 rounded hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
          title="Refresh subscriptions"
        >
          <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Subscription Picker */}
      {subscriptions.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <label className="text-xs text-[rgb(var(--color-text-secondary))]">
            Subscription
          </label>
          <select
            value={settings.aiSubscriptionId}
            onChange={(e) => {
              const sub = subscriptions.find((s) => s.subscription_id === e.target.value);
              if (sub) selectSubscription(sub);
            }}
            className={inputClass}
          >
            <option value="">Select a subscription…</option>
            {subscriptions.map((sub) => (
              <option key={sub.subscription_id} value={sub.subscription_id}>
                {sub.display_name}
              </option>
            ))}
          </select>
        </fieldset>
      )}

      {/* Resource Picker */}
      {resources.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <label className="text-xs text-[rgb(var(--color-text-secondary))]">
            AI Resource
          </label>
          <div className="max-h-36 overflow-y-auto rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]">
            {resources.map((res) => (
              <button
                key={`${res.resource_group}/${res.name}`}
                onClick={() => selectResource(res)}
                className={`${pickerItemClass} ${
                  settings.aiResourceName === res.name ? selectedItemClass : ""
                }`}
              >
                <span>{res.name}</span>
                <span className="text-xs text-[rgb(var(--color-text-secondary))]">
                  {res.kind} · {res.location}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* Project Picker (optional — not all resources have projects) */}
      {projects.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <label className="text-xs text-[rgb(var(--color-text-secondary))]">
            Foundry Project{" "}
            <span className="font-normal">(optional — use resource-level if none)</span>
          </label>
          <div className="max-h-36 overflow-y-auto rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]">
            {projects.map((proj) => (
              <button
                key={proj.name}
                onClick={() => selectProject(proj)}
                className={`${pickerItemClass} ${
                  settings.aiEndpoint === proj.endpoint ? selectedItemClass : ""
                }`}
              >
                {proj.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {loading && (
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          Loading {loading}…
        </p>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
