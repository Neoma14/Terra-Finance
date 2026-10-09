export type CounterpartyType = "vendor" | "customer";

export interface Counterparty {
  id: string;
  type: CounterpartyType;
  code: string;
  name: string;
  isActive: boolean;
}

export interface CounterpartyBalance {
  counterpartyId: string;
  code: string;
  name: string;
  isActive: boolean;
  balance: number;
}

export interface CreateCounterpartyInput {
  type: CounterpartyType;
  code: string;
  name: string;
}
