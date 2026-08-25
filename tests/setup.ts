import "@testing-library/jest-dom/vitest";

// This setup file runs for every test file, including plain *.test.ts files
// that execute in the default Node environment (no window/document at all) —
// only the *.component.test.tsx files run under jsdom. Guard accordingly.

// jsdom does not implement matchMedia at all; the shadcn Sidebar's mobile
// detection hook calls it unconditionally on mount. Default to "not mobile"
// (jsdom's default window.innerWidth of 1024 is already a desktop width),
// matching how every component test exercises the app.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom does not implement ResizeObserver; Radix's Popper-based positioning
// (used by Tooltip/Sheet content) measures elements with it on mount.
if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// Radix Select uses pointer-capture APIs that jsdom does not implement. These
// no-op shims model the browser surface closely enough for keyboard/pointer
// interaction tests without changing application behaviour.
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}
