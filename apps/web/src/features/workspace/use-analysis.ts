import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { RatioAnalysis } from "./analysis-types.js";

export function useRatioAnalysis(companySlug: string, fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ["workspace", "analysis", companySlug, fromDate, toDate],
    queryFn: () => companyApi.get<RatioAnalysis>(`/${companySlug}/analysis?fromDate=${fromDate}&toDate=${toDate}`),
    enabled: Boolean(companySlug && fromDate && toDate),
  });
}
