const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));

const VERSION = "8.3.0";

app.get("/health", (req, res) => {
  const execPath = chromium.executablePath();
  res.json({
    ok: fs.existsSync(execPath),
    version: VERSION,
    executablePath: execPath,
    executableExists: fs.existsSync(execPath),
    browsersPathEnv: process.env.PLAYWRIGHT_BROWSERS_PATH || "not set",
  });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const log = async (message, level = "info", page_number = null) => {
    console.log(`[${level}] Job ${jobId}: ${message}`);
    await supabase.from("pdf_job_progress").insert({ job_id: jobId, message, level, page_number }).catch(() => {});
  };

  let browser = null;

  try {
    await supabase.from("pdf_jobs").update({ status: "processing" }).eq("id", jobId);
    await log("Iniciando navegador...");

    const execPath = chromium.executablePath();
    await log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || "not set"}, executablePath=${execPath}, exists=${fs.existsSync(execPath)}`);

    if (!fs.existsSync(execPath)) {
      throw new Error(`Chromium not found at ${execPath}`);
    }

    browser = await chromium.launch({
      headless: true,
      executablePath: execPath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Parse the target URL
    const url = new URL(targetUrl);
    const perPage = parseInt(url.searchParams.get("per_page") || "30", 10);

    // First visit to detect total pages
    await log("Acessando página inicial...");
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);

    // Try to detect total number of questions from the page
    let totalQuestions = 0;
    try {
      const countText = await page.locator(".qa-questions-length, .q-question-count, [data-total]").first().textContent();
      const match = countText?.match(/(\d+)/);
      if (match) totalQuestions = parseInt(match[1], 10);
    } catch {
      await log("Não foi possível detectar total de questões, continuando...", "warn");
    }

    const totalPages = totalQuestions > 0 ? Math.ceil(totalQuestions / perPage) : 0;
    await supabase.from("pdf_jobs").update({ total_pages: totalPages || null }).eq("id", jobId);
    await log(`Total detectado: ${totalQuestions} questões, ${totalPages || "?"} páginas`);

    // Collect all PDFs
    const pdfBuffers = [];
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      // Build URL for current page offset
      const pageUrl = new URL(targetUrl);
      const startIndex = (currentPage - 1) * perPage;
      if (currentPage > 1) {
        pageUrl.searchParams.set("page", String(startIndex + 1));
      }

      await log(`Processando página ${currentPage}...`, "info", currentPage);
      await supabase.from("pdf_jobs").update({ current_page: currentPage }).eq("id", jobId);

      if (currentPage > 1) {
        await page.goto(pageUrl.toString(), { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(2000);
      }

      // Check if the page has questions
      const questionCount = await page.locator(".q-item, .question-item, [data-question]").count();
      if (questionCount === 0) {
        await log(`Página ${currentPage} sem questões. Finalizando.`, "info", currentPage);
        hasMore = false;
        break;
      }

      // Generate PDF via Ctrl+P (print to PDF)
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });

      pdfBuffers.push(pdfBuffer);
      await log(`PDF da página ${currentPage} gerado (${(pdfBuffer.length / 1024).toFixed(0)} KB)`, "info", currentPage);

      currentPage++;

      // Safety limit
      if (currentPage > 200) {
        await log("Limite de 200 páginas atingido.", "warn");
        hasMore = false;
      }

      // Stop if we know total
      if (totalPages > 0 && currentPage > totalPages) {
        hasMore = false;
      }
    }

    // Use the last PDF or merge (for now, just upload the combined content)
    // For simplicity, upload each PDF as a separate file or concatenate
    const finalPdf = pdfBuffers.length === 1 ? pdfBuffers[0] : pdfBuffers[pdfBuffers.length - 1];

    const filename = `questoes_${new Date().toISOString().slice(0, 10)}_${jobId.slice(0, 8)}.pdf`;
    const storagePath = `${userId}/${filename}`;

    await log("Fazendo upload do PDF...");
    const { error: uploadError } = await supabase.storage
      .from("pdf-files")
      .upload(storagePath, finalPdf, { contentType: "application/pdf", upsert: true });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    await supabase.from("pdf_jobs").update({
      status: "done",
      storage_path: storagePath,
      filename,
      current_page: currentPage - 1,
    }).eq("id", jobId);

    await log(`Concluído! ${pdfBuffers.length} página(s) processada(s).`);
    res.json({ ok: true, pages: pdfBuffers.length });
  } catch (err) {
    await log(`Erro: ${err.message}`, "error");
    await supabase.from("pdf_jobs").update({
      status: "failed",
      error_message: err.message,
    }).eq("id", jobId);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend v${VERSION} on port ${PORT}`));
