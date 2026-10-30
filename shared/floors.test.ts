// normaliseFloorUrl: the one normaliser the elevator dialog and POST
// /api/floors share. A floor is an origin only, so whatever a member types
// becomes scheme + host + port, or null when it is not an http(s) address.
// The server opens nothing but this origin, and the UI hands it to
// location.assign, so a non-http scheme must never get through.

import { describe, expect, it } from "bun:test";
import { MAX_FLOOR_URL_CHARS, normaliseFloorUrl } from "./floors.ts";

describe("normaliseFloorUrl", () => {
  it("keeps only the origin of an http(s) address", () => {
    for (const [input, origin] of [
      ["https://office.example.com", "https://office.example.com"],
      [
        "https://office.example.com/rooms/a?x=1#top",
        "https://office.example.com",
      ],
      ["  https://office.example.com/  ", "https://office.example.com"],
      ["HTTPS://Office.Example.COM:443/x", "https://office.example.com"],
      ["http://office.example.com:8080/a", "http://office.example.com:8080"],
      ["http://127.0.0.1:4000", "http://127.0.0.1:4000"],
    ])
      expect(normaliseFloorUrl(input)).toBe(origin);
  });

  // A bare host:port also parses as a URL whose scheme is the host
  // ("auntie-2:4000" -> scheme "auntie-2:"), so "parses as a URL" is not the
  // test for "has a scheme".
  it("adds https:// to a bare host, also one with a port", () => {
    for (const [input, origin] of [
      ["office.example.com", "https://office.example.com"],
      ["office.example.com/lobby", "https://office.example.com"],
      ["auntie-2:4000", "https://auntie-2:4000"],
      ["office.example.com:8443/x", "https://office.example.com:8443"],
      ["127.0.0.1:4000", "https://127.0.0.1:4000"],
    ])
      expect(normaliseFloorUrl(input)).toBe(origin);
  });

  it("refuses another scheme, userinfo, and what does not parse", () => {
    for (const input of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://files.example.com",
      "file:///etc/passwd",
      "ws://office.example.com",
      "http://user:pw@office.example.com",
      "http://user@office.example.com",
      "member@office.example.com",
      "",
      "   ",
      "http://",
      "https://exa mple.com",
    ])
      expect(normaliseFloorUrl(input)).toBeNull();
  });

  it("refuses an input over the length cap, and accepts one at it", () => {
    const head = "https://office.example.com/";
    const at = head + "a".repeat(MAX_FLOOR_URL_CHARS - head.length);
    expect(at.length).toBe(MAX_FLOOR_URL_CHARS);
    expect(normaliseFloorUrl(at)).toBe("https://office.example.com");
    expect(normaliseFloorUrl(at + "a")).toBeNull();
  });
});
