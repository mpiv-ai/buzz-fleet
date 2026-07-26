import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.ts doesn't set `test.globals: true`, so RTL can't
// auto-register its cleanup via a global `afterEach` — do it explicitly, or
// component tests leak DOM across cases within the same file.
afterEach(() => {
  cleanup();
});
