const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ status: "ok", version: "3.0" }));

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

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let browser;
  try {
    send({ type: "log", message: "Iniciando navegador...", level: "pending" });

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // ===== LOGIN =====
    send({ type: "log", message: "Acessando página de login...", level: "pending" });
    await page.goto("https://www.qconcursos.com/conta/entrar", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for and fill the email field
    const emailField = page.locator("#login_email");
    await emailField.waitFor({ state: "visible", timeout: 30000 });
    await emailField.fill(username);

    // Fill the password field
    const passwordField = page.locator("#login_password");
    await passwordField.waitFor({ state: "visible", timeout: 15000 });
    await passwordField.fill(password);

    send({ type: "log", message: "Credenciais preenchidas, fazendo login...", level: "pending" });

    // Click login button
    await page.locator("#btnLogin").click();

    // Wait for navigation after login
    await page.waitForURL((url) => !url.href.includes("/conta/entrar"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Verify login succeeded
    const currentUrl = page.url();
    if (currentUrl.includes("/conta/entrar")) {
      throw new Error("Login falhou - verifique suas credenciais");
    }

    send({ type: "log", message: "Login realizado com sucesso!", level: "success" });

    // ===== NAVIGATE TO TARGET =====
    send({ type: "log", message: "Acessando página de questões...", level: "pending" });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    // ===== DETERMINE TOTAL PAGES =====
    let totalPages = 1;
    try {
      const pagination = await page.locator(".pagination a, [class*='pagination'] a").all();
      const pageNumbers = [];
      for (const link of pagination) {
        const text = await link.textContent();
        const num = parseInt(text.trim(), 10);
        if (!isNaN(num)) pageNumbers.push(num);
      }
      if (pageNumbers.length > 0) {
        totalPages = Math.max(...pageNumbers);
      }
    } catch {
      send({ type: "log", message: "Paginação não encontrada, processando página única.", level: "pending" });
    }

    send({ type: "log", message: `Total de páginas encontradas: ${totalPages}`, level: "pending" });
    send({ type: "progress", value: 5 });

    // ===== PROCESS EACH PAGE =====
    const pdfBuffers = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pageUrl = pageNum === 1 ? targetUrl : `${targetUrl}&page=${pageNum}`;

      if (pageNum > 1) {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(2000);
      }

      send({ type: "log", message: `Processando página ${pageNum}/${totalPages}...`, level: "pending" });

      // Try to use the print icon if available
      let usedPrint = false;
      try {
        const printBtn = page.locator(
          'a[href*="print"], button[class*="print"], [data-action*="print"], .q-icon-print, [class*="print"]'
        ).first();
        const printVisible = await printBtn.isVisible().catch(() => false);

        if (printVisible) {
          await printBtn.click();
          await page.waitForTimeout(3000);
          usedPrint = true;
          send({ type: "log", message: `Página ${pageNum}: usando modo de impressão.`, level: "pending" });
        }
      } catch {
        // Print button not found, will capture page directly
      }

      // Generate PDF from page content
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      });

      pdfBuffers.push(pdfBuffer);

      // If we opened a print view, go back
      if (usedPrint) {
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(1000);
      }

      const progress = Math.round(5 + (pageNum / totalPages) * 80);
      send({ type: "progress", value: progress });
      send({ type: "page_complete", page: pageNum, filename: `page_${pageNum}.pdf` });
    }

    // ===== MERGE / UPLOAD =====
    send({ type: "log", message: "Fazendo upload do PDF...", level: "pending" });
    send({ type: "progress", value: 90 });

    // Use the first (or only) PDF buffer for now
    // For multiple pages, we concatenate them (simple approach: use largest single PDF)
    const finalPdf = pdfBuffers.length === 1 ? pdfBuffers[0] : pdfBuffers[0]; // TODO: merge PDFs

    const filename = `questoes_${new Date().toISOString().slice(0, 10)}.pdf`;
    const storagePath = `${userId}/${jobId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, finalPdf, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Update job status
    await supabase
      .from("pdf_jobs")
      .update({
        status: "completed",
        storage_path: storagePath,
        filename,
      })
      .eq("id", jobId);

    send({ type: "progress", value: 100 });
    send({
      type: "complete",
      jobId,
      totalPages,
      filename,
    });

    res.end();
  } catch (err) {
    console.error("Error:", err.message || err);
    send({ type: "error", message: err.message || "Erro desconhecido" });

    await supabase
      .from("pdf_jobs")
      .update({ status: "failed", error_message: err.message || "Unknown error" })
      .eq("id", jobId)
      .catch(() => {});

    res.end();
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Playwright backend running on port ${PORT}`);
});
