import type { BenchmarkCompany } from "@konsultan/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useBenchmark(from: string | undefined, to: string | undefined, companyIds: string[]) {
  return useQuery({
    queryKey: ["benchmark", from, to, companyIds],
    queryFn: () =>
      api.get<{ companies: BenchmarkCompany[] }>(
        `/benchmark?from=${from}&to=${to}${companyIds.length ? `&companyIds=${companyIds.join(",")}` : ""}`,
      ),
    enabled: Boolean(from && to),
  });
}

export function useDownloadBenchmarkExcel() {
  return useMutation({
    mutationFn: ({ from, to, companyIds }: { from: string; to: string; companyIds: string[] }) =>
      api.download(
        `/benchmark/export?from=${from}&to=${to}${companyIds.length ? `&companyIds=${companyIds.join(",")}` : ""}`,
        "Benchmarking Antar Perusahaan.xlsx",
      ),
  });
}
