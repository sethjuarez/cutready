type Callback = () => void;

let observer: IntersectionObserver | null = null;
const callbacks = new Map<Element, Callback>();

/** Calls `onVisible` once when `element` nears the viewport, sharing one observer across rows. */
export function observeOnce(element: Element, onVisible: Callback): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => {};
  }
  observer ??= new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const callback = callbacks.get(record.target);
      unobserve(record.target);
      callback?.();
    }
  }, { rootMargin: "200px" });
  callbacks.set(element, onVisible);
  observer.observe(element);
  return () => unobserve(element);
}

function unobserve(element: Element) {
  callbacks.delete(element);
  observer?.unobserve(element);
}
