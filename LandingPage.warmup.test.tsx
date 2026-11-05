import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

vi.mock("gsap", () => ({ gsap: { matchMedia: () => ({ add() {}, revert() {} }) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("sends a health GET on suite entry and throttles immediate re-entry", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', {
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/api/v1");
  const home = <MemoryRouter><LandingPage /></MemoryRouter>;
  const first = render(home);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    "https://api.example.test/api/v1/health", expect.objectContaining({ method: "GET" })
  ));
  first.unmount();
  render(home);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledTimes(1);
});
