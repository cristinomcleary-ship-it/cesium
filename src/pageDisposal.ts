/** beforeunload can be cancelled. Dispose only when the page really leaves,
 * and retain live owners while the browser keeps this page in its back cache. */
export function disposeOnPageLeave(dispose: () => void, signal?: AbortSignal, target: EventTarget = window): void {
  const leave = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) return;
    target.removeEventListener('pagehide', leave);
    dispose();
  };
  target.addEventListener('pagehide', leave, { signal });
}
