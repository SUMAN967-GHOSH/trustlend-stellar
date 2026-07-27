import { NextResponse } from "next/server";

export interface DistributionHistoryItem {
  id: number;
  timestamp: string;
  asset: string;
  insuranceAmount: number;
  daoAmount: number;
  status: "Completed" | "Pending";
  txHash: string;
}

export interface TreasuryMetrics {
  currentBalance: number;
  totalCollected: number;
  totalDistributedInsurance: number;
  totalDistributedDao: number;
  rules: {
    insuranceShareBps: number;
    daoShareBps: number;
  };
  asset: string;
  history: DistributionHistoryItem[];
}

// Mock/Initial Treasury State
let mockTreasuryState: TreasuryMetrics = {
  currentBalance: 12500.50,
  totalCollected: 45000.00,
  totalDistributedInsurance: 16249.75,
  totalDistributedDao: 16249.75,
  rules: {
    insuranceShareBps: 5000, // 50%
    daoShareBps: 5000,       // 50%
  },
  asset: "USDC",
  history: [
    {
      id: 1,
      timestamp: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
      asset: "USDC",
      insuranceAmount: 8124.875,
      daoAmount: 8124.875,
      status: "Completed",
      txHash: "0x7a8f9c...b12",
    },
    {
      id: 2,
      timestamp: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
      asset: "USDC",
      insuranceAmount: 8124.875,
      daoAmount: 8124.875,
      status: "Completed",
      txHash: "0x3e1d4a...f89",
    },
  ],
};

export async function GET() {
  return NextResponse.json(mockTreasuryState, { status: 200 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, amount } = body;

    if (action === "collect") {
      const collectAmount = amount || 2500;
      mockTreasuryState.currentBalance += collectAmount;
      mockTreasuryState.totalCollected += collectAmount;

      return NextResponse.json(
        {
          message: `Collected ${collectAmount} ${mockTreasuryState.asset} in protocol fees into Treasury.`,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    if (action === "distribute") {
      const balanceToDistribute = mockTreasuryState.currentBalance;
      if (balanceToDistribute <= 0) {
        return NextResponse.json(
          { error: "Treasury balance is zero. Nothing to distribute." },
          { status: 400 }
        );
      }

      const insurancePayout = (balanceToDistribute * mockTreasuryState.rules.insuranceShareBps) / 10000;
      const daoPayout = balanceToDistribute - insurancePayout;

      mockTreasuryState.totalDistributedInsurance += insurancePayout;
      mockTreasuryState.totalDistributedDao += daoPayout;
      mockTreasuryState.currentBalance = 0;

      const newHistoryItem: DistributionHistoryItem = {
        id: mockTreasuryState.history.length + 1,
        timestamp: new Date().toISOString(),
        asset: mockTreasuryState.asset,
        insuranceAmount: insurancePayout,
        daoAmount: daoPayout,
        status: "Completed",
        txHash: `0x${Math.random().toString(16).substring(2, 10)}...${Math.random().toString(16).substring(2, 5)}`,
      };

      mockTreasuryState.history.unshift(newHistoryItem);

      return NextResponse.json(
        {
          message: `Distributed ${balanceToDistribute} ${mockTreasuryState.asset} (50% Insurance / 50% DAO).`,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    return NextResponse.json({ error: "Invalid action specified" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
