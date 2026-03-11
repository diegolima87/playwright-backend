// server.js v5.2 — Playwright PDF Backend (Render)
import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  browserInstance = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return browserInstance;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "5.2", timestamp: new Date().toISOString() });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, username, password, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !username || !password || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const log = (message, level = "pending") => send({ type: "log", message, level });

  let context = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Block heavy resources during navigation
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) return route.abort();
      return route.continue();
    });

    log("Navegador pronto.");

    // === LOGIN ===
    log("Fazendo login...");
    await page.goto("https://www.qconcursos.com/conta/entrar", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Dismiss cookie banners
    try {
      const cookieBtn = page.locator(
        'button:has-text("Aceitar"), button:has-text("Concordo"), button:has-text("OK"), .js-cookies-agreement button'
      );
      await cookieBtn.first().click({ timeout: 3000 }).catch(() => {});
    } catch {}

    // Wait for login form
    await page.locator("#login_email").waitFor({ state: "visible", timeout: 60000 });

    await page.fill("#login_email", username, { timeout: 10000 });
    await page.fill("#login_password", password, { timeout: 10000 });
    await page.click("#btnLogin", { timeout: 10000 });

    // Wait for navigation after login
    await page.waitForURL((url) => !url.href.includes("/conta/entrar"), { timeout: 30000 });
    log("Login OK!");

    // === NAVIGATE TO TARGET ===
    log("Carregando página alvo...");

    // Unblock all resources for PDF
    await page.unroute("**/*");

    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });

    // === GENERATE PDF ===
    log("Gerando PDF...");
    send({ type: "progress", value: 50 });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", bottom: "15mm", left: "10mm", right: "10mm" },
    });

    const sizeKB = Math.round(pdfBuffer.length / 1024);
    log(`PDF gerado (${sizeKB} KB). Enviando para storage...`);
    send({ type: "progress", value: 75 });

    // === UPLOAD TO SUPABASE STORAGE ===
    const filename = `questoes_${new Date().toISOString().slice(0, 10)}.pdf`;
    const storagePath = `${userId}/${jobId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Update job record
    await supabase
      .from("pdf_jobs")
      .update({
        status: "completed",
        storage_path: storagePath,
        filename,
      })
      .eq("id", jobId);

    send({ type: "progress", value: 100 });
    send({ type: "complete", jobId, totalPages: 1, filename });
  } catch (err) {
    console.error("Generation error:", err);
    log(`Erro: ${err.message}`, "error");
    send({ type: "error", message: err.message });

    await supabase
      .from("pdf_jobs")
      .update({ status: "failed", error_message: err.message })
      .eq("id", jobId)
      .catch(() => {});
  } finally {
    if (context) await context.close().catch(() => {});
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server v5.2 running on port ${PORT}`));
