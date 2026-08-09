import { describe, it, expect } from "vitest";
import { isRetryableHttpStatus } from "./llm";

describe("isRetryableHttpStatus", () => {
  it("429（限流）/529（过载）/5xx（服务端错误）视为可重试", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(529)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it("其它 4xx（请求本身有问题）视为致命错误，不重试", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
    expect(isRetryableHttpStatus(422)).toBe(false);
  });

  it("无 status（连接错误/超时，SDK 未拿到 HTTP 响应）视为可重试", () => {
    expect(isRetryableHttpStatus(undefined)).toBe(true);
  });
});
