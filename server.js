const express = require("express");
const fs = require("fs");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "50mb" }));

const VERSION = "8.2.4";
const PORT = process.env.PORT || 3000;

// ─── Health ────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  let execPath = "";
  let execExists = false;

  try {
    execPath = chromium.executablePath();
    execExists = fs.existsSync(execPath);
  } catch (e) {
    execPath = `error: ${e.message}`;
  }

  res.json({
    ok: execExists,
    service: "pdf-generator-backend",
    version: VERSION,
    playwrightExecutable: execPath,
    executableExists: execExists,
    browsersPathEnv: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "not set",
  });
});

// ─── Generate PDF ──────────────────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const log = async (message, level = "info", pageNumber = null) => {
    console.log(`[${level}] Job ${jobId}: ${message}`);
    try {
      await supabase.from("pdf_job_progress").insert({
        job_id: jobId,
        message,
        level,
        page_number: pageNumber,
      });
    } catch (e) {
      console.error("Log insert error:", e.message);
    }
  };

  // Respond immediately — processing continues in background
  res.json({ ok: true, jobId });

  let browser = null;

  try {
    // Update job to running
    await supabase.from("pdf_jobs").update({ status: "running" }).eq("id", jobId);
    await log("Iniciando navegador...");

    const resolvedExecutablePath = chromium.executablePath();
    const execExists = fs.existsSync(resolvedExecutablePath);

    console.log("PLAYWRIGHT_BROWSERS_PATH =", process.env.PLAYWRIGHT_BROWSERS_PATH);
    console.log("chromium.executablePath() =", resolvedExecutablePath);
    console.log("executable exists =", execExists);

    if (!execExists) {
      throw new Error(
        `Chromium binary not found at ${resolvedExecutablePath}. ` +
        `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`
      );
    }

    browser = await chromium.launch({
      headless: true,
      executablePath: resolvedExecutablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    await log("Navegador iniciado com sucesso.");

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await log("Acessando página...");

    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
    await log("Página carregada. Gerando PDF...");

    // Update total pages (simple: 1 for now)
    await supabase
      .from("pdf_jobs")
      .update({ total_pages: 1, current_page: 1 })
      .eq("id", jobId);

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });

    await log("PDF gerado. Fazendo upload...");

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

    await supabase
      .from("pdf_jobs")
      .update({
        status: "done",
        storage_path: storagePath,
        filename,
      })
      .eq("id", jobId);

    await log("Concluído com sucesso!");

    await context.close();
  } catch (err) {
    const errorMessage = err.message || String(err);
    console.error(`Job ${jobId} failed:`, errorMessage);

    await log(`Erro fatal: ${errorMessage}`, "error");

    await supabase
      .from("pdf_jobs")
      .update({ status: "failed", error_message: errorMessage })
      .eq("id", jobId);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
});

// ─── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`pdf-generator-backend v${VERSION} listening on port ${PORT}`);
  console.log("PLAYWRIGHT_BROWSERS_PATH =", process.env.PLAYWRIGHT_BROWSERS_PATH);

  try {
    const ep = chromium.executablePath();
    console.log("chromium.executablePath() =", ep);
    console.log("executable exists =", fs.existsSync(ep));
  } catch (e) {
    console.error("chromium.executablePath() error:", e.message);
  }
});
