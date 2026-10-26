import { expect, it } from 'vitest';
import { parsePageRange, pdfPages, renderPdf } from './document-text.js';
import { makePdf } from './test-pdf.js';

it('reads page ranges', () => {
  expect(parsePageRange('3', 10)).toEqual([3]);
  expect(parsePageRange('2-4', 10)).toEqual([2, 3, 4]);
  expect(parsePageRange('1,4-6, 9', 10)).toEqual([1, 4, 5, 6, 9]);
  expect(parsePageRange('8-20', 10)).toEqual([8, 9, 10]);
  expect(parsePageRange('99', 10)).toBeUndefined();
  expect(parsePageRange('first', 10)).toBeUndefined();
});

it('extracts the text of each page of a PDF', async () => {
  const pages = await pdfPages(new Uint8Array(makePdf(['Quarterly report', 'Revenue (net) grew', 'Appendix'])));
  expect(pages).toEqual(['Quarterly report', 'Revenue (net) grew', 'Appendix']);
});

it('marks pages, and offers the rest when the text is over the cap', () => {
  const pages = Array.from({ length: 12 }, (_value, index) => `page ${index + 1} ${'word '.repeat(200)}`);
  const text = renderPdf(pages, undefined, 3_000);
  expect(text).toContain('--- page 1 of 12 ---');
  expect(text).not.toContain('--- page 12 of 12 ---');
  expect(text).toMatch(/more pages: observe with pages: "\d+-\d+"/);
  const asked = renderPdf(pages, '11-12', 3_000);
  expect(asked).toContain('--- page 11 of 12 ---');
  expect(asked).toContain('--- page 12 of 12 ---');
  expect(asked).not.toContain('--- page 1 of 12 ---');
});

it('says so for a PDF without text', () => {
  expect(renderPdf(['', ''], undefined)).toContain('no text layer');
});
