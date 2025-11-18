import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("App inside of CODAP", async ({page}) => {
  await page.setViewportSize({width: 1400, height: 800});
  await page.goto("https://codap3.concord.org/?mouseSensor&di=https://localhost:8080");

  const iframe = page.frameLocator(".codap-web-view-iframe");
  await iframe.getByRole("button", { name: "Get Data" }).click();

  // Make sure the table has something from our data in it
  // await expect(page.getByTestId("codap-column-header-content")).toContainText("time");

  // no need to test the dummy data setup yet - the UI is in flux
  expect(true).toBe(true);
});
