"use strict";

if (typeof globalThis.matchMedia !== "function") {
  const matchMediaPolyfill = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });

  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMediaPolyfill,
  });

  if (typeof globalThis.window !== "undefined") {
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      writable: true,
      value: matchMediaPolyfill,
    });
  }
}

if (typeof globalThis.devicePixelRatio === "undefined") {
  Object.defineProperty(globalThis, "devicePixelRatio", {
    configurable: true,
    writable: true,
    value: 1,
  });
}
