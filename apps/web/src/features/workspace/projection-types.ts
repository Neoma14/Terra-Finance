export interface ProjectionPoint {
  label: string;
  revenue: number;
  expense: number;
  netProfit: number;
  isProjected: boolean;
}

export interface ProjectionResult {
  method: string;
  sufficientData: boolean;
  historical: ProjectionPoint[];
  projected: ProjectionPoint[];
}
