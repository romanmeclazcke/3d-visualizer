declare global {
  interface Window {
    process?: {
      env?: Record<string, string>;
    };
  }
}

const processShim = {
  env: {
    NEXT_PUBLIC_ASSETS_CDN_URL: "https://editor.pascal.app",
  },
};

const globalScope = globalThis as typeof globalThis & {
  process?: {
    env?: Record<string, string>;
  };
};

if (typeof globalScope.process === "undefined") {
  Object.defineProperty(globalThis, "process", {
    value: processShim,
    configurable: true,
    writable: true,
  });
} else if (!globalScope.process.env) {
  globalScope.process.env = processShim.env;
}

export {};
