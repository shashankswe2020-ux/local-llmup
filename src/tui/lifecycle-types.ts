export type LifecycleScreen = "up" | "switch" | "down" | "migrate";

export interface LifecycleReviewViewModel {
  readonly screen: LifecycleScreen;
  readonly title: string;
  readonly canonicalTargetIds: readonly string[];
  readonly lines: readonly string[];
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

export type LifecycleReviewDecision =
  | { readonly type: "accepted" }
  | { readonly type: "cancelled" };

export interface LifecycleProgressItem {
  readonly type: "started" | "completed" | "failed";
  readonly phase: string;
  readonly label: string;
}
