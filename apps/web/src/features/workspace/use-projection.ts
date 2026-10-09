import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { ProjectionResult } from "./projection-types.js";

export function useProjection(companySlug: string, asOfDate: string, monthsAhead: number) {
  return useQuery({
    queryKey: ["workspace", "projection", companySlug, asOfDate, monthsAhead],
    queryFn: () => companyApi.get<ProjectionResult>(`/${companySlug}/projection?asOfDate=${asOfDate}&monthsAhead=${monthsAhead}`),
    enabled: Boolean(companySlug && asOfDate),
  });
}
