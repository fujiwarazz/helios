import { describe, expect, it } from "vitest";
import { Container, Text } from "./index";

describe("@helios/tui", () => {
  it("renders framework components without Helios runtime imports", () => {
    const container = new Container();
    container.addChild(new Text("helios", 0, 0));

    expect(container.render(80).map((line) => line.trimEnd())).toEqual(["helios"]);
  });
});
