// server.js v8.2 — Playwright PDF + Question Import Backend
const express = require("express");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERSION = "8.2.0";

// ── Health endpoints ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
});

// ── Shared helpers ──────────────────────────────────────────────
function isValidQcUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.includes("qconcursos.com") && url.searchParams.has("page");
  } catch {
    return false;
  }
}

function extractStartPage(url) {
  const match = url.match(/page=(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

function buildPageUrl(baseUrl, pageNum) {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(pageNum));
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Playwright launcher fix ─────────────────────────────────────
async function launchChromium() {
  const commonArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
  ];

  try {
    console.log("[playwright] trying launch with channel=chromium");
    return await chromium.launch({
      channel: "chromium",
      headless: true,
      args: commonArgs,
    });
  } catch (err) {
    console.error("[playwright] channel=chromium failed:", err.message);
  }

  try {
    const executablePath = chromium.executablePath();
    console.log("[playwright] fallback executablePath:", executablePath);

    return await chromium.launch({
      executablePath,
      headless: true,
      args: commonArgs,
    });
  } catch (err) {
    console.error("[playwright] executablePath fallback failed:", err.message);
    throw err;
  }
}

// ── PDF helpers ─────────────────────────────────────────────────
async function logProgress(supabase, jobId, message, level = "info", pageNumber = null) {
  try {
    await supabase.from("pdf_job_progress").insert({
      job_id: jobId,
      message,
      level,
      page_number: pageNumber,
    });
  } catch (err) {
    console.error("logProgress error:", err.message);
  }
}

async function updateJob(supabase, jobId, fields) {
  try {
    await supabase
      .from("pdf_jobs")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (err) {
    console.error("updateJob error:", err.message);
  }
}

// ── Import helpers ──────────────────────────────────────────────
async function logImportProgress(supabase, jobId, message, level = "info", pageNumber = null) {
  try {
    await supabase.from("import_job_progress").insert({
      job_id: jobId,
      message,
      level,
      page_number: pageNumber,
    });
  } catch (err) {
    console.error("logImportProgress error:", err.message);
  }
}

async function updateImportJob(supabase, jobId, fields) {
  try {
    await supabase
      .from("import_jobs")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (err) {
    console.error("updateImportJob error:", err.message);
  }
}

async function incrementImportJobCounters(supabase, jobId, counters = {}) {
  try {
    const { data: current, error } = await supabase
      .from("import_jobs")
      .select("processed_pages, imported_questions")
      .eq("id", jobId)
      .single();

    if (error) throw error;

    await supabase
      .from("import_jobs")
      .update({
        processed_pages: (current?.processed_pages || 0) + (counters.processed_pages || 0),
        imported_questions: (current?.imported_questions || 0) + (counters.imported_questions || 0),
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  } catch (err) {
    console.error("incrementImportJobCounters error:", err.message);
  }
}

// ── Shared page helpers ─────────────────────────────────────────
async function detectTotalPages(page) {
  try {
    const lastPageNum = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="page="]'));
      let maxPage = 0;

      for (const link of links) {
        const href = link.getAttribute("href") || link.href || "";
        const match = href.match(/page=(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxPage) maxPage = num;
        }
      }

      const paginationText = document.body?.innerText || "";
      const textMatch = paginationText.match(/(?:de|of)\s+(\d+)\s*(?:página|pagina|page)?/i);
      if (textMatch) {
        const num = parseInt(textMatch[1], 10);
        if (num > maxPage) maxPage = num;
      }

      return maxPage;
    });

    return lastPageNum > 0 ? lastPageNum : null;
  } catch {
    return null;
  }
}

async function pageHasQuestions(page) {
  try {
    const count = await page.evaluate(() => {
      const selectors = [
        ".q-question-item",
        ".q-question",
        '[class*="question-item"]',
        '[class*="QuestionItem"]',
        ".question-content",
        '[data-testid*="question"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return 0;
    });
    return count > 0;
  } catch {
    return false;
  }
}

async function waitForQuestions(page) {
  const selectors = [
    ".q-question-item",
    ".q-question",
    '[data-testid*="question"]',
    '[class*="question-item"]',
    '[class*="QuestionItem"]',
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 6000 });
      return sel;
    } catch {
      // tenta o próximo
    }
  }

  return null;
}

async function cleanPageBeforeExtraction(page) {
  try {
    await page.evaluate(() => {
      const removeSelectors = [
        "header",
        "footer",
        "nav",
        '[class*="cookie"]',
        '[id*="cookie"]',
        '[class*="banner"]',
        '[class*="popup"]',
        '[class*="modal"]',
        '[class*="ad-"]',
        ".q-header",
        ".q-footer",
      ];

      removeSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      });
    });
  } catch (err) {
    console.error("cleanPageBeforeExtraction error:", err.message);
  }
}

// ── PDF helper: generate PDF for a single page with retries ─────
async function generatePagePdf(page, url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(2000);

      await page.evaluate(() => {
        const removeSelectors = [
          "header", "footer", "nav",
          '[class*="ad-"]', '[class*="banner"]',
          '[class*="cookie"]', '[id*="cookie"]',
          '[class*="popup"]', '[class*="modal"]',
          ".q-header", ".q-footer",
        ];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        }
      });

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      });

      return pdfBuffer;
    } catch (err) {
      console.error(`Page PDF attempt ${attempt} failed for ${url}:`, err.message);
      if (attempt === retries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

// ── Import core extraction ──────────────────────────────────────
async function extractQuestionsFromPage(page, pageNumber, pageUrl) {
  return await page.evaluate(({ pageNumber, pageUrl }) => {
    function textOf(el) {
      return (el?.innerText || "").replace(/\s+/g, " ").trim();
    }

    function htmlOf(el) {
      return el?.innerHTML || "";
    }

    function findFirst(root, selectors) {
      for (const sel of selectors) {
        const found = root.querySelector(sel);
        if (found) return found;
      }
      return null;
    }

    function findAll(root, selectors) {
      for (const sel of selectors) {
        const found = root.querySelectorAll(sel);
        if (found && found.length > 0) return Array.from(found);
      }
      return [];
    }

    const blockSelectors = [
      ".q-question-item",
      ".q-question",
      '[data-testid*="question"]',
      '[class*="question-item"]',
      '[class*="QuestionItem"]',
    ];

    let blocks = [];
    for (const sel of blockSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        blocks = Array.from(found);
        break;
      }
    }

    const extracted = blocks.map((block, idx) => {
      const statementEl = findFirst(block, [
        ".q-question-enunciation",
        ".question-statement",
        ".q-question-body",
        ".q-question-content",
        '[class*="enunciation"]',
        '[class*="statement"]',
      ]);

      const explanationEl = findFirst(block, [
        ".q-comment",
        ".q-explanation",
        ".comment-body",
        '[class*="explanation"]',
        '[class*="comment"]',
      ]);

      const alternativeNodes = findAll(block, [
        ".q-option",
        ".q-question-alternative",
        ".alternative-item",
        "li",
      ]);

      const letters = ["A", "B", "C", "D", "E", "F", "G"];
      const alternatives = [];

      alternativeNodes.forEach((altEl, altIdx) => {
        const contentText = textOf(altEl);
        const contentHtml = htmlOf(altEl);

        if (!contentText) return;

        const ariaChecked = altEl.getAttribute("aria-checked");
        const className = altEl.className || "";
        const dataCorrect = altEl.getAttribute("data-correct");
        const title = altEl.getAttribute("title") || "";

        const isCorrect =
          className.includes("correct") ||
          className.includes("is-correct") ||
          className.includes("right-answer") ||
          dataCorrect === "true" ||
          ariaChecked === "true" ||
          /correta|certo|gabarito/i.test(title);

        alternatives.push({
          letter: letters[altIdx] || String(altIdx + 1),
          content_text: contentText,
          content_html: contentHtml,
          is_correct: isCorrect,
        });
      });

      const correctAlternative = alternatives.find((a) => a.is_correct);

      const externalQuestionId =
        block.getAttribute("data-question-id") ||
        block.getAttribute("data-id") ||
        block.id ||
        `page-${pageNumber}-idx-${idx + 1}`;

      return {
        external_question_id: externalQuestionId,
        statement_text: textOf(statementEl || block),
        statement_html: htmlOf(statementEl || block),
        explanation_text: textOf(explanationEl),
        explanation_html: htmlOf(explanationEl),
        correct_alternative_letter: correctAlternative?.letter || null,
        source_page: pageNumber,
        source_url: pageUrl,
        alternatives,
        raw_payload: {
          block_html: block.outerHTML,
        },
      };
    });

    return extracted.filter((q) => q.statement_text);
  }, { pageNumber, pageUrl });
}

async function saveQuestionBatch(supabase, userId, jobId, pageNumber, pageUrl, questions) {
  let insertedCount = 0;

  for (const question of questions) {
    try {
      const { data: existing, error: existingError } = await supabase
        .from("questions")
        .select("id")
        .eq("import_job_id", jobId)
        .eq("source_page", pageNumber)
        .eq("statement_text", question.statement_text)
        .limit(1);

      if (existingError) throw existingError;
      if (existing && existing.length > 0) continue;

      const { data: insertedQuestion, error: questionError } = await supabase
        .from("questions")
        .insert({
          user_id: userId,
          import_job_id: jobId,
          source_page: pageNumber,
          source_url: pageUrl,
          external_question_id: question.external_question_id,
          statement_html: question.statement_html,
          statement_text: question.statement_text,
          explanation_html: question.explanation_html,
          explanation_text: question.explanation_text,
          correct_alternative_letter: question.correct_alternative_letter,
          raw_payload: question.raw_payload,
        })
        .select("id")
        .single();

      if (questionError) throw questionError;

      const questionId = insertedQuestion.id;

      if (Array.isArray(question.alternatives) && question.alternatives.length > 0) {
        const rows = question.alternatives.map((alt) => ({
          question_id: questionId,
          letter: alt.letter,
          content_html: alt.content_html,
          content_text: alt.content_text,
          is_correct: !!alt.is_correct,
        }));

        const { error: altError } = await supabase
          .from("question_alternatives")
          .insert(rows);

        if (altError) throw altError;
      }

      insertedCount++;
    } catch (err) {
      console.error(`saveQuestionBatch item error p${pageNumber}:`, err.message);
    }
  }

  return insertedCount;
}

async function processImportPage(page, pageUrl, pageNumber, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await waitForQuestions(page);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);

      await cleanPageBeforeExtraction(page);

      const hasQuestions = await pageHasQuestions(page);
      if (!hasQuestions) {
        return { hasQuestions: false, questions: [] };
      }

      const questions = await extractQuestionsFromPage(page, pageNumber, pageUrl);

      return {
        hasQuestions: questions.length > 0,
        questions,
      };
    } catch (err) {
      console.error(`processImportPage attempt ${attempt} failed p${pageNumber}:`, err.message);
      if (attempt === retries) throw err;
      await sleep(1500 * attempt);
    }
  }
}

// ── Main: generate-pdf endpoint ─────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.json({ status: "accepted", jobId });

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let browser = null;
  let context = null;

  try {
    await updateJob(supabase, jobId, { status: "running" });
    await logProgress(supabase, jobId, "Iniciando processamento...", "info");

    browser = await launchChromium();

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const startPage = extractStartPage(targetUrl);
    const firstUrl = buildPageUrl(targetUrl, startPage);

    await logProgress(supabase, jobId, `Acessando página inicial (${startPage})...`, "info", startPage);
    await page.goto(firstUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);

    let totalPages = await detectTotalPages(page);
    if (totalPages) {
      await logProgress(supabase, jobId, `Total de páginas detectado: ${totalPages}`, "info");
      await updateJob(supabase, jobId, { total_pages: totalPages });
    } else {
      await logProgress(supabase, jobId, "Total de páginas não detectado. Usando modo incremental.", "info");
    }

    let currentPage = startPage;
    let consecutiveEmpty = 0;
    const MAX_PAGES = 500;
    const pdfPaths = [];
    const dateStr = new Date().toISOString().slice(0, 10);

    while (consecutiveEmpty < 2 && (currentPage - startPage) < MAX_PAGES) {
      if (totalPages && currentPage > totalPages) {
        await logProgress(supabase, jobId, `Todas as ${totalPages} páginas processadas.`, "success");
        break;
      }

      const pageUrl = buildPageUrl(targetUrl, currentPage);
      await logProgress(
        supabase,
        jobId,
        `Processando página ${currentPage}${totalPages ? ` de ${totalPages}` : ""}...`,
        "info",
        currentPage
      );
      await updateJob(supabase, jobId, { current_page: currentPage });

      try {
        const pdfBuffer = await generatePagePdf(page, pageUrl);

        await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(1500);
        const hasQuestions = await pageHasQuestions(page);

        if (!hasQuestions) {
          consecutiveEmpty++;
          await logProgress(
            supabase,
            jobId,
            `Página ${currentPage}: sem questões encontradas (${consecutiveEmpty}/2 vazias consecutivas).`,
            "info",
            currentPage
          );
          currentPage++;
          continue;
        }

        consecutiveEmpty = 0;

        const pagePath = `${userId}/questoes_p${currentPage}_${dateStr}.pdf`;
        const { error: uploadError } = await supabase.storage
          .from("pdfs")
          .upload(pagePath, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true,
          });

        if (uploadError) {
          await logProgress(
            supabase,
            jobId,
            `Erro ao salvar PDF da página ${currentPage}: ${uploadError.message}`,
            "error",
            currentPage
          );
        } else {
          pdfPaths.push(pagePath);
          await logProgress(supabase, jobId, `Página ${currentPage} salva com sucesso.`, "success", currentPage);
        }

        if (!totalPages) {
          const detected = await detectTotalPages(page);
          if (detected) {
            totalPages = detected;
            await updateJob(supabase, jobId, { total_pages: totalPages });
            await logProgress(supabase, jobId, `Total de páginas atualizado: ${totalPages}`, "info");
          }
        }
      } catch (err) {
        await logProgress(supabase, jobId, `Erro na página ${currentPage}: ${err.message}`, "error", currentPage);
        consecutiveEmpty++;
      }

      currentPage++;
    }

    const totalProcessed = pdfPaths.length;
    const lastPage = currentPage - 1;
    const finalFilename = `questoes_p${startPage}-p${lastPage}_${dateStr}.pdf`;
    const finalPath = pdfPaths.length > 0 ? pdfPaths[pdfPaths.length - 1] : null;

    await updateJob(supabase, jobId, {
      status: "completed",
      filename: finalFilename,
      storage_path: finalPath,
      current_page: lastPage,
      total_pages: totalPages || lastPage,
    });

    await logProgress(
      supabase,
      jobId,
      `Concluído! ${totalProcessed} páginas processadas (p${startPage} a p${lastPage}).`,
      "success"
    );
  } catch (err) {
    console.error("Job failed:", err);
    await updateJob(supabase, jobId, { status: "failed", error_message: err.message });
    await logProgress(supabase, jobId, `Falha no processamento: ${err.message}`, "error");
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

// ── Main: import-questions endpoint ─────────────────────────────
app.post("/import-questions", async (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!isValidQcUrl(targetUrl)) {
    return res.status(400).json({
      error: "Invalid targetUrl. Must be qconcursos.com and include page= parameter",
    });
  }

  res.json({ status: "accepted", jobId });

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let browser = null;
  let context = null;

  try {
    await updateImportJob(supabase, jobId, {
      status: "running",
      error_message: null,
    });

    await logImportProgress(supabase, jobId, "Iniciando importação de questões...", "info");

    browser = await launchChromium();

    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const startPage = extractStartPage(targetUrl);
    const firstUrl = buildPageUrl(targetUrl, startPage);

    await updateImportJob(supabase, jobId, {
      start_page: startPage,
      source_url: targetUrl,
    });

    await logImportProgress(
      supabase,
      jobId,
      `Acessando página inicial (${startPage})...`,
      "info",
      startPage
    );

    await page.goto(firstUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await waitForQuestions(page);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);

    let totalPages = await detectTotalPages(page);

    if (totalPages) {
      await updateImportJob(supabase, jobId, {
        detected_total_pages: totalPages,
      });

      await logImportProgress(
        supabase,
        jobId,
        `Total de páginas detectado: ${totalPages}`,
        "info"
      );
    } else {
      await logImportProgress(
        supabase,
        jobId,
        "Não foi possível detectar o total de páginas. Usando modo incremental.",
        "warning"
      );
    }

    let currentPage = startPage;
    let consecutiveEmpty = 0;
    const MAX_PAGES = 500;

    while ((currentPage - startPage) < MAX_PAGES) {
      if (totalPages && currentPage > totalPages) {
        await logImportProgress(
          supabase,
          jobId,
          `Todas as ${totalPages} páginas foram processadas.`,
          "success"
        );
        break;
      }

      const pageUrl = buildPageUrl(targetUrl, currentPage);

      await logImportProgress(
        supabase,
        jobId,
        `Processando página ${currentPage}${totalPages ? ` de ${totalPages}` : ""}...`,
        "info",
        currentPage
      );

      try {
        const result = await processImportPage(page, pageUrl, currentPage);

        if (!result.hasQuestions || result.questions.length === 0) {
          consecutiveEmpty++;

          await incrementImportJobCounters(supabase, jobId, {
            processed_pages: 1,
            imported_questions: 0,
          });

          await logImportProgress(
            supabase,
            jobId,
            `Página ${currentPage}: nenhuma questão encontrada (${consecutiveEmpty}/2 vazias consecutivas).`,
            "warning",
            currentPage
          );

          if (consecutiveEmpty >= 2) {
            await logImportProgress(
              supabase,
              jobId,
              "Encerrando por páginas vazias consecutivas.",
              "warning"
            );
            break;
          }

          currentPage++;
          continue;
        }

        consecutiveEmpty = 0;

        const insertedCount = await saveQuestionBatch(
          supabase,
          userId,
          jobId,
          currentPage,
          pageUrl,
          result.questions
        );

        await incrementImportJobCounters(supabase, jobId, {
          processed_pages: 1,
          imported_questions: insertedCount,
        });

        await logImportProgress(
          supabase,
          jobId,
          `Página ${currentPage}: ${insertedCount} questão(ões) salva(s) com sucesso.`,
          "success",
          currentPage
        );

        if (!totalPages) {
          const detected = await detectTotalPages(page);
          if (detected) {
            totalPages = detected;

            await updateImportJob(supabase, jobId, {
              detected_total_pages: totalPages,
            });

            await logImportProgress(
              supabase,
              jobId,
              `Total de páginas atualizado para ${totalPages}.`,
              "info"
            );
          }
        }
      } catch (err) {
        await incrementImportJobCounters(supabase, jobId, {
          processed_pages: 1,
          imported_questions: 0,
        });

        await logImportProgress(
          supabase,
          jobId,
          `Erro na página ${currentPage}: ${err.message}`,
          "error",
          currentPage
        );

        consecutiveEmpty++;
      }

      currentPage++;
      await sleep(800);
    }

    const { data: finalJob } = await supabase
      .from("import_jobs")
      .select("processed_pages, imported_questions")
      .eq("id", jobId)
      .single();

    await updateImportJob(supabase, jobId, {
      status: "completed",
      detected_total_pages: totalPages || null,
    });

    await logImportProgress(
      supabase,
      jobId,
      `Concluído! ${finalJob?.processed_pages || 0} página(s) processada(s) e ${finalJob?.imported_questions || 0} questão(ões) importada(s).`,
      "success"
    );
  } catch (err) {
    console.error("Import job failed:", err);

    await updateImportJob(supabase, jobId, {
      status: "failed",
      error_message: err.message,
    });

    await logImportProgress(
      supabase,
      jobId,
      `Falha no processamento: ${err.message}`,
      "error"
    );
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`PDF Generator Backend v${VERSION} running on port ${PORT}`);
});
