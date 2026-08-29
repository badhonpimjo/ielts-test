import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Uploads a known audio fixture, waits for the transcript, and
 * asserts that the engine produced some output. The fixture is a
 * 3-second sine tone (see tests/fixtures/README.md), so we don't
 * assert specific keywords; we just confirm the pipeline ran
 * end-to-end without errors.
 */
test('upload fixture produces a transcript', async ({ page }) => {
  await page.goto('/');

  // Sanity: app shell rendered.
  await expect(page.locator('h1')).toHaveText(/Audio-to-Text POC/);

  // File picker is hidden; trigger it via the Upload button.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /upload audio file/i }).click(),
  ]);

  const fixture = path.resolve(__dirname, 'fixtures/sample-en.wav');
  await chooser.setFiles(fixture);

  // Wait until the audio is decoded and the Transcribe Audio button is enabled.
  const transcribeBtn = page.getByRole('button', { name: /transcribe audio/i });
  await expect(transcribeBtn).toBeEnabled({ timeout: 30_000 });

  // Trigger transcription explicitly.
  await transcribeBtn.click();

  // Status text changes through several phases; wait for the final one.
  const status = page.locator('#status');
  await expect(status).toHaveText(/Done: \d+ segments/, { timeout: 120_000 });

  // The pipeline ran successfully (status confirmed above). The sine-tone
  // fixture may yield zero or more silence segments, so just check that
  // the transcript container has rendered without error.
  const transcript = page.locator('#transcript');
  await expect(transcript).toBeVisible();
  const transcriptText = (await transcript.innerText()).trim();
  expect(transcriptText.length).toBeGreaterThan(0);
});
