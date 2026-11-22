import { describe, expect, it } from "vitest";
import { byteRange } from "../../../desktop/range.cjs";

describe("byteRange", () => {
  it("gives the whole file without a Range header", () => {
    expect(byteRange(1000, undefined)).toEqual({ status: 200 });
    expect(byteRange(1000, "")).toEqual({ status: 200 });
  });
  it("reads the forms browsers send", () => {
    expect(byteRange(1000, "bytes=0-")).toEqual({ status: 206, start: 0, end: 999 });
    expect(byteRange(1000, "bytes=100-199")).toEqual({ status: 206, start: 100, end: 199 });
    expect(byteRange(1000, "bytes=900-5000")).toEqual({ status: 206, start: 900, end: 999 });
    expect(byteRange(1000, "bytes=-100")).toEqual({ status: 206, start: 900, end: 999 });
    expect(byteRange(1000, "bytes=-5000")).toEqual({ status: 206, start: 0, end: 999 });
  });
  it("refuses a range outside the file", () => {
    expect(byteRange(1000, "bytes=1000-")).toEqual({ status: 416 });
    expect(byteRange(1000, "bytes=500-100")).toEqual({ status: 416 });
    expect(byteRange(1000, "bytes=-0")).toEqual({ status: 416 });
  });
  it("sends the whole file for forms it does not handle", () => {
    expect(byteRange(1000, "bytes=0-9,20-29")).toEqual({ status: 200 });
    expect(byteRange(1000, "items=0-9")).toEqual({ status: 200 });
    expect(byteRange(1000, "bytes=-")).toEqual({ status: 200 });
  });
});
