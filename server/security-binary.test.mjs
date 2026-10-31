import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: requestMock }));
import { guardedRequest } from "./security.mjs";

function respond(chunks, status = 200) {
  requestMock.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () =>
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = { "content-type": "image/png" };
        response.destroy = (error) => {
          if (error) response.emit("error", error);
        };
        callback(response);
        if (status >= 200 && status < 300) {
          for (const chunk of chunks) response.emit("data", chunk);
          response.emit("end");
        }
      });
    return request;
  });
}
const options = {
  allowedHosts: ["cover.lightaudio.ru"],
  resolver: async () => [{ address: "93.184.216.34", family: 4 }],
};

describe("binary guarded artwork requests", () => {
  it("preserves binary bytes while keeping text as the default", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80]);
    respond([bytes.subarray(0, 2), bytes.subarray(2)]);
    const image = await guardedRequest(
      "https://cover.lightaudio.ru/cover.jpg",
      { ...options, responseType: "buffer" },
    );
    expect(Buffer.isBuffer(image.body)).toBe(true);
    expect(image.body).toEqual(bytes);
    respond([Buffer.from("plain text")]);
    expect(
      (await guardedRequest("https://cover.lightaudio.ru/text", options)).body,
    ).toBe("plain text");
  });
  it("retains streaming size and redirect rejection", async () => {
    respond([Buffer.alloc(6)]);
    await expect(
      guardedRequest("https://cover.lightaudio.ru/cover.jpg", {
        ...options,
        responseType: "buffer",
        maxBytes: 5,
      }),
    ).rejects.toThrow(/too large/);
    respond([], 302);
    await expect(
      guardedRequest("https://cover.lightaudio.ru/cover.jpg", {
        ...options,
        responseType: "buffer",
      }),
    ).rejects.toThrow(/302/);
  });
});
