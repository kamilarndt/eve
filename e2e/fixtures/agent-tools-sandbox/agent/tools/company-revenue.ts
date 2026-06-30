import { defineTool } from "eve/tools";
import { z } from "zod";

import { delay, parallelBenchmarkLookupDelayMs } from "../../support/parallel-benchmark-delay.js";

const COMPANY_ROWS = [
  {
    bearCase: "iPhone replacement cycles and China exposure can pressure growth.",
    bullCase: "Services margin and installed-base monetization can keep cash flow resilient.",
    company: "Apple",
    fiscalYear: 2025,
    revenueUsdMillions: 391035,
    source: "https://investor.apple.com/",
    ticker: "AAPL",
  },
  {
    bearCase: "Cloud capex and AI competition can weigh on margins.",
    bullCase: "Azure and enterprise software bundling can sustain durable growth.",
    company: "Microsoft",
    fiscalYear: 2025,
    revenueUsdMillions: 245122,
    source: "https://www.microsoft.com/en-us/investor",
    ticker: "MSFT",
  },
  {
    bearCase: "Search share pressure and regulatory remedies can cap upside.",
    bullCase: "Search, YouTube, and Cloud give Alphabet multiple growth engines.",
    company: "Alphabet",
    fiscalYear: 2025,
    revenueUsdMillions: 350018,
    source: "https://abc.xyz/investor/",
    ticker: "GOOGL",
  },
  {
    bearCase: "Retail margin volatility and fulfillment costs can offset AWS gains.",
    bullCase: "AWS, ads, and logistics scale can compound operating income.",
    company: "Amazon",
    fiscalYear: 2025,
    revenueUsdMillions: 604334,
    source: "https://ir.aboutamazon.com/",
    ticker: "AMZN",
  },
  {
    bearCase: "AI accelerator demand can normalize after hyperscaler buildouts.",
    bullCase: "Data-center demand and software attach can extend the AI cycle.",
    company: "Nvidia",
    fiscalYear: 2025,
    revenueUsdMillions: 130497,
    source: "https://investor.nvidia.com/",
    ticker: "NVDA",
  },
  {
    bearCase: "Ad-market cyclicality and metaverse spend can pressure earnings.",
    bullCase: "AI ranking can lift engagement and ad pricing across core apps.",
    company: "Meta",
    fiscalYear: 2025,
    revenueUsdMillions: 164501,
    source: "https://investor.fb.com/",
    ticker: "META",
  },
  {
    bearCase: "Insurance losses and rail volume weakness can drag results.",
    bullCase: "Diversified operating earnings and cash optionality reduce downside.",
    company: "Berkshire Hathaway",
    fiscalYear: 2025,
    revenueUsdMillions: 371433,
    source: "https://www.berkshirehathaway.com/reports.html",
    ticker: "BRK.B",
  },
  {
    bearCase: "EV pricing pressure and execution risk can compress margins.",
    bullCase: "Energy storage and autonomy optionality can offset auto cyclicality.",
    company: "Tesla",
    fiscalYear: 2025,
    revenueUsdMillions: 97690,
    source: "https://ir.tesla.com/",
    ticker: "TSLA",
  },
  {
    bearCase: "Wage inflation and grocery competition can limit margin expansion.",
    bullCase: "Scale, ads, and marketplace growth can improve profit mix.",
    company: "Walmart",
    fiscalYear: 2025,
    revenueUsdMillions: 648125,
    source: "https://stock.walmart.com/",
    ticker: "WMT",
  },
  {
    bearCase: "Credit normalization and deposit-cost pressure can reduce returns.",
    bullCase: "Scale, fee income, and balance-sheet strength support through cycles.",
    company: "JPMorgan Chase",
    fiscalYear: 2025,
    revenueUsdMillions: 158104,
    source: "https://www.jpmorganchase.com/ir",
    ticker: "JPM",
  },
  {
    bearCase: "Commodity prices and energy-transition policy can pressure cash flow.",
    bullCase: "Integrated scale and project discipline can sustain shareholder returns.",
    company: "Exxon Mobil",
    fiscalYear: 2025,
    revenueUsdMillions: 344582,
    source: "https://investor.exxonmobil.com/",
    ticker: "XOM",
  },
  {
    bearCase: "Medicare Advantage rates and utilization can pressure margins.",
    bullCase: "Optum integration and scale can support earnings durability.",
    company: "UnitedHealth Group",
    fiscalYear: 2025,
    revenueUsdMillions: 371622,
    source: "https://www.unitedhealthgroup.com/investors.html",
    ticker: "UNH",
  },
] as const;

const LOOKUP = new Map(
  COMPANY_ROWS.flatMap((row) => [
    [row.company.toLowerCase(), row],
    [row.ticker.toLowerCase(), row],
  ]),
);

export default defineTool({
  description:
    "Look up one public company's fiscal-year revenue, source link, and concise bull/bear investment case. Use this when the user asks for revenue screens, company fundamentals, or investment-case tables.",
  inputSchema: z.object({
    company: z.string().describe("Company name or ticker to look up."),
  }),
  async execute({ company }) {
    const executionStartedAt = Date.now();
    await delay(parallelBenchmarkLookupDelayMs());

    const row = LOOKUP.get(company.trim().toLowerCase());
    if (row === undefined) {
      throw new Error(`No revenue fixture available for company "${company}".`);
    }

    return { ...row, executionCompletedAt: Date.now(), executionStartedAt };
  },
});
