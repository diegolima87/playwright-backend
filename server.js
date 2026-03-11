const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json()); 

// 🚀 Browser persistente — elimina ~3-5s de launch por request
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
    });
  }
  return browserInstance;
}

app.get("/health", (_, res) => res.json({ status: "ok", version: "4.0" }));

app.post("/generate-pdf", async (req, res) => {
  const { jobId, username, password, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let context = null;

  try {
    const browser = await getBrowser();
    send({ type: "log", message: "Navegador pronto.", level: "pending" });

    // Contexto isolado (mais leve que novo browser)
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });

    const page = await context.newPage();

    // Bloquear recursos desnecessários para acelerar
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,ico}", (route) => route.abort());
    await page.route("**/analytics**", (route) => route.abort());
    await page.route("**/google*/**", (route) => route.abort());

    // Login
    send({ type: "log", message: "Fazendo login...", level: "pending" });
    await page.goto("https://www.qconcursos.com/conta/entrar", { waitUntil: "domcontentloaded", timeout: 20000 });

    await page.fill("#login_email", username);
    await page.fill("#login_password", password);
    await page.click("#btnLogin");

    await page.waitForURL("**/questoes**", { timeout: 15000 }).catch(() => null);

    if (page.url().includes("/conta/entrar")) {
      throw new Error("Login falhou. Verifique suas credenciais.");
    }

    send({ type: "log", message: "Login OK!", level: "info" });
    send({ type: "progress", value: 10 });

    // Navegar para URL alvo
    send({ type: "log", message: "Carregando questões...", level: "pending" });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Detectar total de páginas
    const pageLinks = await page.locator('a[href*="page="]').all();
    const pageNumbers = [];
    for (const link of pageLinks) {
      const href = await link.getAttribute("href");
      const match = href?.match(/page=(\d+)/);
      if (match) pageNumbers.push(parseInt(match[1]));
    }
    const totalPages = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;

    send({ type: "log", message: `${totalPages} página(s) encontrada(s).`, level: "info" });

    for (let i = 1; i <= totalPages; i++) {
      const pageUrl = i === 1 ? targetUrl : `${targetUrl}&page=${i}`;

      if (i > 1) {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      }

      // Tentar botão de impressão, senão captura direto
      const printBtn = page.locator('[class*="print"], a[href*="print"], button:has-text("Imprimir")').first();
      const hasPrint = await printBtn.isVisible({ timeout: 3000 }).catch(() => false);

      let pdfBuffer;

      if (hasPrint) {
        await printBtn.click();
        await page.waitForTimeout(1500);
        pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
      } else {
        // Remover header/footer/nav para PDF limpo
        await page.evaluate(() => {
          document.querySelectorAll("header, footer, nav, .sidebar, [class*='banner'], [class*='cookie']")
            .forEach((el) => el.remove());
        });
        pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
      }

      const filename = `questoes_p${i}_${Date.now()}.pdf`;
      const storagePath = `${userId}/${jobId}/${filename}`;

      await supabase.storage.from("pdfs").upload(storagePath, pdfBuffer, { contentType: "application/pdf" });

      const progress = 10 + Math.round((i / totalPages) * 85);
      send({ type: "progress", value: progress });
      send({ type: "page_complete", page: i, filename });

      // Atualizar job com último path
      await supabase.from("pdf_jobs").update({ storage_path: storagePath, status: i === totalPages ? "completed" : "processing" }).eq("id", jobId);
    }

    send({ type: "progress", value: 100 });
    send({ type: "complete", jobId, totalPages });
  } catch (err) {
    console.error("Error:", err.message);
    send({ type: "error", message: err.message });
    await supabase.from("pdf_jobs").update({ status: "failed", error_message: err.message }).eq("id", jobId);
  } finally {
    if (context) await context.close();
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server v4.0 running on port ${PORT}`));
