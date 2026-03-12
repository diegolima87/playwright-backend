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
  res.json({ status: "ok", version: "6.2", timestamp: new Date().toISOString() });
});

app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await supabase.from("pdf_jobs").update({ status: "running" }).eq("id", jobId);

    send({ type: "log", message: "Iniciando navegador...", level: "pending" });
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    send({ type: "log", message: "Navegador pronto.", level: "info" });

    const urlObj = new URL(targetUrl);
    let currentPage = parseInt(urlObj.searchParams.get("page") || "1", 10);
    const startPage = currentPage;
    let totalGenerated = 0;

    while (true) {
      urlObj.searchParams.set("page", String(currentPage));
      const pageUrl = urlObj.toString();

      send({ type: "log", message: `Acessando página ${currentPage}...`, level: "pending" });

      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      if (totalGenerated === 0) {
        try {
          const cookieBtn = page.locator(
            'button:has-text("Aceitar"), button:has-text("OK"), .cookie-consent-accept'
          );
          await cookieBtn.first().click({ timeout: 3000 });
        } catch {
          // No cookie banner
        }
      }

      const hasQuestions = await page
        .locator(".q-question-enunciation, .question-body, .q-item, .q-question-item")
        .first()
        .isVisible({ timeout: 10000 })
        .catch(() => false);

      if (!hasQuestions) {
        send({ type: "log", message: `Página ${currentPage} sem questões. Finalizando.`, level: "info" });
        break;
      }

      try {
        await page.waitForSelector(
          ".q-question-enunciation, .question-body, .q-item, .q-question-item",
          { timeout: 15000 }
        );
        await page.waitForTimeout(1000);
      } catch {
        send({
          type: "log",
          message: `Aviso: conteúdo da página ${currentPage} pode estar incompleto.`,
          level: "info",
        });
      }

      send({ type: "log", message: `Gerando PDF da página ${currentPage}...`, level: "pending" });
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });

      const pageFilename = `questoes_p${currentPage}_${new Date().toISOString().slice(0, 10)}.pdf`;
      const storagePath = `${userId}/${jobId}/${pageFilename}`;

      const { error: uploadErr } = await supabase.storage
        .from("pdfs")
        .upload(storagePath, pdfBuffer, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (uploadErr) {
        send({
          type: "log",
          message: `Erro ao salvar página ${currentPage}: ${uploadErr.message}`,
          level: "error",
        });
      } else {
        send({ type: "page_complete", page: currentPage, filename: pageFilename });
      }

      totalGenerated++;
      currentPage++;
    }

    const lastPage = currentPage - 1;
    const finalFilename = totalGenerated === 1
      ? `questoes_p${startPage}_${new Date().toISOString().slice(0, 10)}.pdf`
      : `questoes_p${startPage}-p${lastPage}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const finalStoragePath = `${userId}/${jobId}/${finalFilename}`;

    await supabase
      .from("pdf_jobs")
      .update({
        status: "completed",
        filename: finalFilename,
        storage_path: finalStoragePath,
      })
      .eq("id", jobId);

    send({ type: "progress", value: 100 });
    send({ type: "complete", jobId, totalPages: totalGenerated });

    await context.close();
  } catch (err) {
    console.error("Generation error:", err);
    send({ type: "error", message: err.message || "Erro desconhecido" });
    await supabase
      .from("pdf_jobs")
      .update({
        status: "failed",
        error_message: err.message || String(err),
      })
      .eq("id", jobId);
  }

  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server v6.2 running on port ${PORT}`));
