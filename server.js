const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.post("/generate-pdf", async (req, res) => {
  const {
    jobId, username, password, reportId, filters,
    supabaseUrl, supabaseServiceKey, userId,
  } = req.body;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const log = (message, level = "pending") => send({ type: "log", message, level });
  const progress = (value) => send({ type: "progress", value });

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let browser;
  try {
    // 1. Launch browser
    log("Iniciando navegador...");
    progress(5);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 2. Navigate to QConcursos login
    log("Navegando para QConcursos...");
    progress(10);
    await page.goto("https://www.qconcursos.com/usuario/entrar", { waitUntil: "networkidle", timeout: 30000 });

    // 3. Login
    log("Preenchendo credenciais...");
    progress(20);
    await page.fill('input[name="user[email]"], input[type="email"]', username);
    await page.fill('input[name="user[password]"], input[type="password"]', password);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });

    // Check login success
    const currentUrl = page.url();
    if (currentUrl.includes("entrar")) {
      throw new Error("Falha no login. Verifique suas credenciais.");
    }
    log("✓ Login realizado com sucesso!", "success");
    progress(30);

    // 4. Navigate to questions page
    log("Navegando para página de questões...");
    progress(40);

    let questionsUrl = "https://www.qconcursos.com/questoes-de-concursos/questoes";
    const params = new URLSearchParams();

    if (filters) {
      if (filters.questionType === "discursivas") {
        questionsUrl = "https://www.qconcursos.com/questoes-de-concursos/questoes-discursivas";
      }
      if (filters.disciplina) params.append("discipline_ids[]", filters.disciplina);
      if (filters.banca) params.append("examining_board_ids[]", filters.banca);
      if (filters.ano) params.append("year", filters.ano);
      if (filters.dificuldade) params.append("difficulty", filters.dificuldade);
      if (filters.cargo) params.append("role_ids[]", filters.cargo);
      if (filters.nivel) params.append("scholarity_ids[]", filters.nivel);
      if (filters.keyword) params.append("q", filters.keyword);
    }

    const queryString = params.toString();
    if (queryString) questionsUrl += `?${queryString}`;

    await page.goto(questionsUrl, { waitUntil: "networkidle", timeout: 30000 });
    log("✓ Página de questões carregada.", "success");
    progress(55);

    // 5. Generate PDF
    log("Gerando PDF da página...");
    progress(65);

    // Expand all questions if possible
    try {
      const expandButtons = await page.$$('button:has-text("Ver resposta"), button:has-text("Comentário")');
      for (const btn of expandButtons.slice(0, 50)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(200);
      }
    } catch {
      // Continue even if expansion fails
    }

    // Remove headers/footers/ads for cleaner PDF
    await page.evaluate(() => {
      const selectors = ["header", "footer", "nav", ".ads", ".banner", "[class*='advertisement']", "[class*='cookie']"];
      selectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      });
    });

    progress(75);
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });
    log("✓ PDF gerado!", "success");
    progress(85);

    // 6. Upload to Supabase Storage
    log("Fazendo upload para o storage...");
    const filename = `relatorio_${new Date().toISOString().slice(0, 10)}_${jobId.slice(0, 8)}.pdf`;
    const storagePath = `${userId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

    if (uploadError) throw new Error(`Upload falhou: ${uploadError.message}`);
    log("✓ Upload concluído!", "success");
    progress(95);

    // 7. Update job record
    await supabase
      .from("pdf_jobs")
      .update({ status: "completed", storage_path: storagePath, updated_at: new Date().toISOString() })
      .eq("id", jobId);

    progress(100);
    send({ type: "complete", jobId });
  } catch (err) {
    log(`Erro: ${err.message}`, "error");
    send({ type: "error", message: err.message });

    await supabase
      .from("pdf_jobs")
      .update({ status: "failed", error_message: err.message, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
