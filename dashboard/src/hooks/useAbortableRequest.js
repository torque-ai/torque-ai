import { useCallback, useEffect, useRef } from 'react';

export function useAbortableRequest() {
  const isMountedRef = useRef(true);
  const requestCounterRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const execute = useCallback(async (asyncFn) => {
    const requestId = ++requestCounterRef.current;
    const isCurrent = () => isMountedRef.current && requestCounterRef.current === requestId;

    try {
      const result = await asyncFn(isCurrent);
      if (!isCurrent()) return undefined;
      return result;
    } catch (error) {
      if (!isCurrent()) return undefined;
      throw error;
    }
  }, []);

  return { execute };
}
