import { useEffect, useState } from 'react';

export function useTick(intervalMs) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      setTick((value) => value + 1);
    }, intervalMs);

    return () => clearInterval(intervalId);
  }, [intervalMs]);

  return tick;
}
