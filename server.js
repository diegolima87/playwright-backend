require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = "8.2.1";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function getSupabaseAdmin(supabaseUrl, supabaseServiceKey) {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes");
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function addJobLog(supabase, jobId, message, level = "info", pageNumber = null) {
  try {
    await supabase.from("pdf_job_progress").insert({
      job_id: jobId,
      message,
      level,
      page_number: pageNumber,
    });
  } catch (error) {
    console.error("Erro ao gravar log:", error.message);
  }
}

async function updateJob(supabase, jobId, patch) {
  const { error } = await supabase.from("pdf_jobs").update(patch).eq("id", jobId);
  if (error) {
    throw new Error(`Erro ao atualizar job: ${error.message}`);
  }
}

app.get("/health", async (_req, res) => {
  try {
    const executablePath = chromium.executablePath();

    return res.status(200).json({
      ok: true,
      service: "pdf-generator-backend",
      version: VERSION,
      playwrightExecutable: executablePath,
      browsersPathEnv: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "pdf-generator-backend",
      version: VERSION,
      error: error.message,
    });
  }
});

app.post("/generate-pdf", async (req, res) => {
  const {
    jobId,
    targetUrl,
    supabaseUrl,
    supabaseServiceKey,
    userId,
  } = req.body || {};

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({
      error: "Campos obrigatórios ausentes: jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId",
    });
  }

  let browser;

  try {
    const supabase = getSupabaseAdmin(supabaseUrl, supabaseServiceKey);

    await updateJob(supabase, jobId, {
      status: "processing",
      error_message: null,
    });

    await addJobLog(supabase, jobId, "Iniciando navegador...");

    const resolvedExecutablePath = chromium.executablePath();
    console.log("PLAYWRIGHT EXECUTABLE:", resolvedExecutablePath);
    console.log("PLAYWRIGHT_BROWSERS_PATH:", process.env.PLAYWRIGHT_BROWSERS_PATH || "(not set)");

    browser = await chromium.launch({
      headless: true,
      executablePath: resolvedExecutablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    await addJobLog(supabase, jobId, "Navegador iniciado com sucesso.");

    const page = await browser.newPage({
      viewport: { width: 1440, height: 2200 },
    });

    await addJobLog(supabase, jobId, "Abrindo página alvo...");
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await page.waitForTimeout(3000);

    await addJobLog(supabase, jobId, "Página carregada com sucesso.");

    // ==========================================================
    // MANTENHA AQUI A SUA LÓGICA REAL DE SCRAPING / PDF / UPLOAD
    // ==========================================================
    // Exemplo:
    // 1. paginar conteúdo
    // 2. montar PDF
    // 3. enviar para Supabase Storage
    // 4. atualizar storage_path / total_pages / etc.
    //
    // O ponto crítico corrigido aqui é:
    // - PLAYWRIGHT_BROWSERS_PATH=0 no Dockerfile
    // - executablePath: chromium.executablePath() no launch
    // ==========================================================

    await addJobLog(supabase, jobId, "Processamento base concluído.");

    await updateJob(supabase, jobId, {
      status: "completed",
      error_message: null,
    });

    return res.status(200).json({
      ok: true,
      jobId,
      message: "Job executado com sucesso.",
    });
  } catch (error) {
    console.error("Erro fatal:", error.message);

    try {
      const supabase = getSupabaseAdmin(supabaseUrl, supabaseServiceKey);

      await addJobLog(
        supabase,
        jobId,
        `Erro fatal: ${error.message}`,
        "error"
      );

      await updateJob(supabase, jobId, {
        status: "failed",
        error_message: error.message,
      });
    } catch (updateError) {
      console.error("Erro ao marcar job como failed:", updateError.message);
    }

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error("Erro ao fechar browser:", closeError.message);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`PDF Generator Backend v${VERSION} running on port ${PORT}`);
});
