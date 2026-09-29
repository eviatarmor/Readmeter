import { searchEntries } from "@/lib/nuqs-adapter";
import { getFiltersStateParser } from "@/lib/parsers";

describe("searchEntries", () => {
  it("keeps a dice filter array as one JSON value", () => {
    const filters = [
      {
        id: "severity",
        value: "",
        variant: "multiSelect",
        operator: "inArray",
        filterId: "hA21Lx4R",
      },
    ];
    const params = new URLSearchParams(searchEntries({ ffilters: filters, range: "7d" }));
    const parsed = getFiltersStateParser(["severity"]).parse(params.get("ffilters") ?? "");
    expect(parsed).toEqual(filters);
    expect(params.get("range")).toBe("7d");
  });
});
