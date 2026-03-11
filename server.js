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
    console.log("Browser launched.");
  }
  return browserInstance;
}

app.get("/health", async (_req, res) => {
  try {
    const browser = await getBrowser();
    res.json({ status: "ok", version: "5.1", browserConnected: browser.isConnected() });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

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

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let context = null;

  try {
    send("log", { message: "Iniciando geração de PDFs..." });

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
      if (["image", "font", "media"].includes(type)) {
        return route.abort();
      }
      const url = route.request().url();
      if (url.includes("analytics") || url.includes("gtag") || url.includes("facebook") || url.includes("hotjar")) {
        return route.abort();
      }
      return route.continue();
    });

    send("log", { message: "Navegador pronto." });

    // === LOGIN ===
    send("log", { message: "Fazendo login..." });
    await page.goto("https://www.qconcursos.com/conta/entrar", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Dismiss cookie banners
    try {
      const cookieBtn = page.locator(
        '.js-cookies-agreement button, [class*="cookie"] button, [id*="cookie"] button, button:has-text("Aceitar"), button:has-text("Concordo"), button:has-text("OK")'
      );
      await cookieBtn.first().click({ timeout: 3000 }).catch(() => {});
    } catch {}

    // Wait for login field
    await page.locator("#login_email").waitFor({ state: "visible", timeout: 60000 });

    await page.fill("#login_email", username, { timeout: 10000 });
    await page.fill("#login_password", password, { timeout: 10000 });
    await page.click("#btnLogin", { timeout: 10000 });

    // Wait for navigation after login
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Verify login success
    const currentUrl = page.url();
    if (currentUrl.includes("/conta/entrar")) {
      throw new Error("Login falhou - verifique suas credenciais");
    }

    send("log", { message: "Login OK!" });

    // === NAVIGATE TO TARGET ===
    send("log", { message: "Carregando página alvo..." });
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);

    send("log", { message: "Gerando PDF..." });

    // Unblock all resources for PDF rendering
    await page.unroute("**/*");
    await page.waitForTimeout(1000);

    // === GENERATE PDF (equivalent to Ctrl+P) ===
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    send("log", { message: `PDF gerado (${(pdfBuffer.length / 1024).toFixed(0)} KB). Enviando para storage...` });

    // === UPLOAD TO SUPABASE STORAGE ===
    const filename = `questoes_${new Date().toISOString().slice(0, 10)}_${Date.now()}.pdf`;
    const storagePath = `${userId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("pdf-reports")
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
        filename,
      })
      .eq("id", jobId);

    send("log", { message: "✅ PDF salvo com sucesso!" });
    send("complete", { storagePath, filename });
  } catch (err) {
    console.error("Generation error:", err.message);
    send("error", { message: err.message });

    await supabase
      .from("pdf_jobs")
      .update({ status: "failed", error_message: err.message })
      .eq("id", jobId)
      .catch(() => {});
  } finally {
    if (context) await context.close().catch(() => {});
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server v5.1 running on port ${PORT}`));
