const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  return browserInstance;
}

app.get("/health", (_, res) => res.json({ status: "ok", version: "5.0" }));

app.post("/generate-pdf", async (req, res) => {
  const { jobId, username, password, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let context = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext();
    const page = await context.newPage();

    // Block heavy resources
    await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot}", (route) => route.abort());
    await page.route("**/{analytics,tracking,gtag,facebook,hotjar}**", (route) => route.abort());

    send({ type: "log", message: "Navegador pronto.", level: "pending" });

    // 1. Login
    send({ type: "log", message: "Fazendo login...", level: "pending" });
    send({ type: "progress", value: 10 });

    await page.goto("https://www.qconcursos.com/conta/entrar", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.fill("#login_email", username);
    await page.fill("#login_password", password);
    await page.click("#btnLogin");
    await page.waitForURL("**/*/", { timeout: 15000 }).catch(() => {});
    
    send({ type: "log", message: "Login OK!", level: "success" });
    send({ type: "progress", value: 25 });

    // 2. Navigate to target URL
    send({ type: "log", message: "Carregando questões...", level: "pending" });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Unblock images for print (re-enable for PDF quality)
    await page.unrouteAll();

    // Small wait for dynamic content
    await page.waitForTimeout(2000);

    send({ type: "log", message: "Gerando PDF...", level: "pending" });
    send({ type: "progress", value: 50 });

    // 3. Generate PDF directly — same as Ctrl+P
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    send({ type: "progress", value: 75 });

    // 4. Upload to Supabase Storage
    const filename = `questoes_${new Date().toISOString().slice(0, 10)}_${Date.now()}.pdf`;
    const storagePath = `${userId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf" });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    // 5. Update job record
    await supabase.from("pdf_jobs").update({
      status: "completed",
      storage_path: storagePath,
      filename,
    }).eq("id", jobId);

    send({ type: "progress", value: 100 });
    send({ type: "page_complete", page: 1, filename });
    send({ type: "complete", jobId, totalPages: 1 });

  } catch (err) {
    console.error("Error:", err.message);
    send({ type: "error", message: err.message });
    await supabase.from("pdf_jobs").update({
      status: "failed",
      error_message: err.message,
    }).eq("id", jobId);
  } finally {
    if (context) await context.close().catch(() => {});
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server v5.0 running on port ${PORT}`));
