import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { describe, expect, it, vi } from "vitest";

import { oidc, vercelOidcAuth } from "#client/auth.js";

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(),
}));

describe("client auth helpers", () => {
  it("wraps an OIDC token as client auth", () => {
    const token = () => "oidc-token";

    expect(oidc(token)).toEqual({ oidc: token });
  });

  it("builds Vercel OIDC auth through the generic OIDC shape", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("vercel-token");

    const auth = vercelOidcAuth({ project: "prj_example" });
    expect(getVercelOidcToken).not.toHaveBeenCalled();

    const token = auth.oidc;
    expect(typeof token === "function" ? await token() : token).toBe("vercel-token");
    expect(getVercelOidcToken).toHaveBeenCalledWith({ project: "prj_example" });
  });
});
