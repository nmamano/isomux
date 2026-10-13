import { useEffect, useRef } from "react";

// False once the component unmounts. A list is keyed by whose items it shows,
// so a picker switch unmounts it: an answer that arrives after that belongs to
// the member who is no longer on screen and must not be set.
export function useAlive(): { readonly current: boolean } {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}
