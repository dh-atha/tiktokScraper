import { chromium } from "playwright";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";

function sanitizeCookies(cookies) {
  return cookies
    .filter((c) => c.name && c.value) // wajib ada
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expires: c.expires && Number.isFinite(c.expires) ? c.expires : -1,
      sameSite:
        c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None"
          ? c.sameSite
          : "None", // default
    }));
}

async function loadCookies() {
  const rawCookies = JSON.parse(fs.readFileSync("cookies.json", "utf8"));
  const valid = sanitizeCookies(rawCookies);
  return valid;
}

async function scrapeTikTok(accountUrl, limit = 5) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const cookies = await loadCookies();
  await context.addCookies(cookies);

  const page = await context.newPage();
  console.log("[+] Opening profile:", accountUrl);

  await page.goto(accountUrl, { timeout: 60000 });
  await page.waitForSelector("div[data-e2e='user-post-item'] a");

  // Collect video links
  const videoLinks = await page.$$eval(
    "div[data-e2e='user-post-item'] a",
    (els) => els.map((e) => e.href).filter((url) => url.includes("video"))
  );

  const recent = videoLinks.slice(0, limit);
  console.log(`[+] Found ${recent.length} videos`);

  const rows = [];

  for (const link of recent) {
    console.log("[+] Scraping:", link);
    await page.goto(link, { timeout: 60000 });

    const likes = await page
      .$eval("strong[data-e2e='like-count']", (el) => el.textContent)
      .catch(() => "");

    const shares = await page
      .$eval("strong[data-e2e='share-count']", (el) => el.textContent)
      .catch(() => "");

    // === LOAD COMMENTS (max 10, alphanumeric) ===

    // 1. Click comment button if present
    try {
      await page.click("button[data-e2e='comment-icon']", { timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log("[-] No comment button or auto-open.");
    }

    // Wait comment container
    await page.waitForTimeout(1500);

    async function getComments(page) {
      return await page.evaluate(() => {
        const clean = (t) => t.replace(/[^a-zA-Z0-9 ]/g, "");

        const items = document.querySelectorAll(
          'span[data-e2e="comment-level-1"]'
        );

        const items2 = document.querySelectorAll(
          'span[data-e2e="comment-level-2"]'
        );

        return [...items, ...items2]
          .map((el) => clean(el.textContent.trim()))
          .filter((text) => text.length > 2);
      });
    }

    const comments = new Set();

    for (let i = 0; i < 20 && comments.size < 10; i++) {
      const batch = await getComments(page);
      batch.forEach((c) => {
        if (comments.size < 10) comments.add(c);
      });

      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(500);
    }

    rows.push({
      video_url: link,
      likes,
      shares,
      comments: [...comments].join(" | "),
    });
  }

  await browser.close();
  return rows;
}

async function saveCSV(rows, fileName) {
  const writer = createObjectCsvWriter({
    path: fileName,
    header: [
      { id: "video_url", title: "video_url" },
      { id: "likes", title: "likes" },
      { id: "shares", title: "shares" },
      { id: "comments", title: "comments" },
    ],
  });

  await writer.writeRecords(rows);
  console.log("[✓] CSV saved:", fileName);
}

// RUN SCRIPT
(async () => {
  const account = "https://www.tiktok.com/@ittstangsel";
  const result = await scrapeTikTok(account, 20);
  await saveCSV(result, "itts_tiktok_latest.csv");
})();
