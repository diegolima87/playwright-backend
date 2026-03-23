const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));

const VERSION = "8.2.4";

app.get("/health", (_req, res) => {
  const execPath = chromium.executablePath();
  const exists = fs.existsSync(execPath);
  res.json({
    ok: exists,
    service: "pdf-generator-backend",
    version: VERSION,
    playwrightExecutable: execPath,
    executableExists: exists,
    browsersPathEnv: process.env.PLAYWRIGHT_BROWSERS_PATH || "not set",
  });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.json({ ok: true, message: "Job accepted" });

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const logProgress = async (message, level = "info") => {
    console.log(`[${level}] Job ${jobId}: ${message}`);
    try {
      await supabase.from("pdf_job_progress").insert({
        job_id: jobId,
        message,
        level,
      });
    } catch (e) {
      console.error("Log insert error:", e.message);
    }
  };

  let browser = null;
  try {
    await supabase.from("pdf_jobs").update({ status: "running" }).eq("id", jobId);
    await logProgress("Iniciando navegador...");

    const resolvedPath = chromium.executablePath();
    const pathExists = fs.existsSync(resolvedPath);
    await logProgress(
      `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || "not set"}, ` +
      `executablePath=${resolvedPath}, exists=${pathExists}`
    );

    if (!pathExists) {
      throw new Error(`Chromium not found at ${resolvedPath}`);
    }

    browser = await chromium.launch({
      headless: true,
      executablePath: resolvedPath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await logProgress(`Navegando para ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 120000 });
    await logProgress("Página carregada. Gerando PDF...");

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" },
    });

    await logProgress(`PDF gerado (${(pdfBuffer.length / 1024).toFixed(1)} KB). Enviando...`);

    const filename = `questoes_${new Date().toISOString().slice(0, 10)}_${jobId.slice(0, 8)}.pdf`;
    const storagePath = `${userId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from("pdfs").getPublicUrl(storagePath);

    await supabase
      .from("pdf_jobs")
      .update({ status: "done", storage_path: storagePath, filename })
      .eq("id", jobId);

    await logProgress("Concluído com sucesso!");
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err.message);
    await logProgress(`Erro: ${err.message}`, "error");
    await supabase.from("pdf_jobs").update({ status: "failed", error_message: err.message }).eq("id", jobId);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend v${VERSION} on port ${PORT}`));
