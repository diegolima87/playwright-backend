// server.js v6.0 — Public pages, no login, paginated PDF generation
const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

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
  res.json({ status: "ok", version: "6.0", timestamp: new Date().toISOString() });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
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

  try {
    await supabase.from("pdf_jobs").update({ status: "running" }).eq("id", jobId);

    send({ type: "log", message: "Iniciando navegador...", level: "pending" });
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Block heavy resources
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    send({ type: "log", message: "Navegador pronto.", level: "info" });

    // Parse URL to detect current page number
    const urlObj = new URL(targetUrl);
    const startPage = parseInt(urlObj.searchParams.get("page") || "1", 10);

    // Discover total pages by visiting first page
    send({ type: "log", message: `Acessando página ${startPage}...`, level: "pending" });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Dismiss cookie banners if present
    try {
      const cookieBtn = page.locator('button:has-text("Aceitar"), button:has-text("OK"), .cookie-consent-accept');
      await cookieBtn.first().click({ timeout: 3000 });
    } catch {
      // No cookie banner
    }

    // Try to find total pages from pagination
    let totalPages = startPage;
    try {
      const lastPageLink = page.locator('.pagination a, nav[aria-label="pagination"] a').last();
      const lastPageHref = await lastPageLink.getAttribute("href", { timeout: 5000 });
      if (lastPageHref) {
        const lastPageUrl = new URL(lastPageHref, targetUrl);
        const lastPageNum = parseInt(lastPageUrl.searchParams.get("page") || "1", 10);
        if (lastPageNum > totalPages) totalPages = lastPageNum;
      }
    } catch {
      // Single page or unable to detect pagination
    }

    send({ type: "log", message: `Total de páginas detectado: ${totalPages - startPage + 1} (${startPage} a ${totalPages})`, level: "info" });

    const pdfBuffers = [];

    for (let currentPage = startPage; currentPage <= totalPages; currentPage++) {
      const pageProgress = Math.round(((currentPage - startPage) / (totalPages - startPage + 1)) * 100);
      send({ type: "progress", value: pageProgress });

      // Navigate to current page
      if (currentPage !== startPage) {
        urlObj.searchParams.set("page", String(currentPage));
        const pageUrl = urlObj.toString();
        send({ type: "log", message: `Acessando página ${currentPage}/${totalPages}...`, level: "pending" });
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      }

      // Wait for content to load
      try {
        await page.waitForSelector(".q-question-enunciation, .question-body, .q-item", { timeout: 15000 });
      } catch {
        send({ type: "log", message: `Aviso: conteúdo da página ${currentPage} pode estar incompleto.`, level: "info" });
      }

      // Generate PDF via page.pdf()
      send({ type: "log", message: `Gerando PDF da página ${currentPage}...`, level: "pending" });
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });

      pdfBuffers.push(pdfBuffer);

      const pageFilename = `questoes_p${currentPage}_${new Date().toISOString().slice(0, 10)}.pdf`;

      // Upload individual page PDF
      const storagePath = `${userId}/${jobId}/${pageFilename}`;
      const { error: uploadErr } = await supabase.storage
        .from("pdfs")
        .upload(storagePath, pdfBuffer, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (uploadErr) {
        send({ type: "log", message: `Erro ao salvar página ${currentPage}: ${uploadErr.message}`, level: "error" });
      } else {
        send({ type: "page_complete", page: currentPage, filename: pageFilename });
      }
    }

    // Update job with the last page's storage path (or first)
    const finalFilename = `questoes_${new Date().toISOString().slice(0, 10)}.pdf`;
    const finalStoragePath = `${userId}/${jobId}/${finalFilename}`;

    // If only one page, use it directly. Otherwise, note multiple files uploaded.
    if (pdfBuffers.length === 1) {
      await supabase.storage.from("pdfs").upload(finalStoragePath, pdfBuffers[0], {
        contentType: "application/pdf",
        upsert: true,
      });
    }

    await supabase.from("pdf_jobs").update({
      status: "completed",
      filename: finalFilename,
      storage_path: finalStoragePath,
    }).eq("id", jobId);

    send({ type: "progress", value: 100 });
    send({
      type: "complete",
      jobId,
      totalPages: pdfBuffers.length,
    });

    await context.close();
  } catch (err) {
    console.error("Generation error:", err);
    send({ type: "error", message: err.message || "Erro desconhecido" });
    await supabase.from("pdf_jobs").update({
      status: "failed",
      error_message: err.message || String(err),
    }).eq("id", jobId);
  }

  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server v6.0 running on port ${PORT}`));
