import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import Privacy from "../src/app/privacy/page";
import Terms from "../src/app/terms/page";

it.each([["privacy", Privacy, "Google Cloud"], ["terms", Terms, "as is"]] as const)(
  "renders the public %s page without a session", (_name, Page, text) => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("Last updated 2026-10-22");
    expect(html).toContain("suyash@voxdonna.com");
    expect(html).toContain(text);
  });
