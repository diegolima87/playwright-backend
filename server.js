const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserInstance;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "7.0", timestamp: new Date().toISOString() });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Return immediately - process in background
  res.json({ status: "started", jobId });

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const log = async (message, level = "info", pageNumber = null) => {
    console.log(`[${level}] ${message}`);
    await supabase.from("pdf_job_progress").insert({
      job_id: jobId,
      message,
      level,
      page_number: pageNumber,
    }).catch((err) => console.error("Log insert error:", err.message));
  };

  try {
    await supabase.from("pdf_jobs").update({ status: "running" }).eq("id", jobId);
    await log("Iniciando navegador...", "pending");

    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });

    await log("Navegador pronto.", "info");

    const urlObj = new URL(targetUrl);
    let currentPage = parseInt(urlObj.searchParams.get("page") || "1", 10);
    const startPage = currentPage;
    let totalGenerated = 0;
    let lastPage = null;
    const MAX_PAGES = 500;

    while (true) {
      // Safety limit
      if (totalGenerated >= MAX_PAGES) {
        await log(`Limite de segurança atingido (${MAX_PAGES} páginas). Finalizando.`, "info");
        break;
      }

      urlObj.searchParams.set("page", String(currentPage));
      const pageUrl = urlObj.toString();

      await log(`Acessando página ${currentPage}${lastPage ? ` de ${lastPage}` : ""}...`, "pending", currentPage);

      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Accept cookies on first page
      if (totalGenerated === 0) {
        try {
          const cookieBtn = page.locator('button:has-text("Aceitar"), button:has-text("OK"), .cookie-consent-accept');
          await cookieBtn.first().click({ timeout: 3000 });
        } catch { /* No cookie banner */ }
      }

      // Detect last page from pagination (hybrid strategy)
      if (lastPage === null) {
        try {
          const detectedLast = await page.evaluate(() => {
            // Try multiple selectors for pagination
            const selectors = [
              '.pagination a:last-of-type',
              '.pagination li:last-child a',
              'a[aria-label="Última"]',
              'a[aria-label="Last"]',
              '.page-link:last-of-type',
              'nav[aria-label="pagination"] a:last-of-type',
            ];
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const href = el.getAttribute("href") || "";
                const match = href.match(/page=(\d+)/);
                if (match) return parseInt(match[1], 10);
                const text = el.textContent?.trim();
                if (text && /^\d+$/.test(text)) return parseInt(text, 10);
              }
            }
            // Fallback: find highest page number in any pagination link
            const allLinks = document.querySelectorAll('a[href*="page="]');
            let max = 0;
            for (const link of allLinks) {
              const m = link.getAttribute("href")?.match(/page=(\d+)/);
              if (m) max = Math.max(max, parseInt(m[1], 10));
            }
            return max > 0 ? max : null;
          });

          if (detectedLast && detectedLast > currentPage) {
            lastPage = detectedLast;
            await log(`Última página detectada: ${lastPage}`, "info");
            await supabase.from("pdf_jobs").update({ total_pages: lastPage }).eq("id", jobId);
          }
        } catch { /* Pagination detection failed, will use fallback */ }
      }

      // Update current page in DB for progress tracking
      await supabase.from("pdf_jobs").update({ current_page: currentPage }).eq("id", jobId);

      // Check if page has questions
      const hasQuestions = await page
        .locator(".q-question-enunciation, .question-body, .q-item, .q-question-item")
        .first()
        .isVisible({ timeout: 10000 })
        .catch(() => false);

      if (!hasQuestions) {
        await log(`Página ${currentPage} sem questões. Finalizando.`, "info", currentPage);
        break;
      }

      // If we passed the detected last page, also stop
      if (lastPage && currentPage > lastPage) {
        await log(`Passou da última página (${lastPage}). Finalizando.`, "info");
        break;
      }

      try {
        await page.waitForSelector(
          ".q-question-enunciation, .question-body, .q-item, .q-question-item",
          { timeout: 15000 }
        );
        await page.waitForTimeout(1000);
      } catch {
        await log(`Aviso: conteúdo da página ${currentPage} pode estar incompleto.`, "info", currentPage);
      }

      await log(`Gerando PDF da página ${currentPage}...`, "pending", currentPage);
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });

      const pageFilename = `questoes_p${currentPage}_${new Date().toISOString().slice(0, 10)}.pdf`;
      const storagePath = `${userId}/${jobId}/${pageFilename}`;

      const { error: uploadErr } = await supabase.storage
        .from("pdfs")
        .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

      if (uploadErr) {
        await log(`Erro ao salvar página ${currentPage}: ${uploadErr.message}`, "error", currentPage);
      } else {
        await log(`✓ Página ${currentPage} salva: ${pageFilename}`, "success", currentPage);
      }

      totalGenerated++;
      currentPage++;
    }

    // Finalize
    const lastProcessedPage = currentPage - 1;
    const finalFilename = totalGenerated === 1
      ? `questoes_p${startPage}_${new Date().toISOString().slice(0, 10)}.pdf`
      : `questoes_p${startPage}-p${lastProcessedPage}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const finalStoragePath = `${userId}/${jobId}/${finalFilename}`;

    await supabase.from("pdf_jobs").update({
      status: "completed",
      filename: finalFilename,
      storage_path: finalStoragePath,
      current_page: lastProcessedPage,
      total_pages: lastPage || lastProcessedPage,
    }).eq("id", jobId);

    await log(`✓ Concluído! ${totalGenerated} página(s) gerada(s).`, "success");
    await context.close();
  } catch (err) {
    console.error("Generation error:", err);
    await log(`Erro: ${err.message || "Erro desconhecido"}`, "error");
    await supabase.from("pdf_jobs").update({
      status: "failed",
      error_message: err.message || String(err),
    }).eq("id", jobId);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server v7.0 running on port ${PORT}`));
