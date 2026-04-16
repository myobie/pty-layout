import { describe, it, expect } from "vitest";
import { buildPickerVisualRows, computePickerScroll, type PickerVisualRow } from "../src/render.ts";
import type { PickerState, PickerGroup, PickerItem } from "../src/session-picker.ts";

function makeItem(name: string, type: PickerItem["type"] = "local"): PickerItem {
  return {
    type,
    label: name,
    detail: "",
    sessionName: name,
    name,
    running: true,
  };
}

function makeState(groups: PickerGroup[]): PickerState {
  const flatItems = groups.flatMap((g) => g.items);
  return {
    allGroups: [],
    relayHosts: [],
    localSessions: [],
    tagFilters: [],
    groups,
    flatItems,
    selectedIndex: 0,
    filter: "",
    loading: false,
  };
}

describe("buildPickerVisualRows", () => {
  it("returns empty for empty state", () => {
    const state = makeState([]);
    expect(buildPickerVisualRows(state)).toEqual([]);
  });

  it("includes a header row per group", () => {
    const state = makeState([
      { title: "Local", items: [makeItem("a"), makeItem("b")] },
      { title: "remote.example.com", items: [makeItem("c")] },
    ]);
    const rows = buildPickerVisualRows(state);
    const headers = rows.filter((r) => r.kind === "header");
    expect(headers.length).toBe(2);
    expect(headers[0]!.content).toContain("Local");
    expect(headers[1]!.content).toContain("remote.example.com");
  });

  it("assigns sequential itemIndex across groups", () => {
    const state = makeState([
      { title: "A", items: [makeItem("a1"), makeItem("a2")] },
      { title: "B", items: [makeItem("b1")] },
    ]);
    const rows = buildPickerVisualRows(state);
    const items = rows.filter((r) => r.kind === "item");
    expect(items.map((r) => r.itemIndex)).toEqual([0, 1, 2]);
  });

  it("renders create items without the status dot", () => {
    const state = makeState([
      { title: "Local", items: [{ type: "create-local", label: "+ New session" }] },
    ]);
    const rows = buildPickerVisualRows(state);
    const item = rows.find((r) => r.kind === "item");
    expect(item!.content).toBe("+ New session");
    expect(item!.content).not.toContain("●");
  });

  it("renders session items with a status dot", () => {
    const state = makeState([
      { title: "Local", items: [makeItem("foo")] },
    ]);
    const rows = buildPickerVisualRows(state);
    const item = rows.find((r) => r.kind === "item");
    expect(item!.content).toContain("●");
    expect(item!.content).toContain("foo");
  });
});

describe("computePickerScroll", () => {
  // Build a predictable visual row list: header + N items per group
  function buildRows(groupSizes: number[]): PickerVisualRow[] {
    const rows: PickerVisualRow[] = [];
    let itemIdx = 0;
    groupSizes.forEach((n, gi) => {
      rows.push({ kind: "header", content: `group-${gi}` });
      for (let i = 0; i < n; i++) {
        rows.push({ kind: "item", content: `item-${itemIdx}`, itemIndex: itemIdx });
        itemIdx++;
      }
    });
    return rows;
  }

  it("returns 0 when everything fits in the viewport", () => {
    const rows = buildRows([3]); // 1 header + 3 items = 4 rows
    expect(computePickerScroll(rows, 0, 10)).toBe(0);
    expect(computePickerScroll(rows, 2, 10)).toBe(0);
  });

  it("returns 0 when selected is already visible at top", () => {
    const rows = buildRows([20]); // 21 rows
    expect(computePickerScroll(rows, 0, 10)).toBe(0);
  });

  it("scrolls down when selected is below the viewport", () => {
    const rows = buildRows([20]); // 1 header + 20 items
    // Selected at item 15 — visual row 16 (after the header at 0)
    const offset = computePickerScroll(rows, 15, 10);
    // Selected should be in the visible window
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(16);
    expect(offset + 10).toBeGreaterThan(16);
  });

  it("clamps scroll to list bounds", () => {
    const rows = buildRows([20]); // 21 rows total
    // Selected at last item
    const offset = computePickerScroll(rows, 19, 10);
    expect(offset).toBeLessThanOrEqual(rows.length - 10);
    expect(offset + 10).toBeGreaterThanOrEqual(20);
  });

  it("keeps selected item in view across groups", () => {
    const rows = buildRows([3, 3, 3]); // 3 headers + 9 items = 12 rows
    // Selected at item 7 (in third group) — visual row: 0(h) + 3(items) + 1(h) + 3(items) + 1(h) + 1(item7) = 9
    const offset = computePickerScroll(rows, 7, 5);
    expect(offset).toBeGreaterThan(0);
    // Item 7 at visual row 9 must be in [offset, offset+5)
    expect(9).toBeGreaterThanOrEqual(offset);
    expect(9).toBeLessThan(offset + 5);
  });

  it("includes the group header when there's room", () => {
    const rows = buildRows([2, 2]); // 2 headers + 4 items = 6 rows
    // Selected at item 3 (first item of second group) — visual row 4
    // Header for group 2 is at row 3
    const offset = computePickerScroll(rows, 3, 4);
    // Both the header (row 3) and the item (row 4) should be visible
    expect(3).toBeGreaterThanOrEqual(offset);
    expect(4).toBeLessThan(offset + 4);
  });

  it("returns 0 when selected item is not found", () => {
    const rows = buildRows([3]);
    // selectedIndex=99 doesn't exist
    expect(computePickerScroll(rows, 99, 5)).toBe(0);
  });
});
