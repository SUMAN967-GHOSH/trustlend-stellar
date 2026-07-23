"use client";

import { useState, useCallback, useRef } from "react";
import type { TransactionAction } from "@/components/ui/ConfirmTransactionModal";

export interface UseTransactionSimulationReturn {
  /** The current pending action, or null if idle */
  pendingAction: TransactionAction | null;
  /** Whether the modal is visible */
  isModalOpen: boolean;
  /** Whether the transaction is being confirmed/submitted */
  isConfirming: boolean;
  /** Open the confirmation modal with simulation preview for an action */
  preview: (action: TransactionAction) => void;
  /** Close the modal without executing */
  dismiss: () => void;
  /**
   * Confirm the action — the modal's "Confirm & Sign" button calls this.
   * Provide `executor` which performs the actual contract call (after user signs).
   */
  confirm: (executor: () => Promise<void>) => Promise<void>;
}

/**
 * Hook that manages the transaction simulation preview and confirmation flow.
 *
 * Usage:
 * ```tsx
 * const tx = useTransactionSimulation();
 *
 * // Before calling the contract:
 * tx.preview({
 *   label: "Create Loan Request",
 *   contractId: NEXT_PUBLIC_LENDING_CONTRACT_ID,
 *   method: "create_loan_request",
 *   args: [walletAddress, xlmToStroops(amount), duration, rate, maxLoan],
 *   callerAddress: walletAddress,
 *   details: { Amount: `${amount} XLM`, Duration: `${duration} days` },
 * });
 *
 * // In the same component, render the modal:
 * <ConfirmTransactionModal
 *   open={tx.isModalOpen}
 *   onClose={tx.dismiss}
 *   onConfirm={() => tx.confirm(async () => {
 *     await LendingContract.createLoanRequest(...);
 *   })}
 *   action={tx.pendingAction}
 *   confirming={tx.isConfirming}
 * />
 * ```
 */
export function useTransactionSimulation(): UseTransactionSimulationReturn {
  const [pendingAction, setPendingAction] = useState<TransactionAction | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const executorRef = useRef<(() => Promise<void>) | null>(null);

  const preview = useCallback((action: TransactionAction) => {
    setPendingAction(action);
    executorRef.current = null;
  }, []);

  const dismiss = useCallback(() => {
    setPendingAction(null);
    setIsConfirming(false);
    executorRef.current = null;
  }, []);

  const confirm = useCallback(
    async (executor: () => Promise<void>): Promise<void> => {
      executorRef.current = executor;
      setIsConfirming(true);
      try {
        await executor();
        setPendingAction(null);
        setIsConfirming(false);
        executorRef.current = null;
      } catch (err) {
        setIsConfirming(false);
        executorRef.current = null;
        throw err;
      }
    },
    [],
  );

  return {
    pendingAction,
    isModalOpen: pendingAction !== null,
    isConfirming,
    preview,
    dismiss,
    confirm,
  };
}
