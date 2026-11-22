import { describe, expect, it } from "vitest";
import { headingDeg, headingText, signed1 } from "../format";

describe("headingDeg", () => {
  it("never shows 360", () => {
    expect(headingDeg(359.6)).toBe(0);
    expect(headingDeg(-0.4)).toBe(0);
    expect(headingDeg(-0.6)).toBe(359);
    expect(headingDeg(720.2)).toBe(0);
    expect(headingDeg(90.4)).toBe(90);
  });
  it("writes three digits", () => {
    expect(headingText(359.6)).toBe("000");
    expect(headingText(7)).toBe("007");
    expect(headingText(-90)).toBe("270");
  });
});

describe("signed1", () => {
  it("never shows -0.0", () => {
    expect(signed1(-0.02)).toBe("+0.0");
    expect(signed1(-0)).toBe("+0.0");
    expect(signed1(0.04)).toBe("+0.0");
  });
  it("keeps the sign of real rates", () => {
    expect(signed1(2.46)).toBe("+2.5");
    expect(signed1(-1.26)).toBe("-1.3");
  });
});
