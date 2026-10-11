export interface EndpointModel {
  id: string;
  label: string;
}

function dedupeAndSortModels(models: EndpointModel[]): EndpointModel[] {
  const seen = new Set<string>();
  const deduped: EndpointModel[] = [];
  for (const m of models) {
    const id = m.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: m.label.trim() || id });
  }
  return deduped.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

export async function fetchModelsFromEndpoint(input: {
  endpoint: string;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<EndpointModel[]> {
  const raw = input.endpoint.trim();
  if (!raw) {
    throw new Error("Endpoint URL is required.");
  }

  const base = raw.replace(/\/+$/, "");
  const urlsToTry: string[] = [];

  if (base.endsWith("/models") || base.endsWith("/tags")) {
    urlsToTry.push(base);
  } else {
    urlsToTry.push(`${base}/models`);
    if (!base.endsWith("/v1")) {
      urlsToTry.push(`${base}/v1/models`);
    }
    urlsToTry.push(`${base}/api/tags`);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = input.apiKey?.trim();
  if (token && token !== "none") {
    headers.Authorization = `Bearer ${token}`;
  }

  let lastError: Error | null = null;

  for (const url of urlsToTry) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: input.signal ?? AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed (${response.status}): check your API key.`);
        }
        if (response.status === 404 && urlsToTry.indexOf(url) < urlsToTry.length - 1) {
          continue;
        }
        const text = await response.text().catch(() => "");
        throw new Error(`Endpoint returned HTTP ${response.status}: ${text.slice(0, 150)}`);
      }

      const json = await response.json();
      const extracted: EndpointModel[] = [];

      if (json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).data)) {
        for (const item of (json as { data: Array<Record<string, unknown>> }).data) {
          const id = typeof item?.id === "string" ? item.id.trim() : "";
          if (id) {
            const label = typeof item?.name === "string" && item.name.trim() ? item.name.trim() : id;
            extracted.push({ id, label });
          }
        }
      } else if (json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).models)) {
        for (const item of (json as { models: Array<Record<string, unknown>> }).models) {
          const id = typeof item?.name === "string" ? item.name.trim() : typeof item?.model === "string" ? item.model.trim() : typeof item?.id === "string" ? item.id.trim() : "";
          if (id) {
            extracted.push({ id, label: id });
          }
        }
      } else if (Array.isArray(json)) {
        for (const item of json) {
          const id = typeof item === "string" ? item.trim() : typeof (item as Record<string, unknown>)?.id === "string" ? ((item as Record<string, unknown>).id as string).trim() : "";
          if (id) {
            const label = typeof (item as Record<string, unknown>)?.name === "string" ? ((item as Record<string, unknown>).name as string).trim() : id;
            extracted.push({ id, label });
          }
        }
      }

      if (extracted.length === 0) {
        if (urlsToTry.indexOf(url) < urlsToTry.length - 1) continue;
        throw new Error("No models returned by endpoint.");
      }

      return dedupeAndSortModels(extracted);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes("Authentication failed")) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Could not connect to model endpoint.");
}
