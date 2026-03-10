const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.post("/generate-pdf", async (req, res) => {
  const {
    jobId, username, password, targetUrl,
    supabaseUrl, supabaseServiceKey, userId,
  } = req.body;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let browser;
  try {
    send({ type: "log", message: "Iniciando navegador...", level: "pending" });
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Login
    send({ type: "log", message: "Acessando página de login...", level: "pending" });
    await page.goto("https://www.qconcursos.com/usuario/entrar", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Seletores flexíveis para o formulário de login
    await page.locator('input[type="email"], input[name*="login"], input[id*="login"]').first().fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

    // Check login success
    const loginFailed = await page.$('.flash-message--error, .alert-danger');
    if (loginFailed) {
      send({ type: "error", message: "Falha no login. Verifique suas credenciais." });
      await supabase.from("pdf_jobs").update({ status: "failed", error_message: "Login failed" }).eq("id", jobId);
      res.end();
      return;
    }
    send({ type: "log", message: "✓ Login realizado com sucesso!", level: "success" });

    // Navegar para a URL alvo (NÃO para a página de login!)
    send({ type: "log", message: "Navegando para a URL das questões...", level: "pending" });
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    let currentPage = 1;
    let totalPdfs = 0;

    while (true) {
      send({ type: "log", message: `Processando página ${currentPage}...`, level: "pending" });

      // Click the print/PDF icon
      const printButton = await page.$('a[href*="print"], .q-question-options a[title*="Imprimir"], a.print-link, [data-action="print"]');

      if (printButton) {
        // Open print version in new tab
        const [printPage] = await Promise.all([
          context.waitForEvent("page"),
          printButton.click(),
        ]).catch(async () => {
          const href = await printButton.getAttribute("href");
          if (href) {
            const printPageDirect = await context.newPage();
            const fullUrl = href.startsWith("http") ? href : `https://www.qconcursos.com${href}`;
            await printPageDirect.goto(fullUrl, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            });
            return [printPageDirect];
          }
          return [null];
        });

        if (printPage) {
          await printPage.waitForLoadState("domcontentloaded");

          const pdfBuffer = await printPage.pdf({
            format: "A4",
            printBackground: true,
            margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
          });

          const filename = `pagina_${currentPage}_${new Date().toISOString().slice(0, 10)}.pdf`;
          const storagePath = `${userId}/${jobId}/${filename}`;

          const { error: uploadError } = await supabase.storage
            .from("pdfs")
            .upload(storagePath, pdfBuffer, {
              contentType: "application/pdf",
              upsert: true,
            });

          if (uploadError) {
            send({ type: "log", message: `Erro ao salvar página ${currentPage}: ${uploadError.message}`, level: "error" });
          } else {
            totalPdfs++;
            send({ type: "page_complete", page: currentPage, filename });
          }

          await printPage.close();
        }
      } else {
        send({ type: "log", message: `Página ${currentPage}: ícone de impressão não encontrado, usando captura direta.`, level: "info" });

        const pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
        });

        const filename = `pagina_${currentPage}_${new Date().toISOString().slice(0, 10)}.pdf`;
        const storagePath = `${userId}/${jobId}/${filename}`;

        const { error: uploadError } = await supabase.storage
          .from("pdfs")
          .upload(storagePath, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true,
          });

        if (!uploadError) {
          totalPdfs++;
          send({ type: "page_complete", page: currentPage, filename });
        }
      }

      send({ type: "progress", value: Math.min(95, currentPage * 5) });

      // Check for next page
      const nextButton = await page.$('a[rel="next"], .pagination a:has-text("Próxima"), .pagination .next a');
      if (!nextButton) {
        send({ type: "log", message: "Última página alcançada.", level: "info" });
        break;
      }

      await nextButton.click();
      await page.waitForLoadState("domcontentloaded");
      currentPage++;
    }

    const storagePath = `${userId}/${jobId}/`;
    await supabase.from("pdf_jobs")
      .update({ status: "completed", storage_path: storagePath, filename: `${totalPdfs}_paginas.pdf` })
      .eq("id", jobId);

    send({ type: "progress", value: 100 });
    send({ type: "complete", jobId, totalPages: totalPdfs });

  } catch (err) {
    console.error("Error:", err);
    send({ type: "error", message: err.message || "Erro desconhecido" });
    await supabase.from("pdf_jobs")
      .update({ status: "failed", error_message: err.message })
      .eq("id", jobId);
  } finally {
    if (browser) await browser.close();
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
