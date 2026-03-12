// server.js v7.0 — Playwright PDF Generator Backend
const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERSION = "7.0.0";

// ── Health endpoint ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: VERSION, timestamp: new Date().toISOString() });
});

// ── Helper: log progress to Supabase ────────────────────────────
async function logProgress(supabase, jobId, message, level = "info", pageNumber = null) {
  try {
    await supabase.from("pdf_job_progress").insert({
      job_id: jobId,
      message,
      level,
      page_number: pageNumber,
    });
  } catch (err) {
    console.error("logProgress error:", err.message);
  }
}

async function updateJob(supabase, jobId, fields) {
  try {
    await supabase.from("pdf_jobs").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", jobId);
  } catch (err) {
    console.error("updateJob error:", err.message);
  }
}

// ── Helper: detect total pages from pagination ──────────────────
async function detectTotalPages(page) {
  try {
    // Strategy 1: look for "última" or last page link
    const lastPageNum = await page.evaluate(() => {
      // Check pagination links for highest page number
      const links = Array.from(document.querySelectorAll('a[href*="page="]'));
      let maxPage = 0;
      for (const link of links) {
        const match = link.href.match(/page=(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxPage) maxPage = num;
        }
      }
      // Also check pagination text like "1 de 24" or "Página 1 de 24"
      const paginationText = document.body.innerText;
      const textMatch = paginationText.match(/(?:de|of)\s+(\d+)\s*(?:página|page)?/i);
      if (textMatch) {
        const num = parseInt(textMatch[1], 10);
        if (num > maxPage) maxPage = num;
      }
      return maxPage;
    });
    return lastPageNum > 0 ? lastPageNum : null;
  } catch {
    return null;
  }
}

// ── Helper: check if page has questions ─────────────────────────
async function pageHasQuestions(page) {
  try {
    const count = await page.evaluate(() => {
      const selectors = [
        ".q-question-item",
        ".q-question",
        '[class*="question-item"]',
        '[class*="QuestionItem"]',
        ".question-content",
        '[data-testid*="question"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return 0;
    });
    return count > 0;
  } catch {
    return false;
  }
}

// ── Helper: extract start page from URL ─────────────────────────
function extractStartPage(url) {
  const match = url.match(/page=(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

// ── Helper: build page URL ──────────────────────────────────────
function buildPageUrl(baseUrl, pageNum) {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(pageNum));
  return url.toString();
}

// ── Helper: generate PDF for a single page with retries ─────────
async function generatePagePdf(page, url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      // Wait for content to render
      await page.waitForTimeout(2000);

      // Remove ads, headers, footers for cleaner PDF
      await page.evaluate(() => {
        const removeSelectors = [
          "header", "footer", "nav",
          '[class*="ad-"]', '[class*="banner"]',
          '[class*="cookie"]', '[id*="cookie"]',
          '[class*="popup"]', '[class*="modal"]',
          ".q-header", ".q-footer",
        ];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        }
      });

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      });

      return pdfBuffer;
    } catch (err) {
      console.error(`Page PDF attempt ${attempt} failed for ${url}:`, err.message);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── Main: generate-pdf endpoint ─────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Respond immediately (fire-and-forget)
  res.json({ status: "accepted", jobId });

  // Process in background
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let browser = null;

  try {
    await updateJob(supabase, jobId, { status: "running" });
    await logProgress(supabase, jobId, "Iniciando processamento...", "info");

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Navigate to first page to detect total
    const startPage = extractStartPage(targetUrl);
    const firstUrl = buildPageUrl(targetUrl, startPage);
    
    await logProgress(supabase, jobId, `Acessando página inicial (${startPage})...`, "info", startPage);
    await page.goto(firstUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);

    // Detect total pages
    let totalPages = await detectTotalPages(page);
    if (totalPages) {
      await logProgress(supabase, jobId, `Total de páginas detectado: ${totalPages}`, "info");
      await updateJob(supabase, jobId, { total_pages: totalPages });
    } else {
      await logProgress(supabase, jobId, "Total de páginas não detectado. Usando modo incremental.", "info");
    }

    // Pagination loop
    let currentPage = startPage;
    let consecutiveEmpty = 0;
    const MAX_PAGES = 500;
    const pdfPaths = [];
    const dateStr = new Date().toISOString().slice(0, 10);

    while (consecutiveEmpty < 2 && (currentPage - startPage) < MAX_PAGES) {
      // Check total_pages limit
      if (totalPages && currentPage > totalPages) {
        await logProgress(supabase, jobId, `Todas as ${totalPages} páginas processadas.`, "success");
        break;
      }

      const pageUrl = buildPageUrl(targetUrl, currentPage);
      await logProgress(supabase, jobId, `Processando página ${currentPage}${totalPages ? ` de ${totalPages}` : ""}...`, "info", currentPage);
      await updateJob(supabase, jobId, { current_page: currentPage });

      try {
        // Generate PDF for this page
        const pdfBuffer = await generatePagePdf(page, pageUrl);

        // Check if page has questions
        await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(1500);
        const hasQuestions = await pageHasQuestions(page);

        if (!hasQuestions) {
          consecutiveEmpty++;
          await logProgress(supabase, jobId, `Página ${currentPage}: sem questões encontradas (${consecutiveEmpty}/2 vazias consecutivas).`, "info", currentPage);
          currentPage++;
          continue;
        }

        // Reset empty counter
        consecutiveEmpty = 0;

        // Upload individual page PDF
        const pagePath = `${userId}/questoes_p${currentPage}_${dateStr}.pdf`;
        const { error: uploadError } = await supabase.storage
          .from("pdfs")
          .upload(pagePath, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true,
          });

        if (uploadError) {
          await logProgress(supabase, jobId, `Erro ao salvar PDF da página ${currentPage}: ${uploadError.message}`, "error", currentPage);
        } else {
          pdfPaths.push(pagePath);
          await logProgress(supabase, jobId, `Página ${currentPage} salva com sucesso.`, "success", currentPage);
        }

        // Re-detect total pages if not yet known
        if (!totalPages) {
          const detected = await detectTotalPages(page);
          if (detected) {
            totalPages = detected;
            await updateJob(supabase, jobId, { total_pages: totalPages });
            await logProgress(supabase, jobId, `Total de páginas atualizado: ${totalPages}`, "info");
          }
        }
      } catch (err) {
        await logProgress(supabase, jobId, `Erro na página ${currentPage}: ${err.message}`, "error", currentPage);
        consecutiveEmpty++;
      }

      currentPage++;
    }

    // Final status
    const totalProcessed = pdfPaths.length;
    const lastPage = currentPage - 1;
    const finalFilename = `questoes_p${startPage}-p${lastPage}_${dateStr}.pdf`;
    const finalPath = pdfPaths.length > 0 ? pdfPaths[pdfPaths.length - 1] : null;

    await updateJob(supabase, jobId, {
      status: "completed",
      filename: finalFilename,
      storage_path: finalPath,
      current_page: lastPage,
      total_pages: totalPages || lastPage,
    });

    await logProgress(supabase, jobId, `Concluído! ${totalProcessed} páginas processadas (p${startPage} a p${lastPage}).`, "success");

    await context.close();
  } catch (err) {
    console.error("Job failed:", err);
    await updateJob(supabase, jobId, { status: "failed", error_message: err.message });
    await logProgress(supabase, jobId, `Falha no processamento: ${err.message}`, "error");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`PDF Generator Backend v${VERSION} running on port ${PORT}`);
});
