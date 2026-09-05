import { test, expect } from "bun:test";
import {
  ALL_SEASONAL_ITEMS,
  seasonalItems,
  seasonalItemsFor,
} from "./Seasonal.tsx";

const on = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

test("an ordinary day dresses the office in nothing", () => {
  expect(seasonalItems(on("2026-09-04"))).toEqual([]);
  expect(seasonalItems(on("2026-10-17"))).toEqual([]);
  expect(seasonalItems(on("2026-11-30"))).toEqual([]);
  expect(seasonalItems(on("2026-07-04"))).toEqual([]);
  expect(seasonalItems(on("2026-04-16"))).toEqual([]);
});

test("the pumpkin covers the week up to Halloween", () => {
  expect(seasonalItems(on("2026-10-24"))).toEqual([]);
  expect(seasonalItems(on("2026-10-25"))).toEqual(["pumpkin"]);
  expect(seasonalItems(on("2026-10-31"))).toEqual(["pumpkin"]);
  expect(seasonalItems(on("2026-11-01"))).toEqual([]);
});

test("the lights cover the second half of December", () => {
  expect(seasonalItems(on("2026-12-14"))).toEqual([]);
  expect(seasonalItems(on("2026-12-15"))).toEqual(["lights"]);
  expect(seasonalItems(on("2026-12-25"))).toEqual(["lights"]);
  expect(seasonalItems(on("2026-12-31"))).toEqual(["lights"]);
  expect(seasonalItems(on("2027-01-01"))).toEqual([]);
});

test("the chocolate box appears on Valentine's day only", () => {
  expect(seasonalItems(on("2026-02-13"))).toEqual([]);
  expect(seasonalItems(on("2026-02-14"))).toEqual(["valentine"]);
  expect(seasonalItems(on("2026-02-15"))).toEqual([]);
});

test("the query override replaces the calendar", () => {
  const ordinary = on("2026-09-04");
  expect(seasonalItemsFor("?officeDate=2026-12-25", ordinary)).toEqual([
    "lights",
  ]);
  expect(seasonalItemsFor("?officeDate=all", ordinary)).toEqual(
    ALL_SEASONAL_ITEMS,
  );
});

test("a missing or malformed override falls back to the real date", () => {
  const halloween = on("2026-10-31");
  expect(seasonalItemsFor("", halloween)).toEqual(["pumpkin"]);
  expect(seasonalItemsFor("?officeDate=", halloween)).toEqual(["pumpkin"]);
  expect(seasonalItemsFor("?officeDate=christmas", halloween)).toEqual([
    "pumpkin",
  ]);
  expect(seasonalItemsFor("?embed", halloween)).toEqual(["pumpkin"]);
});
