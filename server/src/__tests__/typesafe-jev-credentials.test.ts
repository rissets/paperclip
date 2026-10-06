import { afterEach, expect, it, vi } from "vitest";
import { TypeSafeJevService } from "../services/typesafe-jev.js";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("keeps JEV decisions local when no explicit provider credential exists", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await new TypeSafeJevService().systemOne({}, {});
  expect(result.model).toBe("fallback-dynamic");
  expect(fetchMock).not.toHaveBeenCalled();
});
