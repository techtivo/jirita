import { beforeEach, describe, expect, it, vi } from "vitest";

// loadLoggedMinutesByTicket backs Delivery's "Remaining": all time ever
// logged per open ticket. It has no date bound, so it must page through
// every row rather than stop at the API's max-rows limit.
const ranges: [number, number][] = [];
let filters: Record<string, unknown[]> = {};
let table: { ticket_id: string; minutes: number }[] = [];

function builder() {
  let range: [number, number] = [0, 999];
  const chain = {
    select() { return chain; },
    in(column: string, values: unknown[]) { filters[column] = values; return chain; },
    order() { return chain; },
    range(from: number, to: number) { range = [from, to]; ranges.push(range); return chain; },
    returns() { return chain; },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: table.slice(range[0], range[1] + 1), error: null }).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("./supabase-client", () => ({ getSupabaseBrowserClient: () => ({ from: builder }) }));

const { loadLoggedMinutesByTicket } = await import("./tickets");

beforeEach(() => {
  ranges.length = 0;
  filters = {};
  table = [];
});

describe("loadLoggedMinutesByTicket", () => {
  it("sums every author's minutes per ticket, with no date or author filter", async () => {
    table = [
      { ticket_id: "t1", minutes: 180 },
      { ticket_id: "t1", minutes: 120 },
      { ticket_id: "t2", minutes: 45 },
    ];
    const result = await loadLoggedMinutesByTicket(["t1", "t2", "t3"]);
    expect(result).toEqual({ status: "ready", minutesByTicketId: { t1: 300, t2: 45 } });
    expect(Object.keys(filters)).toEqual(["ticket_id"]);
  });

  it("pages past 1000 rows instead of truncating", async () => {
    table = Array.from({ length: 2300 }, () => ({ ticket_id: "t1", minutes: 1 }));
    const result = await loadLoggedMinutesByTicket(["t1"]);
    expect(result).toEqual({ status: "ready", minutesByTicketId: { t1: 2300 } });
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("makes no query without tickets", async () => {
    expect(await loadLoggedMinutesByTicket([])).toEqual({ status: "ready", minutesByTicketId: {} });
    expect(ranges).toHaveLength(0);
  });
});
