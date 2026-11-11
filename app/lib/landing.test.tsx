import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FleetPage from "../app/fleet/page";
import Home from "../app/page";
import QueuePage from "../app/queue/page";
import ReceiptsPage from "../app/receipts/page";
import RequestsPage from "../app/requests/page";
import SettingsPage from "../app/settings/page";
import RootLayout from "../app/layout";

const NAV_ROUTES = ["/fleet", "/requests", "/queue", "/receipts", "/settings"];

// Pages render inside the shared root layout (header + nav) exactly as
// the production server serves them over HTTP.
async function renderWithLayout(page: React.ReactElement): Promise<string> {
  return renderToStaticMarkup(<RootLayout>{page}</RootLayout>);
}

describe("landing page", () => {
  it("answers with the product sentence and a link to /requests", async () => {
    const html = await renderWithLayout(<Home />);
    expect(html).toContain(
      "Mission control for money-handling AI agents on NEAR.",
    );
    expect(html).toContain("/requests");
  });

  it("names the three checks in order", async () => {
    const html = renderToStaticMarkup(<Home />);
    const rules = html.indexOf("On-chain rules");
    const judge = html.indexOf("purpose judge");
    const human = html.indexOf("A human");
    expect(rules).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(rules);
    expect(human).toBeGreaterThan(judge);
  });
});

describe("shared navigation", () => {
  it.each([
    ["fleet", FleetPage],
    ["requests", RequestsPage],
    ["queue", QueuePage],
    ["receipts", ReceiptsPage],
    ["settings", SettingsPage],
  ])("%s contains nav links to all five routes", async (_name, Page) => {
    const html = await renderWithLayout(await (Page as () => Promise<React.ReactElement>)());
    for (const route of NAV_ROUTES) {
      expect(html).toContain(`href="${route}"`);
    }
  });
});
