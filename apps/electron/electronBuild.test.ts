import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("Electron Vite production build", () => {
  it("uses relative asset URLs because the renderer is loaded from file://", () => {
    expect(config.base).toBe("./");
  });
});
