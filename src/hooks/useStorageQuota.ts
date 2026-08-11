"use client";

import { useEffect, useState } from "react";

/** Ratio of used/quota storage, or null if unavailable/unmeasured yet. */
export function useStorageQuota(): number | null {
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!navigator.storage?.estimate) return;
    navigator.storage.estimate().then((estimate) => {
      if (estimate.quota && estimate.usage !== undefined) {
        setRatio(estimate.usage / estimate.quota);
      }
    });
  }, []);

  return ratio;
}
