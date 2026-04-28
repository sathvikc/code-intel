// Production code: uses IntersectionObserver
export function observeElement(el: Element, cb: IntersectionObserverCallback) {
  const io = new window.IntersectionObserver(cb);
  io.observe(el);
  return io;
}
