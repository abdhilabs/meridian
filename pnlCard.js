import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "cache");
const METLEX_URL = "https://www.metlex.io/pnl-cards";

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Generate a PnL card image for a DLMM close transaction.
 * Uses Playwright native element.screenshot for accurate rendering.
 * @param {string} txSignature - Solana transaction signature
 * @returns {Promise<string|null>} - Path to the generated PNG, or null on failure
 */
export async function generatePnlCard(txSignature) {
  if (!txSignature) {
    log("pnlCard", "No txSignature provided, skipping card generation");
    return null;
  }

  const sanitized = txSignature.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  const outputPath = path.join(CACHE_DIR, `pnl-${sanitized}.png`);

  // Return cached if exists
  if (fs.existsSync(outputPath)) {
    log("pnlCard", `Using cached card: ${outputPath}`);
    return outputPath;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // Use deviceScaleFactor: 2 for retina quality
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1200 },
      deviceScaleFactor: 2,
    });

    const page = await context.newPage();

    log("pnlCard", "Navigating to Metlex...");
    await page.goto(METLEX_URL, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for the input field
    await page.waitForSelector('input.custom-input', { timeout: 15000 });

    // Type the transaction signature
    // Use pressSequentially instead of fill() — Metlex is a React app and
    // fill() doesn't trigger React's synthetic onChange event, leaving the
    // submit button stuck disabled.
    const input = page.locator('input.custom-input');
    await input.click();
    await input.pressSequentially(txSignature);
    log("pnlCard", `Typed tx: ${txSignature.slice(0, 16)}...`);

    // Click submit button (last button in main)
    const mainButtons = page.locator('main button');
    const btnCount = await mainButtons.count();
    if (btnCount > 0) {
      await mainButtons.nth(btnCount - 1).click();
    }
    log("pnlCard", "Submitted, waiting for card...");

    // Poll for the card element (w-[700px] uppercase h-[400px])
    const cardSelector = '.w-\\[700px\\].uppercase.h-\\[400px\\]';
    let cardFound = false;
    
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);

      // Check for error
      const hasError = await page.evaluate(() => {
        const el = document.querySelector('main p');
        return el?.textContent?.includes('not found') ? el.textContent.trim() : null;
      });

      if (hasError) {
        log("pnlCard", `TX lookup failed: ${hasError}`);
        await browser.close();
        return null;
      }

      // Check if card element exists
      const exists = await page.$(cardSelector);
      if (exists) {
        cardFound = true;
        break;
      }
    }

    if (!cardFound) {
      log("pnlCard", "Card element not found after 60s timeout");
      await browser.close();
      return null;
    }

    // Wait for fonts/images to fully render
    await page.waitForTimeout(2000);

    // Capture the card using Playwright's native element screenshot
    // This uses the actual rendering engine — most accurate method
    log("pnlCard", "Capturing card with Playwright element screenshot...");
    
    const cardEl = page.locator(cardSelector).first();
    await cardEl.screenshot({ path: outputPath });

    const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
    log("pnlCard", `Card saved: ${outputPath} (${sizeKB} KB)`);
    await browser.close();
    return outputPath;
  } catch (err) {
    log("pnlCard_error", `Failed to generate PnL card: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}
