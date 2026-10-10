import { useContext, useMemo } from "react";
import { useQuery, QueryClient, QueryClientContext } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

const fallbackQueryClient = new QueryClient();

export function useGeneralSettings() {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.generalSettings,
      queryFn: () => instanceSettingsApi.getGeneral(),
      enabled: Boolean(contextClient),
    },
    contextClient ?? fallbackQueryClient,
  );

  return useMemo(
    () => ({
      ...query,
      settings: query.data,
      showWorkingActivityAndReasoning:
        query.data?.showWorkingActivityAndReasoning ?? true,
    }),
    [query, query.data],
  );
}
