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
  res.json({ status: "ok", version: "5.3", timestamp: new Date().toISOString() });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, username, password, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !username || !password || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendLog = (msg) => {
    res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);
  };

  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let context = null;

  try {
    sendLog("Iniciando geração de PDFs...");

    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Block heavy resources during navigation
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    sendLog("Navegador pronto.");
    sendLog("Fazendo login...");

    // Navigate to login page
    await page.goto("https://www.qconcursos.com/conta/entrar", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Dismiss cookie banners
    try {
      const cookieBtn = page.locator(
        'button:has-text("Aceitar"), button:has-text("OK"), button:has-text("Concordo"), [id*="cookie"] button, [class*="cookie"] button'
      );
      await cookieBtn.first().click({ timeout: 3000 });
    } catch (_) {
      // No cookie banner, continue
    }

    // Fill login form
    await page.waitForSelector("#login_email", { state: "visible", timeout: 60000 });
    await page.fill("#login_email", username);
    await page.fill("#login_password", password);

    // Click login and wait for navigation
    await Promise.all([
      page.waitForURL("**/usuario**", { timeout: 30000, waitUntil: "domcontentloaded" }),
      page.click("#btnLogin", { noWaitAfter: true }),
    ]);

    // Validate login success
    const currentUrl = page.url();
    if (currentUrl.includes("/conta/entrar")) {
      throw new Error("Login failed - still on login page. Check credentials.");
    }

    sendLog("Login OK!");
    sendLog("Carregando página alvo...");

    // Navigate to target URL
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for content to render
    await page.waitForTimeout(3000);

    sendLog("Gerando PDF...");

    // Unblock resources for PDF rendering
    await page.unroute("**/*");

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    const fileSizeKB = Math.round(pdfBuffer.length / 1024);
    sendLog(`PDF gerado (${fileSizeKB} KB). Enviando para storage...`);

    // Upload to Supabase Storage
    const storagePath = `${userId}/${jobId}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Update job record
    await supabase
      .from("pdf_jobs")
      .update({
        status: "done",
        storage_path: storagePath,
      })
      .eq("id", jobId);

    sendLog("Upload concluído! PDF disponível para download.");
    res.write(`data: ${JSON.stringify({ done: true, storagePath })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Error:", err.message);
    sendError(err.message || String(err));

    // Update job as failed
    try {
      await supabase
        .from("pdf_jobs")
        .update({ status: "failed", error_message: err.message || String(err) })
        .eq("id", jobId);
    } catch (_) {
      // Ignore update error
    }
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (v5.3)`);
});
