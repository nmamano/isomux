import { buildPublicOrigin } from "./auth.ts";

export function setAppFramingPolicy(headers: Headers): void {
  // A comma separates enforced policies, including folded repeated headers.
  // Each policy must allow the office; a second policy cannot loosen the first.
  const ancestors = `frame-ancestors 'self' ${buildPublicOrigin().origin}`;
  const policies = (headers.get("Content-Security-Policy") ?? "")
    .split(",")
    .filter((policy) => policy.trim().length > 0);
  if (policies.length === 0) policies.push("");
  headers.set(
    "Content-Security-Policy",
    policies
      .map((policy) => {
        const kept = policy
          .split(";")
          .map((part) => part.trim())
          .filter(
            (part) =>
              part.length > 0 && !/^frame-ancestors(?:\s|$)/i.test(part),
          );
        return [...kept, ancestors].join("; ");
      })
      .join(", "),
  );
  headers.delete("X-Frame-Options");
}

export function withAppFraming(response: Response): Response {
  setAppFramingPolicy(response.headers);
  return response;
}
