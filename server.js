const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const VERSION = "7.0";
const MAX_PAGES = 500;
const QUESTION_SELECTOR = ".q-question-item, .q-item, [class*='question']";

// Health endpoint with version
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: VERSION, timestamp: new Date().toISOString() });
});

// Progress helper
async function logProgress(supabase, jobId, message, level = "info", pageNumber = null) {
  await supabase.from("pdf_job_progress").insert({
    job_id: jobId, message, level, page_number: pageNumber,
  });
}

async function updateJobProgress(supabase, jobId, currentPage, totalPages = null) {
  const update = { current_page: currentPage, status: "running" };
  if (totalPages) update.total_pages = totalPages;
  await supabase.from("pdf_jobs").update(update).eq("id", jobId);
}

// Detect total pages from pagination
async function detectTotalPages(page) {
  try {
    // Try multiple selectors for pagination
    const totalFromText = await page.evaluate(() => {
      // Pattern: "1 de 324" or "Página 1 de 324"
      const texts = document.body.innerText;
      const match = texts.match(/(?:de|of)\s+(\d+)\s*(?:página|page)?/i);
      if (match) return parseInt(match[1]);

      // Try pagination links
      const links = Array.from(document.querySelectorAll('a[href*="page="], .pagination a, nav a'));
      let maxPage = 0;
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        const pageMatch = href.match(/page=(\d+)/);
        if (pageMatch) maxPage = Math.max(maxPage, parseInt(pageMatch[1]));
        const textMatch = link.textContent.trim().match(/^(\d+)$/);
        if (textMatch) maxPage = Math.max(maxPage, parseInt(textMatch[1]));
      }
      return maxPage > 0 ? maxPage : null;
    });
    return totalFromText;
  } catch { return null; }
}

// Check if page has questions
async function pageHasQuestions(page) {
  try {
    await page.waitForSelector(QUESTION_SELECTOR, { timeout: 10000 });
    const count = await page.locator(QUESTION_SELECTOR).count();
    return count > 0;
  } catch { return false; }
}

app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;
  res.json({ status: "accepted" }); // Return immediately

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let browser;

  try {
    await supabase.from("pdf_jobs").update({ status: "running" }).eq("id", jobId);
    await logProgress(supabase, jobId, "Iniciando navegador...", "pending");

    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    await logProgress(supabase, jobId, "Carregando primeira página...", "pending");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Detect total pages
    let totalPages = await detectTotalPages(page);
    if (totalPages) {
      await logProgress(supabase, jobId, `Total detectado: ${totalPages} páginas`, "info");
      await updateJobProgress(supabase, jobId, 0, totalPages);
    } else {
      await logProgress(supabase, jobId, "Total de páginas não detectado. Continuando até encontrar páginas vazias.", "info");
    }

    // Parse the base URL and starting page
    const url = new URL(targetUrl);
    const startPage = parseInt(url.searchParams.get("page") || "1");
    let currentPage = startPage;
    let consecutiveEmpty = 0;
    const uploadedPaths = [];

    while (consecutiveEmpty < 2 && currentPage - startPage < MAX_PAGES) {
      const pageUrl = new URL(targetUrl);
      pageUrl.searchParams.set("page", String(currentPage));

      await logProgress(supabase, jobId, `Processando página ${currentPage}...`, "pending", currentPage);
      await updateJobProgress(supabase, jobId, currentPage - startPage + 1, totalPages);

      let hasQuestions = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (currentPage > startPage || attempt > 1) {
            await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
          }
          hasQuestions = await pageHasQuestions(page);
          if (hasQuestions) break;
          if (attempt < 3) {
            await logProgress(supabase, jobId, `Página ${currentPage}: tentativa ${attempt} sem questões, retentando...`, "info", currentPage);
            await page.waitForTimeout(2000);
          }
        } catch (err) {
          if (attempt < 3) {
            await logProgress(supabase, jobId, `Página ${currentPage}: erro na tentativa ${attempt}, retentando...`, "info", currentPage);
            await page.waitForTimeout(3000);
          }
        }
      }

      if (!hasQuestions) {
        consecutiveEmpty++;
        await logProgress(supabase, jobId, `Página ${currentPage}: sem questões (${consecutiveEmpty}/2 consecutivas)`, "info", currentPage);
        currentPage++;
        continue;
      }

      consecutiveEmpty = 0;

      // Re-detect total if not found
      if (!totalPages && currentPage === startPage) {
        totalPages = await detectTotalPages(page);
        if (totalPages) {
          await logProgress(supabase, jobId, `Total detectado: ${totalPages} páginas`, "info");
          await updateJobProgress(supabase, jobId, currentPage - startPage + 1, totalPages);
        }
      }

      // Generate PDF for this page
      try {
        const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
        const date = new Date().toISOString().slice(0, 10);
        const storagePath = `${userId}/questoes_p${currentPage}_${date}.pdf`;

        const { error: uploadError } = await supabase.storage
          .from("pdfs")
          .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

        if (uploadError) {
          await logProgress(supabase, jobId, `Página ${currentPage}: erro no upload - ${uploadError.message}`, "error", currentPage);
        } else {
          uploadedPaths.push(storagePath);
          await logProgress(supabase, jobId, `Página ${currentPage}: PDF gerado e salvo ✓`, "success", currentPage);
        }
      } catch (err) {
        await logProgress(supabase, jobId, `Página ${currentPage}: erro ao gerar PDF - ${err.message}`, "error", currentPage);
      }

      // Check if we reached the detected total
      if (totalPages && currentPage >= totalPages + startPage - 1) {
        await logProgress(supabase, jobId, `Alcançou a última página detectada (${totalPages})`, "info");
        break;
      }

      currentPage++;
    }

    await browser.close();
    browser = null;

    const totalProcessed = uploadedPaths.length;
    const date = new Date().toISOString().slice(0, 10);
    const finalFilename = totalProcessed > 1
      ? `questoes_p${startPage}-p${currentPage - consecutiveEmpty}_${date}.pdf`
      : `questoes_p${startPage}_${date}.pdf`;
    const finalPath = uploadedPaths.length > 0 ? uploadedPaths[uploadedPaths.length - 1] : null;

    await supabase.from("pdf_jobs").update({
      status: "completed",
      filename: finalFilename,
      storage_path: finalPath,
      current_page: totalProcessed,
      total_pages: totalProcessed,
    }).eq("id", jobId);

    await logProgress(supabase, jobId, `Concluído! ${totalProcessed} página(s) processada(s).`, "success");

  } catch (err) {
    console.error("Job error:", err);
    await supabase.from("pdf_jobs").update({
      status: "failed", error_message: err.message,
    }).eq("id", jobId);
    await logProgress(supabase, jobId, `Erro fatal: ${err.message}`, "error");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server v${VERSION} listening on port ${PORT}`));
