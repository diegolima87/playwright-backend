const express = require('express');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const VERSION = '8.4.0';

// ─── Health ───
app.get('/health', (_req, res) => {
  const execPath = chromium.executablePath();
  const exists = fs.existsSync(execPath);
  res.json({
    ok: exists,
    version: VERSION,
    executablePath: execPath,
    executableExists: exists,
    browsersPathEnv: process.env.PLAYWRIGHT_BROWSERS_PATH || 'not set',
  });
});

// ─── Helper: log progress ───
async function logProgress(supabase, table, jobId, message, level = 'info', pageNumber = null) {
  try {
    await supabase.from(table).insert({
      job_id: jobId,
      message,
      level,
      page_number: pageNumber,
    });
  } catch (err) {
    console.error(`Failed to log progress: ${err.message}`);
  }
}

// ─── PDF Generation ───
async function processPdfJob(jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let browser = null;

  try {
    // Mark as running immediately
    await supabase.from('pdf_jobs').update({ status: 'running' }).eq('id', jobId);
    await logProgress(supabase, 'pdf_job_progress', jobId, 'Iniciando navegador...');

    browser = await chromium.launch({
      executablePath: chromium.executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await logProgress(supabase, 'pdf_job_progress', jobId, `Acessando ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Detect total pages from pagination
    let totalPages = 1;
    try {
      const lastPageLink = await page.$('a[aria-label="Last"]');
      if (lastPageLink) {
        const href = await lastPageLink.getAttribute('href');
        const match = href?.match(/page=(\d+)/);
        if (match) totalPages = parseInt(match[1], 10);
      }
    } catch (e) {
      console.log('Could not detect total pages, defaulting to 1');
    }

    await supabase.from('pdf_jobs').update({ total_pages: totalPages }).eq('id', jobId);
    await logProgress(supabase, 'pdf_job_progress', jobId, `Detectadas ${totalPages} páginas`);

    const pdfBuffers = [];
    const baseUrl = new URL(targetUrl);

    for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
      baseUrl.searchParams.set('page', String(currentPage));
      const pageUrl = baseUrl.toString();

      await logProgress(supabase, 'pdf_job_progress', jobId, `Processando página ${currentPage}/${totalPages}...`, 'info', currentPage);
      await supabase.from('pdf_jobs').update({ current_page: currentPage }).eq('id', jobId);

      if (currentPage > 1) {
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 60000 });
      }

      // Generate PDF via Ctrl+P / page.pdf()
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
      });

      pdfBuffers.push(pdfBuffer);
      await logProgress(supabase, 'pdf_job_progress', jobId, `Página ${currentPage}/${totalPages} concluída`, 'success', currentPage);
    }

    // Merge PDFs (simple concatenation for single-page, or use pdf-lib for multi)
    let finalPdf;
    if (pdfBuffers.length === 1) {
      finalPdf = pdfBuffers[0];
    } else {
      // Use pdf-lib to merge
      const { PDFDocument } = require('pdf-lib');
      const mergedPdf = await PDFDocument.create();
      for (const buffer of pdfBuffers) {
        const doc = await PDFDocument.load(buffer);
        const pages = await mergedPdf.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
      }
      finalPdf = Buffer.from(await mergedPdf.save());
    }

    // Upload to Supabase Storage
    const filename = `questoes_${new Date().toISOString().slice(0, 10)}_${jobId.slice(0, 8)}.pdf`;
    const storagePath = `${userId}/${filename}`;

    await logProgress(supabase, 'pdf_job_progress', jobId, 'Fazendo upload do PDF...');

    const { error: uploadError } = await supabase.storage
      .from('pdfs')
      .upload(storagePath, finalPdf, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Mark as completed
    await supabase.from('pdf_jobs').update({
      status: 'completed',
      storage_path: storagePath,
      filename,
    }).eq('id', jobId);

    await logProgress(supabase, 'pdf_job_progress', jobId, 'PDF gerado com sucesso!', 'success');

  } catch (err) {
    console.error(`PDF job ${jobId} failed:`, err.message);
    await supabase.from('pdf_jobs').update({
      status: 'failed',
      error_message: err.message,
    }).eq('id', jobId);
    await logProgress(supabase, 'pdf_job_progress', jobId, err.message, 'error');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Import Questions ───
async function processImportJob(jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let browser = null;

  try {
    await supabase.from('import_jobs').update({ status: 'running' }).eq('id', jobId);
    await logProgress(supabase, 'import_job_progress', jobId, 'Iniciando navegador...');

    browser = await chromium.launch({
      executablePath: chromium.executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await logProgress(supabase, 'import_job_progress', jobId, `Acessando ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Detect total pages
    let totalPages = 1;
    try {
      const lastPageLink = await page.$('a[aria-label="Last"]');
      if (lastPageLink) {
        const href = await lastPageLink.getAttribute('href');
        const match = href?.match(/page=(\d+)/);
        if (match) totalPages = parseInt(match[1], 10);
      }
    } catch (e) {
      console.log('Could not detect total pages for import, defaulting to 1');
    }

    const baseUrl = new URL(targetUrl);
    const startPage = parseInt(baseUrl.searchParams.get('page') || '1', 10);

    await supabase.from('import_jobs').update({
      detected_total_pages: totalPages,
      start_page: startPage,
    }).eq('id', jobId);

    await logProgress(supabase, 'import_job_progress', jobId, `Detectadas ${totalPages} páginas a partir da página ${startPage}`);

    let totalQuestions = 0;

    for (let currentPage = startPage; currentPage <= totalPages; currentPage++) {
      baseUrl.searchParams.set('page', String(currentPage));
      const pageUrl = baseUrl.toString();

      await logProgress(supabase, 'import_job_progress', jobId, `Processando página ${currentPage}/${totalPages}...`, 'info', currentPage);

      if (currentPage > startPage) {
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 60000 });
      }

      // Extract questions from the page
      const questions = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.q-question-item, [data-question-id]').forEach((el) => {
          const questionId = el.getAttribute('data-question-id') || '';
          const statement = el.querySelector('.q-question-enunciation, .question-statement');
          const statementHtml = statement?.innerHTML || '';
          const statementText = statement?.textContent?.trim() || '';
          const institution = el.querySelector('.q-question-info .institution, .question-info')?.textContent?.trim() || '';
          
          const alternatives = [];
          el.querySelectorAll('.q-option-item, .alternative-item').forEach((alt) => {
            const letter = alt.querySelector('.q-option-letter, .alternative-letter')?.textContent?.trim() || '';
            const contentEl = alt.querySelector('.q-option-item-text, .alternative-text');
            alternatives.push({
              letter,
              content_html: contentEl?.innerHTML || '',
              content_text: contentEl?.textContent?.trim() || '',
            });
          });

          const correctEl = el.querySelector('.q-question-correct-answer, [data-correct-alternative]');
          const correctAlternative = correctEl?.getAttribute('data-correct-alternative') || 
                                     correctEl?.textContent?.trim() || '';

          const explanationEl = el.querySelector('.q-question-explanation, .question-explanation');

          items.push({
            external_question_id: questionId,
            statement_html: statementHtml,
            statement_text: statementText,
            institution,
            correct_alternative: correctAlternative,
            explanation_html: explanationEl?.innerHTML || '',
            explanation_text: explanationEl?.textContent?.trim() || '',
            alternatives,
          });
        });
        return items;
      });

      // Insert questions into database
      for (const q of questions) {
        // Check for duplicates
        if (q.external_question_id) {
          const { data: existing } = await supabase
            .from('questions')
            .select('id')
            .eq('external_question_id', q.external_question_id)
            .eq('import_job_id', jobId)
            .maybeSingle();

          if (existing) continue;
        }

        const { data: insertedQuestion, error: qError } = await supabase
          .from('questions')
          .insert({
            user_id: userId,
            import_job_id: jobId,
            external_question_id: q.external_question_id || null,
            statement_html: q.statement_html,
            statement_text: q.statement_text,
            institution: q.institution || null,
            correct_alternative: q.correct_alternative || null,
            explanation_html: q.explanation_html || null,
            explanation_text: q.explanation_text || null,
            source_url: pageUrl,
            source_page: currentPage,
          })
          .select('id')
          .single();

        if (qError) {
          console.error('Question insert error:', qError.message);
          continue;
        }

        // Insert alternatives
        if (q.alternatives.length > 0 && insertedQuestion) {
          const alts = q.alternatives.map((alt) => ({
            question_id: insertedQuestion.id,
            letter: alt.letter,
            content_html: alt.content_html,
            content_text: alt.content_text,
            is_correct: alt.letter === q.correct_alternative,
          }));

          const { error: altError } = await supabase
            .from('question_alternatives')
            .insert(alts);

          if (altError) {
            console.error('Alternatives insert error:', altError.message);
          }
        }

        totalQuestions++;
      }

      await supabase.from('import_jobs').update({
        processed_pages: currentPage - startPage + 1,
        total_questions: totalQuestions,
      }).eq('id', jobId);

      await logProgress(supabase, 'import_job_progress', jobId, `Página ${currentPage} concluída — ${questions.length} questões extraídas`, 'success', currentPage);
    }

    // Mark as completed
    await supabase.from('import_jobs').update({
      status: 'completed',
      total_questions: totalQuestions,
    }).eq('id', jobId);

    await logProgress(supabase, 'import_job_progress', jobId, `Importação concluída! ${totalQuestions} questões importadas.`, 'success');

  } catch (err) {
    console.error(`Import job ${jobId} failed:`, err.message);
    await supabase.from('import_jobs').update({
      status: 'failed',
      error_message: err.message,
    }).eq('id', jobId);
    await logProgress(supabase, 'import_job_progress', jobId, err.message, 'error');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Endpoints (respond immediately, process in background) ───
app.post('/generate-pdf', (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Respond immediately — Edge Function is waiting
  res.status(202).json({ accepted: true, jobId });

  // Process in background
  processPdfJob(jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId)
    .catch((err) => console.error('PDF job failed:', err.message));
});

app.post('/import-questions', (req, res) => {
  const { jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId } = req.body;

  if (!jobId || !targetUrl || !supabaseUrl || !supabaseServiceKey || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Respond immediately — Edge Function is waiting
  res.status(202).json({ accepted: true, jobId });

  // Process in background
  processImportJob(jobId, targetUrl, supabaseUrl, supabaseServiceKey, userId)
    .catch((err) => console.error('Import job failed:', err.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend v${VERSION} on port ${PORT}`));
